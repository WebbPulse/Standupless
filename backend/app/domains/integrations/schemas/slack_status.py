"""The shapes of a team's Slack status post switch."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class SlackStatusPostsRead(BaseModel):
    """Whether a team posts status changes into the Slack threads its issues came from.

    `enabled` is the team's switch, on until an admin turns it off, and reads true
    even before Slack is connected, so the setting is ready once it is.
    `private_asks` is whether the team's Slack request form offers a private ask,
    off until an admin turns it on.
    """

    configured: bool
    installed: bool
    enabled: bool = True
    private_asks: bool = False
    updated_at: datetime | None = None


class SlackStatusPostsWrite(BaseModel):
    """A team admin's change to the team's Slack settings; a field left out keeps its value."""

    enabled: bool | None = None
    private_asks: bool | None = None
