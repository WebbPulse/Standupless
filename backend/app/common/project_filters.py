"""The projects list's property filters: health, priority, members, start and target dates, and update age.

Shared by the projects route, the MCP `list_projects` tool and the project view
watch, so the list, an agent and a view subscription agree on what a filter
keeps. Each filter is optional and they combine with every other projects list
filter by all of them.

A date bound is exclusive and compares the stored day, so a coarse start reads
as its period's first day and a coarse target as its last, the same days the
timeline draws. A bound may be written relative to today, such as `+2w`, so a
saved view's bound keeps rolling. A project with no date meets no bound, as an issue with no due
date meets no due bound. Update age reads `last_update_at`, the newest project
update: `updated_within_days` keeps projects updated in the last that many days
and `not_updated_within_days` the ones that were not, a project never updated
among them.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, Optional

from fastapi import HTTPException, status

from app.common.db.dynamo.planning import Project
from app.common.relative_days import RELATIVE_SYNTAX, is_relative_day, resolve_relative, utc_today

NO_VALUE = "none"
"""The filter value standing for a project with no health, or with no members."""

PROJECT_HEALTHS: frozenset[str] = frozenset({"on_track", "at_risk", "off_track"})
"""The healths a project takes, spelled here because the view schema imports this module and the planning
schema imports the view schema; a test holds them equal to `ProjectHealthField`."""

PROJECT_PRIORITIES: frozenset[str] = frozenset({"none", "urgent", "high", "medium", "low"})
"""The priorities a project takes, held equal to `ProjectPriorityField` by the same test."""

MAX_UPDATE_AGE_DAYS = 3650
"""The widest update age a filter takes, ten years, past which every project reads the same."""

DATE_BOUND_FIELDS: tuple[str, ...] = (
    "start_date_before",
    "start_date_after",
    "target_date_before",
    "target_date_after",
)
"""The filter keys that hold one day, `YYYY-MM-DD`, or an offset relative to today such as `-1m`."""

UPDATE_AGE_FIELDS: tuple[str, ...] = ("updated_within_days", "not_updated_within_days")
"""The filter keys that hold a whole number of days."""


def unprocessable(message: str) -> HTTPException:
    """A 422 in the product's error envelope, built here so the view schema can import this module."""
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={"error_code": "VALIDATION_ERROR", "message": message},
    )


FILTER_KEYS: tuple[str, ...] = ("health", "priority", "member_id", *DATE_BOUND_FIELDS, *UPDATE_AGE_FIELDS)
"""Every key these filters read, in a query string or a saved project view."""


@dataclass(frozen=True)
class ProjectPropertyFilter:
    """The parsed property filters, each empty or `None` when unset.

    `healths` and `members` hold `None` for the `none` value, a project with no
    health or with no members.
    """

    healths: frozenset[Optional[str]] = frozenset()
    priorities: frozenset[str] = frozenset()
    members: frozenset[Optional[str]] = frozenset()
    start_before: Optional[str] = None
    start_after: Optional[str] = None
    target_before: Optional[str] = None
    target_after: Optional[str] = None
    updated_within_days: Optional[int] = None
    not_updated_within_days: Optional[int] = None

    @property
    def active(self) -> bool:
        """Whether any filter is set, so an unfiltered list skips the work."""
        return bool(
            self.healths
            or self.priorities
            or self.members
            or self.start_before
            or self.start_after
            or self.target_before
            or self.target_after
            or self.updated_within_days is not None
            or self.not_updated_within_days is not None
        )

    def matches(self, project: Project, now: datetime) -> bool:
        """Whether one project passes every set filter, update age measured back from `now`."""
        if self.healths and project.health not in self.healths:
            return False
        if self.priorities and (project.priority or "none") not in self.priorities:
            return False
        if self.members and not _members_match(self.members, project.member_ids):
            return False
        if not _within(project.start_date, self.start_after, self.start_before):
            return False
        if not _within(project.target_date, self.target_after, self.target_before):
            return False
        return _update_age_matches(project.last_update_at, now, self.updated_within_days, self.not_updated_within_days)

    def scope(self) -> str:
        """The filters spelled stably for a cursor scope, empty when none is set."""
        if not self.active:
            return ""
        parts = [
            ",".join(sorted(NO_VALUE if value is None else value for value in self.healths)),
            ",".join(sorted(self.priorities)),
            ",".join(sorted(NO_VALUE if value is None else value for value in self.members)),
            self.start_before or "",
            self.start_after or "",
            self.target_before or "",
            self.target_after or "",
            "" if self.updated_within_days is None else str(self.updated_within_days),
            "" if self.not_updated_within_days is None else str(self.not_updated_within_days),
        ]
        return "props=" + "|".join(parts)


def _members_match(wanted: frozenset[Optional[str]], member_ids: Iterable[str]) -> bool:
    """Whether a project has any wanted member, or no members when `none` is wanted."""
    held = set(member_ids)
    if None in wanted and not held:
        return True
    return any(value in held for value in wanted if value is not None)


def _within(day: Optional[str], after: Optional[str], before: Optional[str]) -> bool:
    """A stored day against exclusive bounds; a project without the date meets no bound."""
    if not after and not before:
        return True
    if not day:
        return False
    if before and not day < before:
        return False
    if after and not day > after:
        return False
    return True


def _update_age_matches(
    last_update_at: Optional[datetime],
    now: datetime,
    within: Optional[int],
    not_within: Optional[int],
) -> bool:
    """Whether the newest project update falls inside `within` days and outside `not_within` days of `now`."""
    if within is None and not_within is None:
        return True
    if last_update_at is not None and last_update_at.tzinfo is None:
        last_update_at = last_update_at.replace(tzinfo=timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    if within is not None and (last_update_at is None or now - last_update_at > timedelta(days=within)):
        return False
    if not_within is not None and last_update_at is not None and now - last_update_at <= timedelta(days=not_within):
        return False
    return True


def _values(raw: Any) -> list[str]:
    """One filter value that may be one text or a list of them, as trimmed non-empty texts."""
    if raw is None:
        return []
    items = raw if isinstance(raw, (list, tuple)) else [raw]
    return [text for text in (str(item).strip() for item in items if item is not None) if text]


def _day(name: str, raw: Any) -> Optional[str]:
    """One date bound as `YYYY-MM-DD`, refused when it is not a calendar day.

    A bound relative to today, such as `+2w` or `-1m`, resolves to its day
    against the current UTC day, so a saved view's bound keeps rolling.
    """
    values = _values(raw)
    if not values:
        return None
    value = values[0]
    if is_relative_day(value):
        try:
            return resolve_relative(value, utc_today())
        except ValueError:
            raise unprocessable(f"{name} must be {RELATIVE_SYNTAX}") from None
    try:
        date.fromisoformat(value)
    except ValueError:
        raise unprocessable(f"{name} must be {RELATIVE_SYNTAX}") from None
    if len(value) != 10:
        raise unprocessable(f"{name} must be {RELATIVE_SYNTAX}")
    return value


def _days(name: str, raw: Any) -> Optional[int]:
    """One update age as a whole number of days from 1 to ten years."""
    if raw is None:
        return None
    if isinstance(raw, bool):
        raise unprocessable(f"{name} must be a whole number of days")
    if isinstance(raw, int):
        value = raw
    else:
        values = _values(raw)
        if not values:
            return None
        if not values[0].isdigit():
            raise unprocessable(f"{name} must be a whole number of days")
        value = int(values[0])
    if not 1 <= value <= MAX_UPDATE_AGE_DAYS:
        raise unprocessable(f"{name} must be between 1 and {MAX_UPDATE_AGE_DAYS} days")
    return value


def parse_property_filter(
    *,
    health: Any = None,
    priority: Any = None,
    member_id: Any = None,
    start_date_before: Any = None,
    start_date_after: Any = None,
    target_date_before: Any = None,
    target_date_after: Any = None,
    updated_within_days: Any = None,
    not_updated_within_days: Any = None,
) -> ProjectPropertyFilter:
    """The property filters from query values or a stored view, a 422 for a value none of them takes.

    `health` takes `on_track`, `at_risk`, `off_track` or `none`, `priority` the
    five priorities, and `member_id` user ids or `none`, each matching any value
    named.
    """
    healths: set[Optional[str]] = set()
    for value in _values(health):
        if value != NO_VALUE and value not in PROJECT_HEALTHS:
            raise unprocessable(f"Unknown project health: {value}")
        healths.add(None if value == NO_VALUE else value)
    priorities: set[str] = set()
    for value in _values(priority):
        if value not in PROJECT_PRIORITIES:
            raise unprocessable(f"Unknown project priority: {value}")
        priorities.add(value)
    members = frozenset(None if value == NO_VALUE else value for value in _values(member_id))
    return ProjectPropertyFilter(
        healths=frozenset(healths),
        priorities=frozenset(priorities),
        members=members,
        start_before=_day("start_date_before", start_date_before),
        start_after=_day("start_date_after", start_date_after),
        target_before=_day("target_date_before", target_date_before),
        target_after=_day("target_date_after", target_date_after),
        updated_within_days=_days("updated_within_days", updated_within_days),
        not_updated_within_days=_days("not_updated_within_days", not_updated_within_days),
    )


def stored_property_filter(stored: Mapping[str, Any]) -> ProjectPropertyFilter:
    """The property filters a saved project view carries."""
    return parse_property_filter(**{key: stored.get(key) for key in FILTER_KEYS})


def property_entry_well_formed(key: str, entry: Any) -> bool:
    """Whether one stored project view value is one these filters can run, for the view schema's check."""
    try:
        if key in DATE_BOUND_FIELDS or key in UPDATE_AGE_FIELDS:
            if not isinstance(entry, str) or not entry:
                return False
        parse_property_filter(**{key: entry})
    except HTTPException:
        return False
    return True
