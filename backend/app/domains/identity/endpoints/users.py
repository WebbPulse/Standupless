"""The signed in user's own profile, which the frontend's auth shell loads on boot.

The shared identity package issues tokens but never renders this product's
`users` row, so the one route that does lives here, in the domain whose hooks
own that table.
"""

from __future__ import annotations

import logging
from typing import Any, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field, field_validator
from webbpulse.identity.claims import identity_claims

from app.common import team_purge
from app.common.account_deletion import AccountDeletionPlan, WorkspaceSummary, plan_account_deletion
from app.common.api.dependencies.authz import (
    auth_strength_of,
    caller_person,
    caller_subject,
    has_two_factor,
    require_person,
)
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.inbox import NOTIFICATION_KINDS, NotificationKind
from app.common.db.dynamo.users import User
from app.common.email import deliver
from app.common.icons import (
    IconCommit,
    IconUploadCreate,
    IconUploadRead,
    delete_icon_objects,
    icon_url,
    presign_icon,
    user_owner,
    verify_upload,
)
from app.domains.identity.account_revocation import revoke_account_access
from app.domains.identity.email import render_account_deletion

_log = logging.getLogger(__name__)

router = APIRouter()

NO_SUCH_USER = {"error_code": "NOT_FOUND", "message": "Resource not found"}

EMAIL_MISMATCH = {"error_code": "CONFIRMATION_MISMATCH", "message": "Type your email address exactly to confirm"}

ACCOUNT_DELETED = {"error_code": "ACCOUNT_DELETED", "message": "This account has been deleted"}


class NotificationChannels(BaseModel):
    """Where one kind of notification is delivered: the inbox and email."""

    in_app: bool
    email: bool


class UserRead(BaseModel):
    """The caller's own account, in the shape the frontend's `UserRead` expects."""

    id: str
    email: str
    display_name: str
    email_verified: bool
    email_notifications: bool
    notification_preferences: dict[str, NotificationChannels]
    avatar_url: Optional[str] = None
    two_factor: bool = False
    timezone: Optional[str] = None


class WorkspaceSummaryRead(BaseModel):
    """One workspace as the account deletion plan names it."""

    id: str
    name: str
    slug: str
    deletion_scheduled: bool = False


class AccountDeletionPlanRead(BaseModel):
    """What deleting the caller's account would do to each workspace they are in.

    `blocking` workspaces stop the deletion: the caller is their only owner and
    other people are in them, so ownership has to move or the workspace has to be
    deleted first. One already scheduled for deletion carries `deletion_scheduled`
    and stops blocking once its own purge starts. `deleted_with_account` have no other members. `leaving` keep
    going without the caller.
    """

    blocking: list[WorkspaceSummaryRead]
    deleted_with_account: list[WorkspaceSummaryRead]
    leaving: list[WorkspaceSummaryRead]


class AccountDeletionRequest(BaseModel):
    """The body `POST /api/users/me/deletion` takes: the account's address typed out again."""

    confirm_email: str = Field(min_length=3, max_length=320)


class NotificationChannelsUpdate(BaseModel):
    """A partial change to one kind's channels; an omitted channel keeps its value."""

    in_app: Optional[bool] = None
    email: Optional[bool] = None


class UserPreferencesUpdate(BaseModel):
    """The preferences a person may change on their own account.

    Every field is optional, so the global email switch, one kind's channels and
    the timezone can each be changed without restating the others. `timezone` is
    the IANA zone due date reminders are judged in, which the browser captures on
    sign in and the person can change. Deliberately not a settings
    domain of its own: a few values on the row the product already owns are cheaper
    than a table and a second read on every notification.
    """

    email_notifications: Optional[bool] = None
    notification_preferences: Optional[dict[NotificationKind, NotificationChannelsUpdate]] = None
    timezone: Optional[str] = Field(default=None, min_length=1, max_length=64)

    @field_validator("timezone")
    @classmethod
    def _known_zone(cls, value: Optional[str]) -> Optional[str]:
        """Refuse a name the zone database does not know."""
        if value is None:
            return None
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"{value!r} is not a known IANA timezone") from exc
        return value


def _as_read(user: "Any") -> UserRead:
    """One stored user row in the response shape."""
    return UserRead(
        id=user.id,
        email=str(user.email),
        display_name=user.display_name,
        email_verified=user.email_verified,
        email_notifications=user.email_notifications,
        notification_preferences={
            kind: NotificationChannels(
                in_app=bool(user.notification_preferences.get(kind, {}).get("in_app", True)),
                email=bool(user.notification_preferences.get(kind, {}).get("email", True)),
            )
            for kind in NOTIFICATION_KINDS
        },
        avatar_url=icon_url(user.icon_key),
        timezone=user.timezone,
    )


def _summaries(rows: list[WorkspaceSummary]) -> list[WorkspaceSummaryRead]:
    """The plan's workspaces in the response shape."""
    return [
        WorkspaceSummaryRead(id=row.id, name=row.name, slug=row.slug, deletion_scheduled=row.deletion_scheduled)
        for row in rows
    ]


def _live_user(repos: Repositories, subject: str) -> User:
    """The caller's row, a 404 when it is gone, or a 401 once the account has been deleted.

    A deleted account is refused as unauthenticated, so a token issued before the
    deletion stops working at once rather than when it expires.
    """
    user = repos.users.get(subject)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NO_SUCH_USER)
    if user.is_deleted:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=ACCOUNT_DELETED)
    return user


def _plan_read(plan: AccountDeletionPlan) -> AccountDeletionPlanRead:
    """The plan in the response shape."""
    return AccountDeletionPlanRead(
        blocking=_summaries(plan.blocking),
        deleted_with_account=_summaries(plan.sole_member),
        leaving=_summaries(plan.leaving),
    )


def _merged_preferences(stored: dict[str, dict[str, bool]], changes: dict[Any, NotificationChannelsUpdate]) -> dict:
    """The stored per kind switches with a partial change applied, kept sparse.

    Only a switch that is off is kept, so the row stays small and a channel added
    later defaults to on for everyone who never touched it.
    """
    merged = {kind: dict(channels) for kind, channels in stored.items()}
    for kind, update in changes.items():
        channels = merged.setdefault(str(kind), {})
        for channel, value in update.model_dump(exclude_none=True).items():
            if value:
                channels.pop(channel, None)
            else:
                channels[channel] = False
    return {kind: channels for kind, channels in merged.items() if channels}


@router.get("/me", response_model=UserRead)
def read_current_user(
    request: Request,
    subject: str = Depends(caller_person),
    repos: Repositories = Depends(get_repositories),
) -> UserRead:
    """The account behind the presented token or personal API key.

    A personal key answers the person who minted it, which is how a command line
    client learns who `me` is. A workspace key has no person and is a 403. A
    verified token whose row is gone reads as 404 rather than 401, so the
    frontend keeps the session and shows its unavailable state instead of
    bouncing to login. A deleted account whose row the purge has not removed yet
    is a 401.

    `two_factor` repeats the session's own claim, so the account page and a
    workspace's authentication policy agree on whether this session has a second
    factor. A personal key carries no session claims and reads false.
    """
    read = _as_read(_live_user(repos, subject))
    read.two_factor = has_two_factor(identity_claims(request))
    return read


@router.patch("/me/preferences", response_model=UserRead, dependencies=[Depends(require_person)])
def update_current_user_preferences(
    payload: UserPreferencesUpdate,
    subject: str = Depends(caller_subject),
    repos: Repositories = Depends(get_repositories),
) -> UserRead:
    """Change the caller's own preferences.

    Separate from the identity package's own profile routes, which own the address
    and the credentials; this owns the product fields on the same row, which is the
    only part of it Standupless gets to define.
    """
    user = _live_user(repos, subject)
    changes: dict[str, Any] = {}
    if payload.email_notifications is not None:
        changes["email_notifications"] = payload.email_notifications
    if payload.notification_preferences:
        changes["notification_preferences"] = _merged_preferences(
            user.notification_preferences, dict(payload.notification_preferences)
        )
    if payload.timezone is not None and payload.timezone != user.timezone:
        changes["timezone"] = payload.timezone
    if not changes:
        return _as_read(user)
    return _as_read(repos.users.update(subject, **changes))


@router.post(
    "/me/avatar/uploads",
    response_model=IconUploadRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_person)],
)
def create_avatar_upload(
    payload: IconUploadCreate,
    subject: str = Depends(caller_subject),
    repos: Repositories = Depends(get_repositories),
) -> IconUploadRead:
    """Sign a PUT for a new avatar image, which the commit call then makes current."""
    _live_user(repos, subject)
    return presign_icon(user_owner(subject), payload)


@router.put("/me/avatar", response_model=UserRead, dependencies=[Depends(require_person)])
def set_avatar(
    payload: IconCommit,
    subject: str = Depends(caller_subject),
    repos: Repositories = Depends(get_repositories),
) -> UserRead:
    """Make an uploaded image the caller's avatar and delete the one it replaces."""
    _live_user(repos, subject)
    owner = user_owner(subject)
    key = verify_upload(owner, payload.upload_id)
    user = repos.users.update(subject, icon_key=key)
    delete_icon_objects(owner.prefix, keep=key)
    return _as_read(user)


@router.delete("/me/avatar", response_model=UserRead, dependencies=[Depends(require_person)])
def clear_avatar(
    subject: str = Depends(caller_subject),
    repos: Repositories = Depends(get_repositories),
) -> UserRead:
    """Remove the caller's avatar, falling back to their initials, and delete the image."""
    user = _live_user(repos, subject)
    if user.icon_key is not None:
        user = repos.users.update(subject, icon_key=None)
    delete_icon_objects(user_owner(subject).prefix)
    return _as_read(user)


@router.get("/me/deletion-plan", response_model=AccountDeletionPlanRead, dependencies=[Depends(require_person)])
def read_account_deletion_plan(
    subject: str = Depends(caller_subject),
    repos: Repositories = Depends(get_repositories),
) -> AccountDeletionPlanRead:
    """What deleting the caller's account would do, shown before they confirm it."""
    _live_user(repos, subject)
    return _plan_read(plan_account_deletion(repos, subject))


@router.post("/me/deletion", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(require_person)])
def delete_account(
    payload: AccountDeletionRequest,
    request: Request,
    subject: str = Depends(caller_subject),
    repos: Repositories = Depends(get_repositories),
) -> Response:
    """Delete the caller's account now.

    A signed in person only, with their address typed out again, and refused with a
    409 naming each workspace where they are the only owner and other people remain.
    Once it passes, the account is marked deleted, so no sign in method or refresh
    works for it any more, then every session, OAuth grant and personal API key is
    revoked and the purge of its data is started at once. The hourly sweep and the
    queue's retries start any purge this request could not. The account's own
    address is mailed, and the request is logged with how the caller last
    authenticated. Repeating it for an account already deleted starts the purge again.
    """
    user = repos.users.get(subject)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NO_SUCH_USER)
    if user.is_deleted:
        _request_purge(subject)
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    if payload.confirm_email.strip().lower() != str(user.email).strip().lower():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=EMAIL_MISMATCH)
    plan = plan_account_deletion(repos, subject)
    if plan.blocking:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error_code": "SOLE_OWNER",
                "message": "Transfer ownership of these workspaces or delete them first",
                "details": {"workspaces": [row.model_dump() for row in _summaries(plan.blocking)]},
            },
        )
    deleted = repos.users.mark_deleted(subject)
    if deleted is None:
        _request_purge(subject)
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    revocation = revoke_account_access(repos, subject)
    purge_requested = _request_purge(subject)
    _log.info(
        "An account was deleted.",
        extra={
            "event": "account.deleted",
            "user_id": subject,
            "workspaces_deleted": len(plan.sole_member),
            "workspaces_left": len(plan.leaving),
            "refresh_records_revoked": revocation.refresh_records,
            "connected_apps_revoked": revocation.connected_apps,
            "api_keys_deleted": revocation.api_keys,
            "revoke_failed": list(revocation.failed),
            "purge_requested": purge_requested,
            **auth_strength_of(request).as_log(),
        },
    )
    deliver(
        render_account_deletion(to=str(deleted.email), workspaces_deleted=[row.name for row in plan.sole_member]),
        event="identity.account_deletion.email",
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _request_purge(user_id: str) -> bool:
    """Ask for the account's purge now, reporting whether the request went out.

    A failed send is logged rather than raised: the account is already deleted and
    signed out everywhere, and the hourly sweep starts the purge it missed.
    """
    try:
        return team_purge.request_account_purge(user_id)
    except Exception:
        _log.exception(
            "An account purge could not be requested, so the hourly sweep will start it.",
            extra={"event": "account.purge.request_failed", "user_id": user_id},
        )
        return False
