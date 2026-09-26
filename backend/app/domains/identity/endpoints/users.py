"""The signed in user's own profile, which the frontend's auth shell loads on boot.

The shared identity package issues tokens but never renders this product's
`users` row, so the one route that does lives here, in the domain whose hooks
own that table.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.common.api.dependencies.authz import caller_subject
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.inbox import NOTIFICATION_KINDS, NotificationKind

router = APIRouter()

NO_SUCH_USER = {"error_code": "NOT_FOUND", "message": "Resource not found"}


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
    subject: str = Depends(caller_subject),
    repos: Repositories = Depends(get_repositories),
) -> UserRead:
    """The account behind the presented token.

    A verified token whose row is gone reads as 404 rather than 401, so the
    frontend keeps the session and shows its unavailable state instead of
    bouncing to login.
    """
    user = repos.users.get(subject)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NO_SUCH_USER)
    return _as_read(user)


@router.patch("/me/preferences", response_model=UserRead)
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
