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
from typing import Any, Literal, Mapping

from boto3.dynamodb.conditions import Key
from pydantic import BaseModel, Field, field_validator
from webbpulse.dynamodb import Repository

from app.common.core.config import settings
from app.common.db.dynamo.tables import USERS

EMAIL_INDEX = "email_lower-index"

NotificationChannel = Literal["in_app", "email"]

NOTIFICATION_CHANNELS: tuple[str, ...] = ("in_app", "email")


def utc_now() -> datetime:
    """The current UTC time, as a timezone-aware datetime."""
    return datetime.now(timezone.utc)


def new_user_id() -> str:
    """A fresh user id, which becomes the `sub` claim of every token minted for them."""
    return str(uuid.uuid4())


class User(BaseModel):
    """One person's Standupless account.

    `email` is a plain string checked only for the `local@domain` shape, not an
    `EmailStr`. A persistence record stores what the product already accepted; it is
    not the place deliverability is decided. `EmailStr` runs email-validator, which
    refuses special-use domains such as `.invalid`, so the reserved `@e2e.invalid`
    addresses the e2e suite creates through the identity package raised here and the
    package endpoint answered 500. Strict validation stays at the API request
    boundary, on `UserRegister` and the profile update schema, where a human typing
    an unreachable address should be told.
    """

    id: str = Field(default_factory=new_user_id)
    email: str
    display_name: str = ""
    email_verified: bool = False
    email_notifications: bool = True
    notification_preferences: dict[str, dict[str, bool]] = Field(default_factory=dict)
    disabled: bool = False
    is_admin: bool = False
    created_at: datetime = Field(default_factory=utc_now)

    @field_validator("email")
    @classmethod
    def _check_email_shape(cls, value: str) -> str:
        """Refuse a value that is not a plain `local@domain` string.

        Deliberately syntactic only: exactly one `@`, both sides non-empty, a dot in
        the domain and no whitespace. That keeps an obviously broken row out of the
        table and off the `email_lower-index` without ruling out reserved domains a
        real deployment never sees but the e2e suite depends on.
        """
        candidate = value.strip()
        local, separator, domain = candidate.partition("@")
        if not separator or not local or not domain or "@" in domain:
            raise ValueError(f"{value!r} is not a local@domain email address.")
        if "." not in domain or any(character.isspace() for character in candidate):
            raise ValueError(f"{value!r} is not a local@domain email address.")
        return candidate

    def wants_notification(self, kind: str, channel: str) -> bool:
        """Whether this person wants one kind of notification on one channel.

        Stored sparsely: only a switch the person turned off is on the row, so a new
        kind or channel defaults to on without a migration. Email also answers to the
        account wide `email_notifications` switch, which turns every kind off at once.
        """
        if channel == "email" and not self.email_notifications:
            return False
        return bool(self.notification_preferences.get(kind, {}).get(channel, True))

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
        """Apply `attributes` to one user row and return the stored result.

        Every attribute name is aliased, because DynamoDB reserves ordinary words
        such as `name` and `status` and rejects an expression using them directly.
        Setting `email` rewrites the indexed `email_lower` alongside it, so the
        lookup index can never disagree with the address on the row.

        Raises `KeyError` when no row has this id, rather than creating one: an
        update naming a user who is not there is a bug in the caller. The check is
        a read rather than a condition expression, because DynamoDB refuses a
        condition on a key attribute in `UpdateItem`.
        """
        stored = self.get(user_id)
        if stored is None:
            raise KeyError(user_id)

        values = dict(attributes)
        if "email" in values:
            values["email_lower"] = str(values["email"]).strip().lower()
        if not values:
            return stored

        names = {f"#n{index}": key for index, key in enumerate(values)}
        expression_values = {f":v{index}": value for index, value in enumerate(values.values())}
        assignments = ", ".join(f"#n{index} = :v{index}" for index in range(len(values)))

        item = self._repository.update(
            {"id": user_id},
            update_expression=f"SET {assignments}",
            expression_values=expression_values,
            expression_names=names,
            return_values="ALL_NEW",
        )
        if item is None:
            raise KeyError(user_id)
        return _as_user(item)

    def get_many(self, user_ids: "list[str]") -> "dict[str, User]":
        """The named users keyed by id, skipping any that are gone.

        One `BatchGetItem` behind a member list, so rendering a workspace's people
        costs one call rather than one per membership.
        """
        items = self._repository.get_many(user_ids)
        return {user_id: _as_user(item) for user_id, item in items.items()}

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
