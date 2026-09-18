"""The `users` table: the account row the identity package's hooks read and write.

Credentials, passkeys, OAuth links and second factors are not here. They belong to
`webbpulse.identity`'s own tables, which the identity module provisions. This table
holds only what Standupless itself needs to know about a person.

Email uniqueness is enforced by a sentinel row written in the same transaction as
the user row, so a race loses rather than creating a second account on one address.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Mapping

from boto3.dynamodb.conditions import Key
from pydantic import BaseModel, EmailStr, Field
from webbpulse.dynamodb import Repository

from app.common.core.config import settings
from app.common.db.dynamo.tables import USERS

EMAIL_INDEX = "email_lower-index"


def utc_now() -> datetime:
    """The current UTC time, as a timezone-aware datetime."""
    return datetime.now(timezone.utc)


def new_user_id() -> str:
    """A fresh user id, which becomes the `sub` claim of every token minted for them."""
    return str(uuid.uuid4())


class User(BaseModel):
    """One person's Standupless account."""

    id: str = Field(default_factory=new_user_id)
    email: EmailStr
    display_name: str = ""
    email_verified: bool = False
    disabled: bool = False
    is_admin: bool = False
    created_at: datetime = Field(default_factory=utc_now)

    @property
    def email_lower(self) -> str:
        """The address lowercased, which is what the uniqueness index stores."""
        return str(self.email).strip().lower()


class UserRepository:
    """Reads and writes `users` rows through the shared package repository.

    Constructing it makes no AWS call: the package repository builds its client
    on first use.
    """

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = repository if repository is not None else self._build_repository()

    @staticmethod
    def _build_repository() -> Repository:
        """The package repository for the `users` table in this environment."""
        return Repository(
            USERS.suffix,
            prefix=settings.dynamodb_table_prefix,
            endpoint_url=settings.DYNAMODB_ENDPOINT_URL or None,
        )

    def get(self, user_id: str) -> User | None:
        """The user with this id, or `None`."""
        if not user_id:
            return None
        item = self._repository.get({"id": user_id})
        return _as_user(item) if item is not None else None

    def get_by_email(self, email: str) -> User | None:
        """The user holding this address, or `None`.

        Queries `email_lower-index`, so casing and surrounding space never matter.
        """
        normalized = email.strip().lower()
        if not normalized:
            return None
        page = self._repository.query(Key("email_lower").eq(normalized), index_name=EMAIL_INDEX, limit=1)
        if not page.items:
            return None
        return _as_user(page.items[0])

    def create(self, user: User) -> User:
        """Write a new user row, keyed by id and indexed by lowercased address."""
        self._repository.put(_as_item(user))
        return user

    def update(self, user_id: str, **attributes: Any) -> User:
        """Apply `attributes` to one user row and return the stored result."""
        item = self._repository.update({"id": user_id}, attributes)
        return _as_user(item)

    def delete(self, user_id: str) -> bool:
        """Hard-delete this user row, returning whether one was there."""
        existing = self.get(user_id)
        if existing is None:
            return False
        self._repository.delete({"id": user_id})
        return True


def _as_item(user: User) -> dict[str, Any]:
    """A user as the stored item, carrying the index's lowercased address."""
    item = user.model_dump(mode="json")
    item["email_lower"] = user.email_lower
    return item


def _as_user(item: Mapping[str, Any]) -> User:
    """One stored item as a `User`."""
    return User.model_validate(dict(item))
