"""When an issue joined its cycle, and whether that counts as planned or added after the start.

Every write that moves an issue between cycles stamps `cycle_added_at`: the add
or move sets it to the moment of the write, a removal clears it, and a new
issue created straight into a cycle reads its creation time. The "Added to
cycle" filter then splits a cycle's issues the way Linear's scope report does:
an issue added before the cycle began, or within its first day, was planned,
and one added later, including after the cycle ended, was added after the
start. A row with no stamp, written before the field existed and left empty by
the backfill, reads as planned.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import TYPE_CHECKING, Literal, Optional

from app.common.db.dynamo.base import utc_now
from app.common.team_time import zone_named

if TYPE_CHECKING:
    from app.common.db.dynamo.issues import Issue

CycleAddedPhase = Literal["planned", "after_start"]

CYCLE_ADDED_PHASES: tuple[str, ...] = ("planned", "after_start")
"""Every value the "Added to cycle" filter takes, in the order a filter lists them."""

PLANNING_GRACE = timedelta(hours=24)
"""How long after a cycle starts an issue added to it still counts as planned."""


def stamp_cycle_added(previous: Optional[Issue], updated: Issue, now: Optional[datetime] = None) -> None:
    """Stamp `cycle_added_at` on `updated` when its cycle changed, given the row it replaces.

    A new issue keeps a stamp it was given, else reads its creation time. A move
    into another cycle is stamped now, a removal clears the stamp, and any other
    edit keeps it.
    """
    if updated.cycle_id is None:
        updated.cycle_added_at = None
        return
    if previous is None:
        updated.cycle_added_at = updated.cycle_added_at or updated.created_at
        return
    if previous.cycle_id == updated.cycle_id:
        return
    updated.cycle_added_at = now or utc_now()


def cycle_start_instant(start_date: str, timezone: Optional[str]) -> Optional[datetime]:
    """The moment a cycle starting on `start_date` begins: midnight that day in the team's timezone."""
    try:
        day = date.fromisoformat(start_date)
    except (TypeError, ValueError):
        return None
    return datetime.combine(day, time(0), tzinfo=zone_named(timezone))


def cycle_added_phase(added_at: Optional[datetime], cycle_start: datetime) -> CycleAddedPhase:
    """Whether an issue added at `added_at` to a cycle beginning at `cycle_start` was planned.

    An empty stamp reads as planned, so an issue the backfill could not date is
    never counted as scope creep.
    """
    if added_at is None or added_at <= cycle_start + PLANNING_GRACE:
        return "planned"
    return "after_start"
