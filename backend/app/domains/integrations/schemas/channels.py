"""Request and response bodies for team and workspace channel destinations.

The webhook URL goes in on create and on an update that replaces it, and never comes
back: every read carries `url_hint`, the host and the last few characters, which is
enough to tell two channels apart and useless for posting to either. A channel
that posts through the installed Slack or Discord App has no URL at all: it is
named by its channel id there, and `url_hint` carries the channel name. A
workspace channel always posts through an App and adds `team_ids`, the teams it
follows, where an empty list means every open team.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.common.db.dynamo.channels import CHANNEL_EVENTS, ChannelEvent, ChannelScope, ChannelTransport

MAX_LABEL_LENGTH = 80

MAX_FOLLOWED_TEAMS = 200


def _clean_events(value: list[ChannelEvent]) -> list[ChannelEvent]:
    """Refuse an empty filter, and order the rest as the settings page lists them."""
    if not value:
        raise ValueError("Pick at least one event.")
    return sorted(set(value), key=CHANNEL_EVENTS.index)


def _clean_teams(value: list[str]) -> list[str]:
    """Deduplicate the followed teams, keeping the order they were picked in."""
    cleaned = [team_id.strip() for team_id in value]
    if any(not team_id for team_id in cleaned):
        raise ValueError("A team id cannot be blank.")
    return list(dict.fromkeys(cleaned))


def _clean_label(value: str) -> str:
    """A label trimmed of surrounding space; blank is allowed and shows the URL hint."""
    return value.strip()


class ChannelRead(BaseModel):
    """One Slack or Discord channel a team, or the whole workspace, posts its notifications to.

    `disabled_reason` is set when the channel answered 404 or 410 and was turned
    off; turning it back on clears it. A workspace channel has an empty `team_id`
    and lists the teams it follows in `team_ids`, empty for every open team.
    """

    channel_id: str
    team_id: str
    scope: ChannelScope = "team"
    team_ids: list[str] = Field(default_factory=list)
    provider: Literal["slack", "discord"]
    transport: ChannelTransport = "webhook"
    slack_channel_id: str = ""
    discord_channel_id: str = ""
    label: str
    events: list[ChannelEvent]
    enabled: bool
    url_hint: str
    last_status: int | None = None
    last_delivery_at: datetime | None = None
    disabled_reason: str | None = None
    disabled_at: datetime | None = None
    created_by: str
    created_at: datetime
    updated_at: datetime


class ChannelCreate(BaseModel):
    """Add a channel: an incoming webhook URL, or a Slack or Discord channel an App posts to, a label and its events.

    Exactly one of `url`, `slack_channel_id` and `discord_channel_id` is given. The
    `*_channel_name` fields are only the name the picker showed, kept so the list
    can say where it posts.
    """

    model_config = ConfigDict(extra="forbid")

    url: str | None = Field(default=None, min_length=1, max_length=512)
    slack_channel_id: str | None = Field(default=None, min_length=1, max_length=40, pattern=r"^[A-Z0-9]+$")
    slack_channel_name: str = Field(default="", max_length=80)
    discord_channel_id: str | None = Field(default=None, min_length=1, max_length=24, pattern=r"^[0-9]+$")
    discord_channel_name: str = Field(default="", max_length=100)
    label: str = Field(default="", max_length=MAX_LABEL_LENGTH)
    events: list[ChannelEvent] = Field(min_length=1)
    enabled: bool = True

    @model_validator(mode="after")
    def _one_target(self) -> ChannelCreate:
        """Hold that the channel names exactly one place to post to."""
        targets = (self.url, self.slack_channel_id, self.discord_channel_id)
        if sum(target is not None for target in targets) != 1:
            raise ValueError("Give exactly one of a webhook URL, a Slack channel or a Discord channel.")
        return self

    @field_validator("label")
    @classmethod
    def _check_label(cls, value: str) -> str:
        """Trim the label."""
        return _clean_label(value)

    @field_validator("events")
    @classmethod
    def _check_events(cls, value: list[ChannelEvent]) -> list[ChannelEvent]:
        """Deduplicate and order the filter."""
        return _clean_events(value)


class ChannelUpdate(BaseModel):
    """Change a channel, leaving unset fields alone.

    A new `url` replaces the stored one, and turning `enabled` back on clears the
    notice an automatic disable left.
    """

    model_config = ConfigDict(extra="forbid")

    url: str | None = Field(default=None, min_length=1, max_length=512)
    label: str | None = Field(default=None, max_length=MAX_LABEL_LENGTH)
    events: list[ChannelEvent] | None = Field(default=None, min_length=1)
    enabled: bool | None = None

    @field_validator("label")
    @classmethod
    def _check_label(cls, value: str | None) -> str | None:
        """Trim the label when one is set."""
        return None if value is None else _clean_label(value)

    @field_validator("events")
    @classmethod
    def _check_events(cls, value: list[ChannelEvent] | None) -> list[ChannelEvent] | None:
        """Deduplicate and order the filter when one is set."""
        return None if value is None else _clean_events(value)


class WorkspaceChannelCreate(ChannelCreate):
    """Add a workspace channel: a Slack or Discord channel an App posts to, and the teams it follows.

    An empty `team_ids` follows every open team. A private team is followed only
    when it is named.
    """

    team_ids: list[str] = Field(default_factory=list, max_length=MAX_FOLLOWED_TEAMS)

    @model_validator(mode="after")
    def _app_only(self) -> WorkspaceChannelCreate:
        """Refuse a pasted webhook, whose channel the workspace cannot name."""
        if self.url is not None:
            raise ValueError("A workspace channel posts through the Slack or Discord App, not a webhook URL.")
        return self

    @field_validator("team_ids")
    @classmethod
    def _check_teams(cls, value: list[str]) -> list[str]:
        """Deduplicate the followed teams."""
        return _clean_teams(value)


class WorkspaceChannelUpdate(BaseModel):
    """Change a workspace channel, leaving unset fields alone.

    Setting `team_ids` to an empty list follows every open team again.
    """

    model_config = ConfigDict(extra="forbid")

    label: str | None = Field(default=None, max_length=MAX_LABEL_LENGTH)
    events: list[ChannelEvent] | None = Field(default=None, min_length=1)
    enabled: bool | None = None
    team_ids: list[str] | None = Field(default=None, max_length=MAX_FOLLOWED_TEAMS)

    @field_validator("label")
    @classmethod
    def _check_label(cls, value: str | None) -> str | None:
        """Trim the label when one is set."""
        return None if value is None else _clean_label(value)

    @field_validator("events")
    @classmethod
    def _check_events(cls, value: list[ChannelEvent] | None) -> list[ChannelEvent] | None:
        """Deduplicate and order the filter when one is set."""
        return None if value is None else _clean_events(value)

    @field_validator("team_ids")
    @classmethod
    def _check_teams(cls, value: list[str] | None) -> list[str] | None:
        """Deduplicate the followed teams when they are set."""
        return None if value is None else _clean_teams(value)


class ChannelTestRead(BaseModel):
    """What a test message got back: whether it landed, the status, and a bounded error."""

    delivered: bool
    status_code: int
    error: str | None = None
