"""The `users` table: the account row the identity package's hooks read and write.

Credentials, passkeys, OAuth links and second factors are not here. They belong to
`webbpulse.identity`'s own tables, which the identity module provisions. This table
holds only what Standupless itself needs to know about a person.

Email uniqueness is enforced by a sentinel row written in the same transaction as
the user row, so a race loses rather than creating a second account on one address.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Mapping, Optional

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field, field_validator
from webbpulse.dynamodb import ConditionFailed, Repository

from app.common.core.config import settings
from app.common.db.dynamo.tables import USERS

EMAIL_INDEX = "email_lower-index"

NotificationChannel = Literal["in_app", "email", "chat"]

NOTIFICATION_CHANNELS: tuple[str, ...] = ("in_app", "email", "chat")

PulseDigestField = Literal["off", "daily", "weekly"]

PULSE_DIGESTS: tuple[str, ...] = ("off", "daily", "weekly")
"""How often a person's Pulse digest email comes, if at all."""

EmailFormatField = Literal["digest", "immediate"]

EMAIL_FORMATS: tuple[str, ...] = ("digest", "immediate")
"""How notification emails reach a person: batched into a short digest, or one email per notification."""

HomeViewField = Literal["home", "inbox", "my_issues", "projects", "pulse", "views"]

HOME_VIEWS: tuple[str, ...] = ("home", "inbox", "my_issues", "projects", "pulse", "views")
"""The pages a person may land on when they open a workspace."""

WeekStartField = Literal["monday", "sunday", "saturday"]

WEEK_STARTS: tuple[str, ...] = ("monday", "sunday", "saturday")
"""The days a person's week may start on, which date shortcuts and timelines count from."""

NameDisplayField = Literal["username", "full_name"]

NAME_DISPLAYS: tuple[str, ...] = ("username", "full_name")
"""Whether teammates read to a person by their username or their full name."""

FontSizeField = Literal["small", "default", "large"]

FONT_SIZES: tuple[str, ...] = ("small", "default", "large")
"""The interface text sizes a person may pick."""

ActivityFilterField = Literal["all", "comments"]

ACTIVITY_FILTERS: tuple[str, ...] = ("all", "comments")
"""Whether an issue's activity shows every change or only its comments."""

STALE_ACCOUNT_PURGE = timedelta(hours=12)
"""How long a started account purge may go quiet before the sweep starts it again."""


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

    `display_name` is the person's handle, the word an `@mention` names them by.
    `full_name` is their name as they write it. `previous_handles` keeps every handle
    they have given up, normalised, so a mention written under an old one still
    resolves to them after a rename.

    `home_view`, `week_start`, `name_display` and `font_size` are the interface
    preferences that follow the person to every device. They default to the values
    the interface used before they existed, so an older row reads unchanged.
    `activity_filter` is whether every issue's activity shows all of it or only
    its comments, all by default.
    `projects_display` is how the person last arranged the projects list, its
    layout, grouping, ordering, closed window and timeline zoom, kept as plain
    strings that the read falls back from when a choice is retired.
    `initiatives_display` is the same for the initiatives list: its ordering,
    whether completed initiatives show, and which properties show.

    `auto_assign_to_self`, `branch_copy_starts` and `branch_copy_assigns` are the
    workflow preferences: whether an issue the person creates defaults to them as
    assignee, off by default, and whether copying an issue's git branch name moves
    a backlog or unstarted issue to its team's first started status and assigns an
    unassigned one to them, both on by default as in Linear.

    `auto_grant_new_scopes` is the person's opt-in, off by default, to have a scope
    the product adds later join every connected app grant that took every scope on
    offer when it was given, at that app's next token refresh.

    `email_format` is how notification emails arrive, one of `EMAIL_FORMATS`:
    `digest` by default, or `immediate` for one email per notification.
    """

    id: str = Field(default_factory=new_user_id)
    email: str
    display_name: str = ""
    full_name: str = ""
    previous_handles: list[str] = Field(default_factory=list)
    icon_key: Optional[str] = None
    email_verified: bool = False
    email_notifications: bool = True
    notification_preferences: dict[str, dict[str, bool]] = Field(default_factory=dict)
    email_format: str = "digest"
    timezone: Optional[str] = None
    pulse_digest: str = "off"
    home_view: str = "home"
    week_start: str = "monday"
    name_display: str = "username"
    font_size: str = "default"
    activity_filter: str = "all"
    projects_display: dict[str, str] = Field(default_factory=dict)
    initiatives_display: dict[str, str] = Field(default_factory=dict)
    auto_assign_to_self: bool = False
    branch_copy_starts: bool = True
    branch_copy_assigns: bool = True
    auto_grant_new_scopes: bool = False
    disabled: bool = False
    is_admin: bool = False
    created_at: datetime = Field(default_factory=utc_now)
    deletion_scheduled_at: Optional[datetime] = None
    purge_after: Optional[datetime] = None
    purging_at: Optional[datetime] = None
    purge_workspace_ids: list[str] = Field(default_factory=list)

    @property
    def is_purging(self) -> bool:
        """Whether the account purge has started."""
        return self.purging_at is not None

    @property
    def is_deleted(self) -> bool:
        """Whether the account has been deleted, so it may no longer sign in or act."""
        return self.purge_after is not None or self.deletion_scheduled_at is not None or self.purging_at is not None

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
    def immediate_email(self) -> bool:
        """Whether this person asked for one email per notification rather than a digest."""
        return self.email_format == "immediate"

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

    def mark_deleted(self, user_id: str, *, now: datetime | None = None) -> User | None:
        """Mark the account deleted and due for purge now, keeping an earlier mark.

        `None` when the row is gone or its purge has already started.
        """
        moment = now or utc_now()
        try:
            item = self._repository.update(
                {"id": user_id},
                update_expression="SET #at = if_not_exists(#at, :at), #after = :at",
                expression_names={"#at": "deletion_scheduled_at", "#after": "purge_after"},
                expression_values={":at": moment.isoformat()},
                condition=Attr("id").exists() & Attr("purging_at").not_exists(),
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
        return _as_user(item) if item is not None else None

    def list_scheduled(self) -> list[User]:
        """Every deleted account whose purge is due or under way, for the hourly sweep."""
        items = self._repository.iter_scan(filter_expression=Attr("purge_after").exists())
        return [_as_user(item) for item in items]

    def list_admins(self) -> list[User]:
        """Every platform admin whose account can still sign in, for the last admin check."""
        items = self._repository.iter_scan(filter_expression=Attr("is_admin").eq(True))
        return [user for user in map(_as_user, items) if not user.disabled and not user.is_deleted]

    def begin_purge(self, user_id: str, workspace_ids: list[str], *, now: datetime | None = None) -> bool:
        """Mark the account purge as started, reporting whether this caller started it.

        Conditional on the account being marked deleted and on no purge being under
        way, or one having gone quiet past `STALE_ACCOUNT_PURGE`. The workspace ids
        are kept from the first start only, because the memberships they came from
        are deleted straight after it.
        """
        moment = now or utc_now()
        try:
            self._repository.update(
                {"id": user_id},
                update_expression="SET #purging = :now, #ws = if_not_exists(#ws, :ws)",
                expression_names={"#purging": "purging_at", "#ws": "purge_workspace_ids"},
                expression_values={":now": moment.isoformat(), ":ws": workspace_ids},
                condition=Attr("purge_after").exists()
                & (Attr("purging_at").not_exists() | Attr("purging_at").lt((moment - STALE_ACCOUNT_PURGE).isoformat())),
            )
        except ConditionFailed:
            return False
        return True

    def delete_purged(self, user_id: str) -> bool:
        """Remove the row once the account purge is finished, only while the purge mark is on it."""
        try:
            self._repository.delete({"id": user_id}, condition=Attr("purging_at").exists())
        except ConditionFailed:
            return False
        return True

    def delete(self, user_id: str) -> bool:
        """Hard-delete this user row, returning whether one was there."""
        existing = self.get(user_id)
        if existing is None:
            return False
        self._repository.delete({"id": user_id})
        return True


_LIFECYCLE_FIELDS = ("deletion_scheduled_at", "purge_after", "purging_at", "purge_workspace_ids")


def _as_item(user: User) -> dict[str, Any]:
    """A user as the stored item, carrying the index's lowercased address.

    The deletion fields are left out until they hold a value, because they are
    written with `if_not_exists` and tested with `attribute_exists`, and a stored
    null counts as existing.
    """
    item = {
        key: value
        for key, value in user.model_dump(mode="json").items()
        if key not in _LIFECYCLE_FIELDS or value not in (None, [])
    }
    item["email_lower"] = user.email_lower
    return item


def _as_user(item: Mapping[str, Any]) -> User:
    """One stored item as a `User`."""
    return User.model_validate(dict(item))
