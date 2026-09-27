"""The signed in user's own profile, which the frontend's auth shell loads on boot.

The shared identity package issues tokens but never renders this product's
`users` row, so the one route that does lives here, in the domain whose hooks
own that table.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.common.account_deletion import AccountDeletionPlan, WorkspaceSummary, plan_account_deletion
from app.common.api.dependencies.authz import auth_strength_of, caller_person, caller_subject, require_person
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.inbox import NOTIFICATION_KINDS, NotificationKind
from app.common.email import deliver
from app.domains.identity.email import render_account_deletion

_log = logging.getLogger(__name__)

router = APIRouter()

NO_SUCH_USER = {"error_code": "NOT_FOUND", "message": "Resource not found"}

EMAIL_MISMATCH = {"error_code": "CONFIRMATION_MISMATCH", "message": "Type your email address exactly to confirm"}

ACCOUNT_PURGING = {"error_code": "CONFLICT", "message": "This account is already being deleted"}


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
    deletion_scheduled_at: Optional[datetime] = None
    purge_after: Optional[datetime] = None


class WorkspaceSummaryRead(BaseModel):
    """One workspace as the account deletion plan names it."""

    id: str
    name: str
    slug: str


class AccountDeletionPlanRead(BaseModel):
    """What deleting the caller's account would do to each workspace they are in.

    `blocking` workspaces stop the deletion: the caller is their only owner and
    other people are in them, so ownership has to move or the workspace has to be
    deleted first. `deleted_with_account` have no other members. `leaving` keep
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

    Both fields are optional, so the global email switch and one kind's channels
    can each be changed without restating the other. Deliberately not a settings
    domain of its own: a few values on the row the product already owns are cheaper
    than a table and a second read on every notification.
    """

    email_notifications: Optional[bool] = None
    notification_preferences: Optional[dict[NotificationKind, NotificationChannelsUpdate]] = None


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
        deletion_scheduled_at=user.deletion_scheduled_at,
        purge_after=user.purge_after,
    )


def _summaries(rows: list[WorkspaceSummary]) -> list[WorkspaceSummaryRead]:
    """The plan's workspaces in the response shape."""
    return [WorkspaceSummaryRead(id=row.id, name=row.name, slug=row.slug) for row in rows]


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
    subject: str = Depends(caller_person),
    repos: Repositories = Depends(get_repositories),
) -> UserRead:
    """The account behind the presented token or personal API key.

    A personal key answers the person who minted it, which is how a command line
    client learns who `me` is. A workspace key has no person and is a 403. A
    verified token whose row is gone reads as 404 rather than 401, so the
    frontend keeps the session and shows its unavailable state instead of
    bouncing to login.
    """
    user = repos.users.get(subject)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NO_SUCH_USER)
    return _as_read(user)


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
    user = repos.users.get(subject)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NO_SUCH_USER)
    changes: dict[str, Any] = {}
    if payload.email_notifications is not None:
        changes["email_notifications"] = payload.email_notifications
    if payload.notification_preferences:
        changes["notification_preferences"] = _merged_preferences(
            user.notification_preferences, dict(payload.notification_preferences)
        )
    if not changes:
        return _as_read(user)
    return _as_read(repos.users.update(subject, **changes))


@router.get("/me/deletion-plan", response_model=AccountDeletionPlanRead, dependencies=[Depends(require_person)])
def read_account_deletion_plan(
    subject: str = Depends(caller_subject),
    repos: Repositories = Depends(get_repositories),
) -> AccountDeletionPlanRead:
    """What deleting the caller's account would do, shown before they confirm it."""
    return _plan_read(plan_account_deletion(repos, subject))


@router.post("/me/deletion", response_model=UserRead, dependencies=[Depends(require_person)])
def schedule_account_deletion(
    payload: AccountDeletionRequest,
    request: Request,
    subject: str = Depends(caller_subject),
    repos: Repositories = Depends(get_repositories),
) -> UserRead:
    """Schedule the caller's account for permanent deletion after the grace period.

    A signed in person only, with their address typed out again, and refused with a
    409 naming each workspace where they are the only owner and other people remain.
    Repeating it keeps the first date. The account's own address is mailed, and the
    request is logged with how the caller last authenticated.
    """
    user = repos.users.get(subject)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NO_SUCH_USER)
    if user.is_purging:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ACCOUNT_PURGING)
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
    already = user.purge_after is not None
    scheduled = repos.users.schedule_deletion(subject)
    if scheduled is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ACCOUNT_PURGING)
    _log.info(
        "An account deletion was scheduled.",
        extra={
            "event": "account.deletion.scheduled",
            "user_id": subject,
            "purge_after": scheduled.purge_after.isoformat() if scheduled.purge_after else None,
            "workspaces_deleted": len(plan.sole_member),
            "workspaces_left": len(plan.leaving),
            "repeat": already,
            **auth_strength_of(request).as_log(),
        },
    )
    if not already:
        deliver(
            render_account_deletion(
                to=str(scheduled.email),
                purge_after=scheduled.purge_after,
                workspaces_deleted=[row.name for row in plan.sole_member],
            ),
            event="identity.account_deletion.email",
        )
    return _as_read(scheduled)


@router.delete("/me/deletion", response_model=UserRead, dependencies=[Depends(require_person)])
def cancel_account_deletion(
    request: Request,
    subject: str = Depends(caller_subject),
    repos: Repositories = Depends(get_repositories),
) -> UserRead:
    """Cancel the caller's scheduled account deletion. Idempotent when none is scheduled."""
    user = repos.users.get(subject)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NO_SUCH_USER)
    cancelled = repos.users.cancel_deletion(subject)
    if cancelled is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ACCOUNT_PURGING)
    if user.purge_after is not None:
        _log.info(
            "An account deletion was cancelled.",
            extra={"event": "account.deletion.cancelled", "user_id": subject, **auth_strength_of(request).as_log()},
        )
        deliver(
            render_account_deletion(to=str(cancelled.email), purge_after=None, workspaces_deleted=[], cancelled=True),
            event="identity.account_deletion.email",
        )
    return _as_read(cancelled)
