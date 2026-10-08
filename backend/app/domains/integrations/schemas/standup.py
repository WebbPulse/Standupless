"""Request and response bodies of the team standup digest routes."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

StandupCadenceField = Literal["off", "daily", "weekly"]

DigestCadenceField = Literal["daily", "weekly"]

MAX_NOTE_LENGTH = 2000


class StandupSettingsRead(BaseModel):
    """A team's standup digest settings, with the date the next digest is cut."""

    team_id: str
    cadence: StandupCadenceField
    send_time: str
    timezone: str
    weekday: int
    next_digest_date: str
    updated_at: datetime | None = None


class StandupSettingsUpdate(BaseModel):
    """A partial change to a team's standup digest settings."""

    model_config = ConfigDict(extra="forbid")

    cadence: StandupCadenceField | None = None
    send_time: str | None = Field(default=None, pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    timezone: str | None = Field(default=None, min_length=1, max_length=64)
    weekday: int | None = Field(default=None, ge=0, le=6)


class StandupNoteWrite(BaseModel):
    """The caller's note for one digest date, the next one when `date` is left out."""

    model_config = ConfigDict(extra="forbid")

    body: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_NOTE_LENGTH)]
    date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class StandupNoteRead(BaseModel):
    """The caller's note for one digest date, `body` null when there is none."""

    team_id: str
    user_id: str
    date: str
    body: str | None = None
    updated_at: datetime | None = None
