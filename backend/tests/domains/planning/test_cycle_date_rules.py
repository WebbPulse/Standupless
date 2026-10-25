"""Linear's cycle date rules on a cycle edit, and the end today action.

The properties worth holding are that a date already behind today never moves
and no date moves behind it, that extending a cycle shortens the next one rather
than overlapping it and refuses to leave it empty, that shortening leaves a gap
the list reports, that only the current cycle can end today and its open work
rolls over at the close, that "today" is the team's own day, and that a name
ending in a number carries its numbering into the cycles after it.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.cycle_schedule import ensure_cycles
from app.common.db.dynamo.planning import Cycle
from app.common.db.dynamo.team_config import default_cycle_settings, default_standup_settings
from app.domains.issues.cycle_close import sweep as close_sweep
from tests.domains.helpers import MEMBER, OUTSIDER, sign_in
from tests.domains.planning.conftest import TEAM, WORKSPACE, seed_cycle, seed_issue

TODAY = date.today()


def _day(offset: int) -> str:
    """The ISO date `offset` days from today."""
    return (TODAY + timedelta(days=offset)).isoformat()


def _patch(client: TestClient, workspace: str, cycle_id: str, **fields: Any) -> Any:
    """Patch one cycle of TEAM."""
    return client.patch(f"/api/workspaces/{workspace}/cycles/{cycle_id}", json={"team_id": TEAM, **fields})


def _end_today(client: TestClient, workspace: str, cycle_id: str) -> Any:
    """Post the end today action for one cycle of TEAM."""
    return client.post(f"/api/workspaces/{workspace}/cycles/{cycle_id}/end-today", json={"team_id": TEAM})


def _listed(client: TestClient, workspace: str) -> "dict[str, dict[str, Any]]":
    """TEAM's cycles from the list route, keyed by id."""
    response = client.get(f"/api/workspaces/{workspace}/cycles", params={"team_id": TEAM})
    assert response.status_code == 200, response.text
    return {row["cycle_id"]: row for row in response.json()["cycles"]}


def _stored(repositories: Any, cycle_id: str) -> Cycle:
    """The stored row of one cycle of TEAM."""
    row = repositories.planning.get_cycle(WORKSPACE, TEAM, cycle_id)
    assert row is not None
    return row


def test_a_started_cycle_keeps_its_start_date(client: TestClient, workspace: str) -> None:
    """A start date already behind today cannot change, even forward."""
    sign_in(client, MEMBER)
    current = seed_cycle(client, workspace, start_date=_day(-3), end_date=_day(10))

    response = _patch(client, workspace, current["cycle_id"], start_date=_day(1))

    assert response.status_code == 422, response.text


def test_an_upcoming_start_cannot_move_into_the_past(client: TestClient, workspace: str) -> None:
    """An upcoming cycle's start may move, but not behind today."""
    sign_in(client, MEMBER)
    upcoming = seed_cycle(client, workspace, start_date=_day(5), end_date=_day(18))

    assert _patch(client, workspace, upcoming["cycle_id"], start_date=_day(-1)).status_code == 422
    moved = _patch(client, workspace, upcoming["cycle_id"], start_date=_day(0))
    assert moved.status_code == 200, moved.text
    assert moved.json()["start_date"] == _day(0)


def test_the_current_cycle_cannot_end_before_today(client: TestClient, workspace: str) -> None:
    """The current cycle's end may move to today or later, never before it."""
    sign_in(client, MEMBER)
    current = seed_cycle(client, workspace, start_date=_day(-5), end_date=_day(5))

    assert _patch(client, workspace, current["cycle_id"], end_date=_day(-1)).status_code == 422
    shortened = _patch(client, workspace, current["cycle_id"], end_date=_day(2))
    assert shortened.status_code == 200, shortened.text
    assert shortened.json()["end_date"] == _day(2)


def test_a_completed_cycle_keeps_its_end_date(client: TestClient, workspace: str) -> None:
    """A cycle that already ended cannot be reopened by moving its end."""
    sign_in(client, MEMBER)
    past = seed_cycle(client, workspace, start_date=_day(-20), end_date=_day(-7))

    assert _patch(client, workspace, past["cycle_id"], end_date=_day(3)).status_code == 422


def test_a_rename_of_a_past_cycle_is_still_allowed(client: TestClient, workspace: str) -> None:
    """The date rules apply to dates only; a name or goal edit goes through."""
    sign_in(client, MEMBER)
    past = seed_cycle(client, workspace, start_date=_day(-20), end_date=_day(-7))

    response = _patch(client, workspace, past["cycle_id"], name="Retro", goal="Look back")

    assert response.status_code == 200, response.text
    assert response.json()["start_date"] == _day(-20)


def test_extending_into_the_next_cycle_moves_its_start(client: TestClient, repositories: Any, workspace: str) -> None:
    """The next cycle starts the day after the new end and keeps its own end."""
    sign_in(client, MEMBER)
    current = seed_cycle(client, workspace, name="Current", start_date=_day(-3), end_date=_day(4))
    following = seed_cycle(client, workspace, name="Next", start_date=_day(5), end_date=_day(18))

    response = _patch(client, workspace, current["cycle_id"], end_date=_day(8))

    assert response.status_code == 200, response.text
    assert response.json()["end_date"] == _day(8)
    shortened = _stored(repositories, following["cycle_id"])
    assert shortened.start_date == _day(9)
    assert shortened.end_date == _day(18)


def test_an_extension_within_the_cooldown_leaves_the_next_cycle(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """An end that stays short of the next start keeps the cooldown and the next cycle as they are."""
    sign_in(client, MEMBER)
    current = seed_cycle(client, workspace, start_date=_day(-3), end_date=_day(4))
    following = seed_cycle(client, workspace, start_date=_day(10), end_date=_day(23))

    response = _patch(client, workspace, current["cycle_id"], end_date=_day(7))

    assert response.status_code == 200, response.text
    assert _stored(repositories, following["cycle_id"]).start_date == _day(10)
    assert _listed(client, workspace)[following["cycle_id"]]["gap_before_days"] == 2


def test_an_extension_that_empties_the_next_cycle_is_refused(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """Swallowing the next cycle whole is a 409, and neither cycle is written."""
    sign_in(client, MEMBER)
    current = seed_cycle(client, workspace, start_date=_day(-3), end_date=_day(4))
    following = seed_cycle(client, workspace, start_date=_day(5), end_date=_day(10))

    response = _patch(client, workspace, current["cycle_id"], end_date=_day(10))

    assert response.status_code == 409, response.text
    assert _stored(repositories, current["cycle_id"]).end_date == _day(4)
    assert _stored(repositories, following["cycle_id"]).start_date == _day(5)


def test_an_extension_into_a_started_cycle_is_refused(client: TestClient, workspace: str) -> None:
    """A next cycle whose start is already behind today cannot be shortened."""
    sign_in(client, MEMBER)
    current = seed_cycle(client, workspace, start_date=_day(-10), end_date=_day(2))
    seed_cycle(client, workspace, start_date=_day(-2), end_date=_day(12))

    response = _patch(client, workspace, current["cycle_id"], end_date=_day(5))

    assert response.status_code == 409, response.text


def test_a_start_moved_onto_the_previous_cycle_is_refused(client: TestClient, workspace: str) -> None:
    """Moving an upcoming start back onto the cycle before it would overlap it."""
    sign_in(client, MEMBER)
    seed_cycle(client, workspace, start_date=_day(-3), end_date=_day(6))
    upcoming = seed_cycle(client, workspace, start_date=_day(10), end_date=_day(23))

    assert _patch(client, workspace, upcoming["cycle_id"], start_date=_day(6)).status_code == 409
    assert _patch(client, workspace, upcoming["cycle_id"], start_date=_day(7)).status_code == 200


def test_shortening_leaves_a_gap_the_list_reports(client: TestClient, workspace: str) -> None:
    """A shortened cycle leaves days before the next one; touching cycles read 0 and the first none."""
    sign_in(client, MEMBER)
    current = seed_cycle(client, workspace, start_date=_day(-3), end_date=_day(10))
    following = seed_cycle(client, workspace, start_date=_day(11), end_date=_day(24))
    later = seed_cycle(client, workspace, start_date=_day(25), end_date=_day(38))

    response = _patch(client, workspace, current["cycle_id"], end_date=_day(6))

    assert response.status_code == 200, response.text
    listed = _listed(client, workspace)
    assert listed[current["cycle_id"]]["gap_before_days"] is None
    assert listed[following["cycle_id"]]["gap_before_days"] == 4
    assert listed[later["cycle_id"]]["gap_before_days"] == 0


def test_the_current_cycle_ends_today(client: TestClient, repositories: Any, workspace: str) -> None:
    """The end moves to today and the next cycle keeps its dates, leaving a gap."""
    sign_in(client, MEMBER)
    current = seed_cycle(client, workspace, start_date=_day(-5), end_date=_day(8))
    following = seed_cycle(client, workspace, start_date=_day(9), end_date=_day(22))

    response = _end_today(client, workspace, current["cycle_id"])

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["end_date"] == _day(0)
    assert body["start_date"] == _day(-5)
    assert body["status"] == "active"
    assert _stored(repositories, following["cycle_id"]).start_date == _day(9)
    assert _listed(client, workspace)[following["cycle_id"]]["gap_before_days"] == 8


def test_ending_today_twice_is_answered_as_it_is(client: TestClient, workspace: str) -> None:
    """A cycle already ending today is still current, so a repeat succeeds and changes nothing."""
    sign_in(client, MEMBER)
    current = seed_cycle(client, workspace, start_date=_day(-5), end_date=_day(0))

    response = _end_today(client, workspace, current["cycle_id"])

    assert response.status_code == 200, response.text
    assert response.json()["end_date"] == _day(0)


def test_only_the_current_cycle_can_end_today(client: TestClient, workspace: str) -> None:
    """An upcoming, a completed and a cancelled cycle are each a 409."""
    sign_in(client, MEMBER)
    past = seed_cycle(client, workspace, start_date=_day(-20), end_date=_day(-7))
    upcoming = seed_cycle(client, workspace, start_date=_day(5), end_date=_day(18))
    cancelled = seed_cycle(client, workspace, start_date=_day(-2), end_date=_day(4))
    assert _patch(client, workspace, cancelled["cycle_id"], cancelled=True).status_code == 200

    for cycle in (past, upcoming, cancelled):
        assert _end_today(client, workspace, cycle["cycle_id"]).status_code == 409


def test_an_outsider_cannot_end_a_cycle_today(client: TestClient, workspace: str) -> None:
    """Someone outside the workspace reads not found, as every cycle route answers them."""
    sign_in(client, MEMBER)
    current = seed_cycle(client, workspace, start_date=_day(-5), end_date=_day(8))

    sign_in(client, OUTSIDER)
    assert _end_today(client, workspace, current["cycle_id"]).status_code == 404


def test_unfinished_issues_roll_over_at_the_close(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """The close after today moves open work into the next cycle under the usual rule."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    current = seed_cycle(client, workspace, start_date=_day(-5), end_date=_day(8))
    following = seed_cycle(client, workspace, start_date=_day(9), end_date=_day(22))
    statuses = {row.category: row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, TEAM)}
    todo = seed_issue(issues_client, workspace, cycle_id=current["cycle_id"], status_id=statuses["unstarted"])
    done = seed_issue(issues_client, workspace, cycle_id=current["cycle_id"], status_id=statuses["completed"])
    assert _end_today(client, workspace, current["cycle_id"]).status_code == 200

    assert close_sweep(repositories, today=_day(0)).cycles == 0
    summary = close_sweep(repositories, today=_day(1))

    assert summary.cycles == 1
    assert summary.carried == 1
    moved = repositories.issues.get(WORKSPACE, todo["id"])
    kept = repositories.issues.get(WORKSPACE, done["id"])
    assert moved is not None and moved.cycle_id == following["cycle_id"]
    assert kept is not None and kept.cycle_id == current["cycle_id"]


def test_today_is_the_teams_own_day(
    client: TestClient, repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Late evening in UTC is already tomorrow in Auckland, so a team there ends on its own date."""
    sign_in(client, MEMBER)
    current = seed_cycle(client, workspace, start_date="2099-03-01", end_date="2099-03-20")
    settings = default_standup_settings(WORKSPACE, TEAM).model_copy(update={"timezone": "Pacific/Auckland"})
    repositories.team_config.put_standup_settings(settings)
    monkeypatch.setattr("app.common.cycle_writes.utc_now", lambda: datetime(2099, 3, 10, 22, 0, tzinfo=timezone.utc))

    response = _end_today(client, workspace, current["cycle_id"])

    assert response.status_code == 200, response.text
    assert response.json()["end_date"] == "2099-03-11"


def test_a_name_ending_in_a_number_renumbers_the_chain(client: TestClient, repositories: Any, workspace: str) -> None:
    """The renamed cycle takes its number, the automatic cycles after it follow, and the schedule continues."""
    sign_in(client, MEMBER)
    settings = default_cycle_settings(WORKSPACE, TEAM).model_copy(update={"enabled": True})
    ensure_cycles(repositories.planning, settings, TODAY)
    chain = sorted(repositories.planning.list_for_roadmap(WORKSPACE, TEAM), key=lambda c: c.start_date)
    assert [c.name for c in chain] == ["Cycle 1", "Cycle 2", "Cycle 3"]

    response = _patch(client, workspace, chain[0].cycle_id, name="Sprint 40")

    assert response.status_code == 200, response.text
    renamed = sorted(repositories.planning.list_for_roadmap(WORKSPACE, TEAM), key=lambda c: c.start_date)
    assert [(c.name, c.number) for c in renamed] == [("Sprint 40", 40), ("Cycle 41", 41), ("Cycle 42", 42)]

    later = date.fromisoformat(renamed[-1].start_date)
    created = ensure_cycles(repositories.planning, settings, later).created
    assert created
    assert created[0].name == "Cycle 43"
