"""The signed in user's own profile, which the frontend's auth shell loads on boot.

The shared identity package issues tokens but never renders this product's
`users` row, so the one route that does lives here, in the domain whose hooks
own that table.
"""

from __future__ import annotations

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
    return UserRead(
        id=user.id,
        email=str(user.email),
        display_name=user.display_name,
        email_verified=user.email_verified,
    )
