"""Start cycle today: the next upcoming cycle starts now and the current one hands its open work over.

The properties worth holding are that the dates shift as Linear's action does,
the current cycle ending yesterday and the started one keeping its end date, that
only unfinished issues roll over and carry the marker the rollup counts, that
every cycle but the next upcoming one is refused, and that the automatic schedule
continues after the shifted chain without overlapping it.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from fastapi.testclient import TestClient

from app.common.cycle_schedule import plan_cycles
from app.common.db.dynamo.team_config import default_cycle_settings
from app.domains.issues.cycle_close import sweep as close_sweep
from tests.domains.helpers import MEMBER, OUTSIDER, sign_in
from tests.domains.planning.conftest import TEAM, WORKSPACE, seed_cycle, seed_issue

TODAY = date.today()


def _day(offset: int) -> str:
    """The ISO date `offset` days from today."""
    return (TODAY + timedelta(days=offset)).isoformat()


def _statuses(repositories: Any) -> "dict[str, str]":
    """The seeded statuses of TEAM, keyed by category."""
    return {row.category: row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, TEAM)}


def _chain(client: TestClient, workspace: str) -> "tuple[dict[str, Any], dict[str, Any], dict[str, Any]]":
    """A current cycle and two upcoming ones after it, all for TEAM."""
    current = seed_cycle(client, workspace, name="Current", start_date=_day(-5), end_date=_day(3))
    following = seed_cycle(client, workspace, name="Next", start_date=_day(4), end_date=_day(17))
    later = seed_cycle(client, workspace, name="Later", start_date=_day(18), end_date=_day(31))
    return current, following, later


def _start(client: TestClient, workspace: str, cycle_id: str) -> Any:
    """Post the start today action for one cycle of TEAM."""
    return client.post(f"/api/workspaces/{workspace}/cycles/{cycle_id}/start-today", json={"team_id": TEAM})


def test_the_next_cycle_starts_today_and_the_current_one_ends(client: TestClient, workspace: str) -> None:
    """The started cycle keeps its end date and reads active; the old one reads completed."""
    sign_in(client, MEMBER)
    current, following, _ = _chain(client, workspace)

    response = _start(client, workspace, following["cycle_id"])

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["cycle"]["start_date"] == _day(0)
    assert body["cycle"]["end_date"] == following["end_date"]
    assert body["cycle"]["status"] == "active"
    assert body["ended"]["cycle_id"] == current["cycle_id"]
    assert body["ended"]["end_date"] == _day(-1)
    assert body["ended"]["status"] == "completed"
    assert body["moved_issues"] == 0


def test_unfinished_issues_roll_into_the_started_cycle(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """Todo and in progress move with the carry marker; done and cancelled stay behind."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    current, following, _ = _chain(client, workspace)
    statuses = _statuses(repositories)
    todo = seed_issue(issues_client, workspace, cycle_id=current["cycle_id"], status_id=statuses["unstarted"])
    doing = seed_issue(issues_client, workspace, cycle_id=current["cycle_id"], status_id=statuses["started"])
    done = seed_issue(issues_client, workspace, cycle_id=current["cycle_id"], status_id=statuses["completed"])
    dropped = seed_issue(issues_client, workspace, cycle_id=current["cycle_id"], status_id=statuses["cancelled"])

    response = _start(client, workspace, following["cycle_id"])

    assert response.status_code == 200, response.text
    assert response.json()["moved_issues"] == 2
    for moved in (todo, doing):
        row = repositories.issues.get(WORKSPACE, moved["id"])
        assert row is not None
        assert row.cycle_id == following["cycle_id"]
        assert row.cycle_carried_from == current["cycle_id"]
    for kept in (done, dropped):
        row = repositories.issues.get(WORKSPACE, kept["id"])
        assert row is not None
        assert row.cycle_id == current["cycle_id"]
        assert row.cycle_carried_from is None
    rows = repositories.activity.list_for_issue(WORKSPACE, todo["id"]).items
    moves = [row for row in rows if row.get("field") == "cycle_id" and row.get("to_value") == following["cycle_id"]]
    assert len(moves) == 1
    assert moves[0]["actor_id"] == MEMBER


def test_the_close_sweep_finds_nothing_left_to_move(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """The ended cycle falls into the close window, and its rollover already happened."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    current, following, _ = _chain(client, workspace)
    seed_issue(issues_client, workspace, cycle_id=current["cycle_id"], status_id=_statuses(repositories)["unstarted"])
    assert _start(client, workspace, following["cycle_id"]).status_code == 200

    summary = close_sweep(repositories, today=_day(0))

    assert summary.cycles == 1
    assert summary.carried == 0


def test_only_the_next_upcoming_cycle_can_start_today(client: TestClient, workspace: str) -> None:
    """A later upcoming cycle, the current one and a past one are each refused."""
    sign_in(client, MEMBER)
    current, _, later = _chain(client, workspace)
    past = seed_cycle(client, workspace, name="Past", start_date=_day(-30), end_date=_day(-20))

    for cycle in (later, current, past):
        response = _start(client, workspace, cycle["cycle_id"])
        assert response.status_code == 409, response.text


def test_a_cancelled_cycle_in_between_is_skipped_over(client: TestClient, workspace: str) -> None:
    """A cancelled cycle is not live, so the one after it is next and may start."""
    sign_in(client, MEMBER)
    _, following, later = _chain(client, workspace)
    cancelled = client.patch(
        f"/api/workspaces/{workspace}/cycles/{following['cycle_id']}", json={"team_id": TEAM, "cancelled": True}
    )
    assert cancelled.status_code == 200, cancelled.text

    assert _start(client, workspace, following["cycle_id"]).status_code == 409
    assert _start(client, workspace, later["cycle_id"]).status_code == 200


def test_a_current_cycle_that_started_today_is_refused(client: TestClient, workspace: str) -> None:
    """Ending a cycle that began today would leave it with no days at all."""
    sign_in(client, MEMBER)
    seed_cycle(client, workspace, name="Fresh", start_date=_day(0), end_date=_day(6))
    following = seed_cycle(client, workspace, name="Next", start_date=_day(7), end_date=_day(13))

    response = _start(client, workspace, following["cycle_id"])

    assert response.status_code == 409, response.text
    assert "started today" in response.text


def test_with_no_current_cycle_the_next_one_simply_starts(client: TestClient, workspace: str) -> None:
    """In a cooldown there is nothing to end and nothing to move."""
    sign_in(client, MEMBER)
    seed_cycle(client, workspace, name="Done", start_date=_day(-14), end_date=_day(-2))
    following = seed_cycle(client, workspace, name="Next", start_date=_day(5), end_date=_day(18))

    response = _start(client, workspace, following["cycle_id"])

    assert response.status_code == 200, response.text
    assert response.json()["ended"] is None
    assert response.json()["cycle"]["start_date"] == _day(0)


def test_a_caller_outside_the_team_gets_a_404(client: TestClient, workspace: str) -> None:
    """The action is as invisible as the cycle to someone who cannot read it."""
    sign_in(client, MEMBER)
    _, following, _ = _chain(client, workspace)
    sign_in(client, OUTSIDER)

    assert _start(client, workspace, following["cycle_id"]).status_code == 404


def test_the_schedule_continues_after_the_shifted_chain(client: TestClient, repositories: Any, workspace: str) -> None:
    """The generator tops up one upcoming cycle after the latest end date and overlaps nothing."""
    sign_in(client, MEMBER)
    _, following, later = _chain(client, workspace)
    assert _start(client, workspace, following["cycle_id"]).status_code == 200
    settings = default_cycle_settings(WORKSPACE, TEAM).model_copy(
        update={"enabled": True, "duration_weeks": 2, "cooldown_weeks": 0, "upcoming_count": 2}
    )

    planned = plan_cycles(settings, repositories.planning.list_for_roadmap(WORKSPACE, TEAM), TODAY)

    assert len(planned) == 1
    assert planned[0][0] > date.fromisoformat(later["end_date"])
