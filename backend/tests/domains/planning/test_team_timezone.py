"""Cycles start, end and roll over at midnight in the team's own timezone.

The properties worth holding are that one UTC moment is a different calendar
day for teams on either side of the date line, that a daylight saving change
moves the team's midnight with it, that the hourly schedule and the cycle close
each judge a team against its own local date, and that both stay idempotent
when the hour after a team's midnight is swept twice.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.team_config import default_cycle_settings
from app.common.team_time import check_timezone, is_known_timezone, local_date, team_today
from app.domains.issues.cycle_close import sweep as close_sweep
from app.domains.planning.cycle_schedule import sweep
from tests.domains.helpers import MEMBER, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, TEAM, WORKSPACE, seed_cycle, seed_issue

MONDAY_EVENING_UTC = datetime(2026, 3, 9, 20, 0, tzinfo=UTC)
"""Monday 20:00 UTC, already Tuesday 09:00 in Auckland."""


def _enable(repositories: Any, team_id: str) -> None:
    """Weekly cycles starting on Tuesdays, one upcoming, no cooldown."""
    settings = default_cycle_settings(WORKSPACE, team_id).model_copy(
        update={"enabled": True, "duration_weeks": 1, "cooldown_weeks": 0, "start_weekday": 1, "upcoming_count": 1}
    )
    repositories.team_config.put_cycle_settings(settings)


def _starts(repositories: Any, team_id: str) -> list[str]:
    """The start dates of a team's cycles, oldest first."""
    return sorted(cycle.start_date for cycle in repositories.planning.list_for_roadmap(WORKSPACE, team_id))


def test_timezone_names_are_checked_against_zoneinfo() -> None:
    """IANA names pass, anything else is refused."""
    assert is_known_timezone("Pacific/Auckland")
    assert check_timezone(" Europe/Berlin ") == "Europe/Berlin"
    assert not is_known_timezone("Mars/Olympus")
    assert not is_known_timezone("")
    with pytest.raises(ValueError):
        check_timezone("Mars/Olympus")


def test_one_moment_is_a_different_day_either_side_of_the_date_line() -> None:
    """Monday evening UTC is Tuesday in Auckland and still Monday in Los Angeles."""
    assert local_date("UTC", MONDAY_EVENING_UTC) == date(2026, 3, 9)
    assert local_date("Pacific/Auckland", MONDAY_EVENING_UTC) == date(2026, 3, 10)
    assert local_date("America/Los_Angeles", datetime(2026, 3, 10, 6, 0, tzinfo=UTC)) == date(2026, 3, 9)


@pytest.mark.parametrize(
    ("moment", "expected"),
    [
        (datetime(2026, 3, 10, 6, 30, tzinfo=UTC), date(2026, 3, 9)),
        (datetime(2026, 3, 10, 7, 30, tzinfo=UTC), date(2026, 3, 10)),
        (datetime(2026, 11, 3, 7, 30, tzinfo=UTC), date(2026, 11, 2)),
        (datetime(2026, 11, 3, 8, 30, tzinfo=UTC), date(2026, 11, 3)),
    ],
)
def test_midnight_follows_daylight_saving(moment: datetime, expected: date) -> None:
    """Los Angeles midnight is 07:00 UTC under daylight time and 08:00 UTC after it ends."""
    assert local_date("America/Los_Angeles", moment) == expected


def test_an_unset_or_unknown_timezone_reads_as_utc(repositories: Any, workspace: str) -> None:
    """A team stored before teams had a timezone keeps its UTC day."""
    assert team_today(repositories, WORKSPACE, TEAM, MONDAY_EVENING_UTC) == date(2026, 3, 9)
    assert local_date("Not/AZone", MONDAY_EVENING_UTC) == date(2026, 3, 9)


def test_the_schedule_stocks_each_team_on_its_own_day(repositories: Any, workspace: str) -> None:
    """The Auckland team's Tuesday cycle starts today while the UTC team is still on last week's."""
    repositories.teams.update(WORKSPACE, TEAM, timezone="Pacific/Auckland")
    _enable(repositories, TEAM)
    _enable(repositories, OTHER_TEAM)

    sweep(repositories, now=MONDAY_EVENING_UTC)

    assert _starts(repositories, TEAM) == ["2026-03-10", "2026-03-17"]
    assert _starts(repositories, OTHER_TEAM) == ["2026-03-03", "2026-03-10"]


def test_the_schedule_turns_over_after_local_midnight_across_daylight_saving(repositories: Any, workspace: str) -> None:
    """Swept hourly across the end of daylight time, the new cycle lands in the hour after local midnight, once."""
    repositories.teams.update(WORKSPACE, TEAM, timezone="America/Los_Angeles")
    _enable(repositories, TEAM)

    sweep(repositories, now=datetime(2026, 11, 3, 7, 30, tzinfo=UTC))
    before = _starts(repositories, TEAM)
    sweep(repositories, now=datetime(2026, 11, 3, 8, 30, tzinfo=UTC))
    after = _starts(repositories, TEAM)
    again = sweep(repositories, now=datetime(2026, 11, 3, 9, 30, tzinfo=UTC))

    assert before == ["2026-10-27", "2026-11-03"]
    assert after == ["2026-10-27", "2026-11-03", "2026-11-10"]
    assert again.created == 0


@pytest.mark.parametrize(("timezone", "closed"), [("Pacific/Auckland", 1), (None, 0)])
def test_a_cycle_closes_after_its_teams_midnight(
    client: TestClient,
    issues_client: TestClient,
    repositories: Any,
    workspace: str,
    timezone: str | None,
    closed: int,
) -> None:
    """A cycle ending Monday closes once Tuesday has begun where the team is, and a second sweep moves nothing."""
    if timezone:
        repositories.teams.update(WORKSPACE, TEAM, timezone=timezone)
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    ended = seed_cycle(client, workspace, name="Ended", start_date="2026-02-24", end_date="2026-03-09")
    following = seed_cycle(client, workspace, name="Next", start_date="2026-03-10", end_date="2026-03-23")
    statuses = {row.category: row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, TEAM)}
    issue = seed_issue(issues_client, workspace, cycle_id=ended["cycle_id"], status_id=statuses["unstarted"])

    first = close_sweep(repositories, now=MONDAY_EVENING_UTC)
    second = close_sweep(repositories, now=MONDAY_EVENING_UTC)

    row = repositories.issues.get(WORKSPACE, issue["id"])
    assert row is not None
    assert first.cycles == closed
    assert first.carried == closed
    assert second.carried == 0
    assert row.cycle_id == (following["cycle_id"] if closed else ended["cycle_id"])
