"""Schemas for one person's subscription to a team's issue events.

Held in `common` so the views route and the MCP tools answer the same body.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict


class TeamNotificationSubscriptionRead(BaseModel):
    """Which of one team's issue events reach the caller's inbox, every one off by default."""

    team_id: str
    issue_created: bool = False
    triage: bool = False
    completed: bool = False
    cancelled: bool = False


class TeamNotificationSubscriptionUpdate(BaseModel):
    """The events to turn on or off; any left out keep their current value."""

    model_config = ConfigDict(extra="forbid")

    issue_created: Optional[bool] = None
    triage: Optional[bool] = None
    completed: Optional[bool] = None
    cancelled: Optional[bool] = None
