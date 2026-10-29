"""Response bodies for the Slack App connection of a workspace.

None of them carries the bot token or anything derived from it: a read says only
whether the App is available here, whether this workspace installed it, and into
which Slack workspace.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, Field

EMOJI_INPUT_MAX = 110

MAX_INTAKE_CHANNELS = 20


class SlackConnectionRead(BaseModel):
    """Whether this environment has a Slack App and whether this workspace installed it."""

    configured: bool
    installed: bool
    slack_team_id: str | None = None
    slack_team_name: str | None = None
    installed_by: str | None = None
    installed_at: datetime | None = None


class SlackInstallUrlRead(BaseModel):
    """Where to send a workspace admin to add the Slack App, and when that link stops working."""

    url: str
    expires_at: datetime


class SlackChannelRead(BaseModel):
    """One Slack channel the bot can post to."""

    id: str
    name: str
    is_private: bool = False


class SlackLinkRead(BaseModel):
    """Whether the caller's personal notifications reach their Slack direct messages.

    `available` says the workspace has the Slack App installed, `linked` that the
    caller has a route, and `problem` why that route cannot deliver right now, such
    as the App being removed or Slack refusing a message, which a new link clears.
    Nothing here names another member or carries a token.
    """

    configured: bool
    available: bool
    linked: bool = False
    slack_user_id: str | None = None
    slack_team_name: str | None = None
    linked_at: datetime | None = None
    problem: str | None = None


class SlackIntakeRead(BaseModel):
    """A team's emoji reaction intake: whether Slack is ready for it and what files a message.

    `enabled` is false until a team admin picks an emoji and channels. `reinstall`
    says the workspace's Slack App was added before it could read reactions, so it
    has to be connected again before a reaction files anything.
    `message_channel_ids` are the channels in every message mode, where each
    top-level message is filed without the emoji.
    """

    configured: bool
    installed: bool
    enabled: bool = False
    reinstall: bool = False
    emoji: str | None = None
    channel_ids: list[str] = Field(default_factory=list)
    message_channel_ids: list[str] = Field(default_factory=list)
    updated_at: datetime | None = None


class SlackIntakeWrite(BaseModel):
    """The emoji a team files messages with and the channels it listens in.

    The emoji is taken with or without its colons and any skin tone, and is stored
    the way Slack names it in a reaction. `message_channel_ids` puts some of the
    channels in every message mode; each has to be one of `channel_ids`.
    """

    emoji: str = Field(min_length=1, max_length=EMOJI_INPUT_MAX)
    channel_ids: list[Annotated[str, Field(pattern=r"^[CG][A-Z0-9]{2,30}$")]] = Field(
        min_length=1, max_length=MAX_INTAKE_CHANNELS
    )
    message_channel_ids: list[Annotated[str, Field(pattern=r"^[CG][A-Z0-9]{2,30}$")]] = Field(
        default_factory=list, max_length=MAX_INTAKE_CHANNELS
    )
