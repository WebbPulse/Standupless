"""The shapes of a team's Slack status post switch."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class SlackStatusPostsRead(BaseModel):
    """Whether a team posts status changes into the Slack threads its issues came from.

    `enabled` is the team's switch, on until an admin turns it off, and reads true
    even before Slack is connected, so the setting is ready once it is.
    """

    configured: bool
    installed: bool
    enabled: bool = True
    updated_at: datetime | None = None


class SlackStatusPostsWrite(BaseModel):
    """A team admin's choice to post status changes into paired Slack threads or not."""

    enabled: bool
