"""Team channel destinations: Slack and Discord incoming webhooks, in the `github` table.

A destination lives beside the outbound webhook endpoints under `channel#<id>`, and
each message sent to it leaves a short lived `chdelivery#<id>#<delivery_id>` row so a
redelivered stream record or queue message posts once. The webhook URL is a bearer
credential, so the row holds it only sealed: `url_ciphertext`, `url_nonce` and
`url_salt` are an AES-GCM envelope under a key derived from the environment master
key, and `url_hint` is the masked tail a settings page shows.

A `slack_app` or `discord_app` destination holds no URL at all: it names a Slack or
Discord channel id and posts through the workspace's installed bot, so its `url_*`
fields stay empty and `url_hint` carries the channel name.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository, new_ulid

from app.common.db.dynamo.base import as_item, utc_now

CHANNEL_PREFIX = "channel#"
CHANNEL_DELIVERY_PREFIX = "chdelivery#"

ChannelProvider = Literal["slack", "discord"]

CHANNEL_PROVIDERS: tuple[str, ...] = ("slack", "discord")

ChannelTransport = Literal["webhook", "slack_app", "discord_app"]
"""How a destination posts: to a pasted incoming webhook, or as the installed Slack or Discord App's bot."""

ChannelEvent = Literal[
    "issue_created",
    "issue_status_changed",
    "issue_completed",
    "issue_assigned",
    "comment_created",
    "project_update_posted",
    "project_update_due",
]

CHANNEL_EVENTS: tuple[str, ...] = (
    "issue_created",
    "issue_status_changed",
    "issue_completed",
    "issue_assigned",
    "comment_created",
    "project_update_posted",
    "project_update_due",
)
"""Every event a destination may filter on, in the order a settings page lists them."""

ChannelDeliveryState = Literal["pending", "retrying", "delivered", "failed"]

CHANNEL_DELIVERY_RETENTION_SECONDS = 7 * 24 * 3600
"""How long a channel delivery row lives, long enough to outlast every retry and redrive."""


def new_channel_id() -> str:
    """A fresh destination id, time sortable so a list reads in creation order."""
    return new_ulid()


def channel_key(channel_id: str) -> str:
    """The sort key of one channel destination."""
    return f"{CHANNEL_PREFIX}{channel_id}"


def channel_delivery_prefix(channel_id: str) -> str:
    """The sort key prefix every delivery of one destination shares."""
    return f"{CHANNEL_DELIVERY_PREFIX}{channel_id}#"


def channel_delivery_key(channel_id: str, delivery_id: str) -> str:
    """The sort key of one delivery to one destination."""
    return f"{channel_delivery_prefix(channel_id)}{delivery_id}"


class ChannelDestination(BaseModel):
    """One Slack or Discord channel a team posts its notifications to."""

    workspace_id: str
    github_key: str
    channel_id: str
    team_id: str
    provider: ChannelProvider
    label: str = ""
    events: list[str] = Field(default_factory=list)
    enabled: bool = True
    transport: ChannelTransport = "webhook"
    slack_channel_id: str = ""
    slack_team_id: str = ""
    discord_channel_id: str = ""
    discord_guild_id: str = ""
    url_ciphertext: str = ""
    url_nonce: str = ""
    url_salt: str = ""
    url_scheme: str = ""
    url_hint: str = ""
    last_status: int | None = None
    last_delivery_at: datetime | None = None
    disabled_reason: str | None = None
    disabled_at: datetime | None = None
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    def wants(self, events: tuple[str, ...]) -> str | None:
        """The first of `events` this enabled destination subscribes to, or `None`."""
        if not self.enabled:
            return None
        return next((event for event in events if event in self.events), None)


class ChannelDelivery(BaseModel):
    """One message sent, or being sent, to one destination.

    `body` is the provider shaped JSON exactly as it is posted, which carries no
    credential: the URL is opened from the destination row on every attempt.
    """

    workspace_id: str
    github_key: str
    channel_id: str
    delivery_id: str
    event: str
    body: str
    state: ChannelDeliveryState = "pending"
    attempts: int = 0
    last_status: int | None = None
    last_error: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    expires_at: int = 0


class ChannelStore:
    """Reads and writes channel destination and delivery rows, every method workspace first."""

    def __init__(self, repository: Repository) -> None:
        """Share the `github` table's package repository."""
        self._repository = repository

    def _key(self, workspace_id: str, github_key: str) -> dict[str, str]:
        """The primary key of one row."""
        return {"workspace_id": workspace_id, "github_key": github_key}

    def _query(self, workspace_id: str, prefix: str, limit: int, *, consistent: bool) -> list[Mapping[str, Any]]:
        """Every row of one workspace under a sort key prefix."""
        if not workspace_id:
            return []
        return list(
            self._repository.iter_query(
                Key("workspace_id").eq(workspace_id) & Key("github_key").begins_with(prefix),
                max_items=limit,
                consistent=consistent,
            )
        )

    def get(self, workspace_id: str, channel_id: str) -> ChannelDestination | None:
        """One destination, read strongly consistent so a manage right after a create finds it."""
        if not workspace_id or not channel_id:
            return None
        item = self._repository.get(self._key(workspace_id, channel_key(channel_id)), consistent=True)
        return ChannelDestination.model_validate(dict(item)) if item is not None else None

    def create(self, destination: ChannelDestination) -> ChannelDestination:
        """Store a new destination, raising `ConditionFailed` on a key collision."""
        self._repository.put(as_item(destination), condition=Attr("github_key").not_exists())
        return destination

    def list(
        self, workspace_id: str, team_id: str | None = None, *, limit: int = 500, consistent: bool = True
    ) -> list[ChannelDestination]:
        """A workspace's destinations, or one team's, oldest first."""
        rows = [
            ChannelDestination.model_validate(dict(item))
            for item in self._query(workspace_id, CHANNEL_PREFIX, limit, consistent=consistent)
        ]
        if team_id is not None:
            rows = [row for row in rows if row.team_id == team_id]
        return sorted(rows, key=lambda row: row.channel_id)

    def update(self, workspace_id: str, channel_id: str, **attributes: Any) -> ChannelDestination | None:
        """Apply `attributes` to one destination, or `None` when it does not exist."""
        values = {name: value for name, value in attributes.items() if value is not None}
        values["updated_at"] = utc_now().isoformat()
        try:
            item = self._repository.set_attributes(
                self._key(workspace_id, channel_key(channel_id)), values, condition=Attr("channel_id").exists()
            )
        except ConditionFailed:
            return None
        return ChannelDestination.model_validate(dict(item)) if item is not None else None

    def clear(self, workspace_id: str, channel_id: str, *names: str) -> ChannelDestination | None:
        """Remove optional attributes from one destination, or `None` when it does not exist."""
        try:
            item = self._repository.remove_attributes(
                self._key(workspace_id, channel_key(channel_id)), list(names), condition=Attr("channel_id").exists()
            )
        except ConditionFailed:
            return None
        return ChannelDestination.model_validate(dict(item)) if item is not None else None

    def disable(self, workspace_id: str, channel_id: str, *, reason: str, status: int) -> bool:
        """Turn an enabled destination off with a reason, reporting whether this call did it.

        Conditional on it still being enabled, so two attempts that both see a 404 tell
        the team admins once.
        """
        now = utc_now().isoformat()
        try:
            self._repository.set_attributes(
                self._key(workspace_id, channel_key(channel_id)),
                {
                    "enabled": False,
                    "disabled_reason": reason,
                    "disabled_at": now,
                    "last_status": status,
                    "last_delivery_at": now,
                    "updated_at": now,
                },
                condition=Attr("channel_id").exists() & Attr("enabled").eq(True),
            )
        except ConditionFailed:
            return False
        return True

    def delete(self, workspace_id: str, channel_id: str) -> bool:
        """Remove one destination and its delivery rows, reporting whether it was there."""
        rows = self._query(workspace_id, channel_delivery_prefix(channel_id), 10_000, consistent=False)
        self._repository.delete_many([self._key(workspace_id, str(item["github_key"])) for item in rows])
        key = self._key(workspace_id, channel_key(channel_id))
        if self._repository.get(key) is None:
            return False
        self._repository.delete(key)
        return True

    def delete_team(self, workspace_id: str, team_id: str) -> int:
        """Remove every destination of one team, for the team purge."""
        removed = 0
        for destination in self.list(workspace_id, team_id):
            if team_id and self.delete(workspace_id, destination.channel_id):
                removed += 1
        return removed

    def create_delivery(self, delivery: ChannelDelivery) -> bool:
        """Store a new delivery, reporting `False` when one with that id already exists."""
        try:
            self._repository.put(as_item(delivery), condition=Attr("github_key").not_exists())
        except ConditionFailed:
            return False
        return True

    def get_delivery(self, workspace_id: str, channel_id: str, delivery_id: str) -> ChannelDelivery | None:
        """One delivery of one destination, or `None`."""
        if not workspace_id or not channel_id or not delivery_id:
            return None
        item = self._repository.get(
            self._key(workspace_id, channel_delivery_key(channel_id, delivery_id)), consistent=True
        )
        return ChannelDelivery.model_validate(dict(item)) if item is not None else None

    def put_delivery(self, delivery: ChannelDelivery) -> ChannelDelivery:
        """Replace one delivery row."""
        self._repository.put(as_item(delivery))
        return delivery
