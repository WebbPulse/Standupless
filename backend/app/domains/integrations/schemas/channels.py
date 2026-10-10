"""Request and response bodies for team channel destinations.

The webhook URL goes in on create and on an update that replaces it, and never comes
back: every read carries `url_hint`, the host and the last few characters, which is
enough to tell two channels apart and useless for posting to either. A channel
that posts through the installed Slack App has no URL at all: it is named by its
Slack channel id, and `url_hint` carries the channel name.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.common.db.dynamo.channels import CHANNEL_EVENTS, ChannelEvent, ChannelTransport

MAX_LABEL_LENGTH = 80


def _clean_events(value: list[ChannelEvent]) -> list[ChannelEvent]:
    """Refuse an empty filter, and order the rest as the settings page lists them."""
    if not value:
        raise ValueError("Pick at least one event.")
    return sorted(set(value), key=CHANNEL_EVENTS.index)


def _clean_label(value: str) -> str:
    """A label trimmed of surrounding space; blank is allowed and shows the URL hint."""
    return value.strip()


class ChannelRead(BaseModel):
    """One Slack or Discord channel a team posts its notifications to.

    `disabled_reason` is set when the channel answered 404 or 410 and was turned
    off; turning it back on clears it.
    """

    channel_id: str
    team_id: str
    provider: Literal["slack", "discord"]
    transport: ChannelTransport = "webhook"
    slack_channel_id: str = ""
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
    """Add a channel: an incoming webhook URL or a Slack channel the App posts to, a label and its events.

    Exactly one of `url` and `slack_channel_id` is given. `slack_channel_name` is
    only the name the picker showed, kept so the list can say where it posts.
    """

    model_config = ConfigDict(extra="forbid")

    url: str | None = Field(default=None, min_length=1, max_length=512)
    slack_channel_id: str | None = Field(default=None, min_length=1, max_length=40, pattern=r"^[A-Z0-9]+$")
    slack_channel_name: str = Field(default="", max_length=80)
    label: str = Field(default="", max_length=MAX_LABEL_LENGTH)
    events: list[ChannelEvent] = Field(min_length=1)
    enabled: bool = True

    @model_validator(mode="after")
    def _one_target(self) -> ChannelCreate:
        """Hold that the channel names exactly one place to post to."""
        if (self.url is None) == (self.slack_channel_id is None):
            raise ValueError("Give either a webhook URL or a Slack channel.")
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


class ChannelTestRead(BaseModel):
    """What a test message got back: whether it landed, the status, and a bounded error."""

    delivered: bool
    status_code: int
    error: str | None = None
