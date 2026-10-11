"""Request and response schemas for recurring issues.

A recurring issue is a template and a rule: daily, on chosen weekdays, or on
one day of the month, at a local time in one timezone. Whether the template is
one the team offers and whether the rule can run are held by the write path in
`app.common.recurring_issues`.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, StrictBool, field_validator

from app.common.db.dynamo.team_recurring import RecurringIssue

FrequencyField = Literal["daily", "weekly", "monthly"]

TIME_PATTERN = r"^([01][0-9]|2[0-3]):[0-5][0-9]$"


def _weekdays(value: Optional[list[int]]) -> Optional[list[int]]:
    """Hold weekdays to distinct values from 0 (Monday) to 6, in order."""
    if value is None:
        return None
    if any(not 0 <= day <= 6 for day in value):
        raise ValueError("weekdays run from 0 (Monday) to 6 (Sunday)")
    return sorted(set(value))


def _zone(value: Optional[str]) -> Optional[str]:
    """Read a blank timezone as none, so the team's own applies."""
    return (value or "").strip() or None


class RecurringFields(BaseModel):
    """The rule fields a create and an update share."""

    interval: Optional[int] = Field(default=None, ge=1, le=365)
    weekdays: Optional[list[int]] = None
    day_of_month: Optional[int] = Field(default=None, ge=1, le=31)
    time: Optional[str] = Field(default=None, pattern=TIME_PATTERN)
    timezone: Optional[str] = Field(default=None, max_length=64)
    starts_on: Optional[date] = None

    @field_validator("weekdays")
    @classmethod
    def check_weekdays(cls, value: Optional[list[int]]) -> Optional[list[int]]:
        """Hold weekdays to distinct values in range."""
        return _weekdays(value)

    @field_validator("timezone")
    @classmethod
    def check_timezone(cls, value: Optional[str]) -> Optional[str]:
        """Read a blank timezone as the team's."""
        return _zone(value)


class RecurringCreate(RecurringFields):
    """The body a recurring issue create takes.

    `timezone` defaults to the team's standup timezone, else UTC, and
    `starts_on` to today there. A weekly rule needs `weekdays` and a monthly
    one `day_of_month`.
    """

    template_id: str = Field(min_length=1)
    frequency: FrequencyField
    paused: StrictBool = False


class RecurringUpdate(RecurringFields):
    """The body a recurring issue patch takes: only the fields sent change.

    `paused` pauses or resumes it. Resuming, or changing the rule, sets the next
    run from now, so a paused schedule never catches up on what it skipped.
    """

    template_id: Optional[str] = Field(default=None, min_length=1)
    frequency: Optional[FrequencyField] = None
    paused: Optional[StrictBool] = None


class RecurringRead(BaseModel):
    """One recurring issue as the API returns it.

    `next_run_at` is when the next issue is due, `None` while paused; the hourly
    sweep creates it within the hour after. `upcoming_runs` previews the runs
    after that. `paused_reason` says why the system paused it, if it did.
    """

    id: str
    team_id: str
    template_id: str
    template_name: Optional[str] = None
    frequency: FrequencyField
    interval: int
    weekdays: list[int] = Field(default_factory=list)
    day_of_month: Optional[int] = None
    time: str
    timezone: str
    starts_on: date
    paused: bool
    paused_reason: Optional[str] = None
    next_run_at: Optional[datetime] = None
    upcoming_runs: list[datetime] = Field(default_factory=list)
    last_run_at: Optional[datetime] = None
    last_issue_id: Optional[str] = None
    last_issue_key: Optional[str] = None
    created_by: str
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(
        cls, row: RecurringIssue, template_name: Optional[str], upcoming: list[datetime]
    ) -> "RecurringRead":
        """Build the response shape from a stored row, its template's name and its preview."""
        return cls(
            id=row.recurring_id,
            team_id=row.team_id,
            template_id=row.template_id,
            template_name=template_name,
            frequency=row.frequency,  # pyright: ignore[reportArgumentType]
            interval=row.interval,
            weekdays=list(row.weekdays),
            day_of_month=row.day_of_month,
            time=row.time,
            timezone=row.timezone,
            starts_on=row.starts_on,
            paused=row.paused,
            paused_reason=row.paused_reason,
            next_run_at=row.next_run_at,
            upcoming_runs=upcoming,
            last_run_at=row.last_run_at,
            last_issue_id=row.last_issue_id,
            last_issue_key=row.last_issue_key,
            created_by=row.created_by,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )


class RecurringListRead(BaseModel):
    """The body a recurring issue list answers with, and the team's default timezone."""

    recurring_issues: list[RecurringRead]
    default_timezone: str
