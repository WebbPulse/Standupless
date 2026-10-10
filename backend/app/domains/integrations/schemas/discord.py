"""Response bodies for the Discord App connection of a workspace.

None of them carries a credential: a read says only whether the App is available
here, whether this workspace installed it, and into which Discord server.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class DiscordConnectionRead(BaseModel):
    """Whether this environment has a Discord App and whether this workspace installed it."""

    configured: bool
    installed: bool
    guild_id: str | None = None
    guild_name: str | None = None
    installed_by: str | None = None
    installed_at: datetime | None = None


class DiscordInstallUrlRead(BaseModel):
    """Where to send a workspace admin to add the Discord App, and when that link stops working."""

    url: str
    expires_at: datetime


class DiscordChannelRead(BaseModel):
    """One Discord text or announcement channel the bot can post to."""

    id: str
    name: str
