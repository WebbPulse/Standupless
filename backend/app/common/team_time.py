"""A team's own calendar day, read in the team's timezone.

Cycles start, end and roll over at midnight where the team works, as Linear's
do, rather than at midnight UTC where the functions run. Every "today" a cycle
rule is judged against comes from here, so the schedule, the cycle close, the
start and end today actions and the current, next and previous references all
agree on which day it is for one team.

The timezone is an IANA name on the team row. A team that never set one reads
as UTC, and a stored name zoneinfo no longer knows falls back to UTC rather
than failing a read.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Iterable, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.teams import DEFAULT_TEAM_TIMEZONE

UTC = ZoneInfo(DEFAULT_TEAM_TIMEZONE)


def is_known_timezone(name: str) -> bool:
    """Whether zoneinfo knows `name` as an IANA timezone."""
    if not name or name != name.strip():
        return False
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return False
    return True


def check_timezone(value: str) -> str:
    """Hold a timezone to a name zoneinfo knows, the validator the team schemas share."""
    candidate = value.strip()
    if not is_known_timezone(candidate):
        raise ValueError(f"timezone must be an IANA timezone name such as America/Los_Angeles, not {value!r}")
    return candidate


def zone_named(name: Optional[str]) -> ZoneInfo:
    """The zone `name` names, UTC when it is empty or unknown."""
    if not name:
        return UTC
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return UTC


def local_date(name: Optional[str], now: Optional[datetime] = None) -> date:
    """The calendar date at `now`, the current moment by default, in the zone `name`."""
    return (now or utc_now()).astimezone(zone_named(name)).date()


def timezone_of(team: Any) -> str:
    """A team row's timezone, UTC for a missing team or one stored before teams had one."""
    name = getattr(team, "timezone", None) if team is not None else None
    return str(name) if name else DEFAULT_TEAM_TIMEZONE


def team_timezone(repositories: Any, workspace_id: str, team_id: str) -> str:
    """One team's timezone name, read off its row."""
    return timezone_of(repositories.teams.get(workspace_id, team_id))


def team_today(repositories: Any, workspace_id: str, team_id: str, now: Optional[datetime] = None) -> date:
    """Today's date for one team, in its timezone."""
    return local_date(team_timezone(repositories, workspace_id, team_id), now)


def teams_today(
    repositories: Any, workspace_id: str, team_ids: Iterable[str], now: Optional[datetime] = None
) -> dict[str, date]:
    """Today's date for each of several teams, each in its own timezone, read at one moment."""
    moment = now or utc_now()
    return {team_id: team_today(repositories, workspace_id, team_id, moment) for team_id in dict.fromkeys(team_ids)}
