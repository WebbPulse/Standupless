"""The signed in user's own profile, which the frontend's auth shell loads on boot.

The shared identity package issues tokens but never renders this product's
`users` row, so the one route that does lives here, in the domain whose hooks
own that table.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.common.api.dependencies.authz import caller_subject
from app.common.api.dependencies.repositories import Repositories, get_repositories

router = APIRouter()

NO_SUCH_USER = {"error_code": "NOT_FOUND", "message": "Resource not found"}


class UserRead(BaseModel):
    """The caller's own account, in the shape the frontend's `UserRead` expects."""

    id: str
    email: str
    display_name: str
    email_verified: bool
    email_notifications: bool


class UserPreferencesUpdate(BaseModel):
    """The preferences a person may change on their own account.

    Only the notification switch for now. Deliberately not a settings domain of its
    own: one boolean on the row the product already owns is cheaper than a table
    and a second read on every notification.
    """

    email_notifications: bool


def _as_read(user: "Any") -> UserRead:
    """One stored user row in the response shape."""
    return UserRead(
        id=user.id,
        email=str(user.email),
        display_name=user.display_name,
        email_verified=user.email_verified,
        email_notifications=user.email_notifications,
    )


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
    if repos.users.get(subject) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NO_SUCH_USER)
    return _as_read(repos.users.update(subject, email_notifications=payload.email_notifications))
