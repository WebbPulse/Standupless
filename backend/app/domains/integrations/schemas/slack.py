"""Response bodies for the Slack App connection of a workspace.

None of them carries the bot token or anything derived from it: a read says only
whether the App is available here, whether this workspace installed it, and into
which Slack workspace.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


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
