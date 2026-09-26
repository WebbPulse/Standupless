"""The cycle close sweep: unfinished issues of an ended cycle roll into the next one.

The properties worth holding are that only unfinished issues move, that each move
leaves the carry marker the planning rollup counts and a system activity row, that
a second sweep moves nothing, that a planner's own move is never overridden, and
that a cancelled cycle or one with nowhere to roll is left alone.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.domains.issues.consumers.rollup import build_router
from app.domains.issues.cycle_close import CYCLE_CLOSE_SOURCE, is_cycle_close, next_cycle, sweep
from tests.domains.helpers import MEMBER, sign_in
from tests.domains.planning.conftest import TEAM, WORKSPACE, seed_cycle, seed_issue

TODAY = "2026-03-10"


def _status_ids(repositories: Any) -> "dict[str, str]":
    """The seeded statuses of TEAM, keyed by category."""
    return {row.category: row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, TEAM)}


def _setup(client: TestClient, issues_client: TestClient, workspace: str) -> "tuple[dict[str, Any], dict[str, Any]]":
    """An ended cycle and the active one after it, both for TEAM."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    ended = seed_cycle(client, workspace, name="Ended", start_date="2026-02-23", end_date="2026-03-08")
    following = seed_cycle(client, workspace, name="Next", start_date="2026-03-09", end_date="2026-03-22")
    return ended, following


def _issue(repositories: Any, issue_id: str) -> Any:
    """One issue row as it stands now."""
    row = repositories.issues.get(WORKSPACE, issue_id)
    assert row is not None
    return row


def test_unfinished_issues_roll_into_the_next_cycle(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """Todo and in progress move with the marker set; done and cancelled stay put."""
    ended, following = _setup(client, issues_client, workspace)
    statuses = _status_ids(repositories)
    todo = seed_issue(issues_client, workspace, cycle_id=ended["cycle_id"], status_id=statuses["unstarted"])
    doing = seed_issue(issues_client, workspace, cycle_id=ended["cycle_id"], status_id=statuses["started"])
    done = seed_issue(issues_client, workspace, cycle_id=ended["cycle_id"], status_id=statuses["completed"])
    dropped = seed_issue(issues_client, workspace, cycle_id=ended["cycle_id"], status_id=statuses["cancelled"])

    summary = sweep(repositories, today=TODAY)

    assert summary.cycles == 1
    assert summary.carried == 2
    assert summary.without_next == 0
    for moved in (todo, doing):
        row = _issue(repositories, moved["id"])
        assert row.cycle_id == following["cycle_id"]
        assert row.cycle_carried_from == ended["cycle_id"]
    for kept in (done, dropped):
        row = _issue(repositories, kept["id"])
        assert row.cycle_id == ended["cycle_id"]
        assert row.cycle_carried_from is None


def test_a_carry_is_recorded_as_a_system_change(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """The issue's history says the cycle moved and that no person moved it."""
    ended, following = _setup(client, issues_client, workspace)
    issue = seed_issue(
        issues_client, workspace, cycle_id=ended["cycle_id"], status_id=_status_ids(repositories)["unstarted"]
    )

    sweep(repositories, today=TODAY)

    rows = repositories.activity.list_for_issue(WORKSPACE, issue["id"]).items
    carried = [row for row in rows if row.get("field") == "cycle_id"]
    assert len(carried) == 1
    assert carried[0]["actor_kind"] == "system"
    assert carried[0]["from_value"] == ended["cycle_id"]
    assert carried[0]["to_value"] == following["cycle_id"]


def test_a_second_sweep_moves_nothing(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """The hourly schedule re-reads the same ended cycle and finds it already closed."""
    ended, _ = _setup(client, issues_client, workspace)
    seed_issue(issues_client, workspace, cycle_id=ended["cycle_id"], status_id=_status_ids(repositories)["unstarted"])

    assert sweep(repositories, today=TODAY).carried == 1
    assert sweep(repositories, today=TODAY).carried == 0


def test_a_move_made_meanwhile_is_kept(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """The conditional update refuses when the issue no longer sits in the ended cycle."""
    ended, following = _setup(client, issues_client, workspace)
    issue = seed_issue(
        issues_client, workspace, cycle_id=ended["cycle_id"], status_id=_status_ids(repositories)["unstarted"]
    )

    assert repositories.issues.carry_to_cycle(WORKSPACE, issue["id"], "SOMEWHERE", following["cycle_id"]) is None
    assert _issue(repositories, issue["id"]).cycle_id == ended["cycle_id"]


def test_a_cycle_with_nowhere_to_roll_is_left(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """Without a later cycle the issues stay, and a sweep after one is created moves them."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    ended = seed_cycle(client, workspace, name="Ended", start_date="2026-02-23", end_date="2026-03-08")
    issue = seed_issue(
        issues_client, workspace, cycle_id=ended["cycle_id"], status_id=_status_ids(repositories)["unstarted"]
    )

    summary = sweep(repositories, today=TODAY)
    assert summary.without_next == 1
    assert _issue(repositories, issue["id"]).cycle_id == ended["cycle_id"]

    later = seed_cycle(client, workspace, name="Later", start_date="2026-03-11", end_date="2026-03-24")
    assert sweep(repositories, today=TODAY).carried == 1
    assert _issue(repositories, issue["id"]).cycle_id == later["cycle_id"]


def test_a_cancelled_cycle_is_not_closed(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """Cancelling a cycle is a decision about its issues that a close does not override."""
    ended, _ = _setup(client, issues_client, workspace)
    issue = seed_issue(
        issues_client, workspace, cycle_id=ended["cycle_id"], status_id=_status_ids(repositories)["unstarted"]
    )
    response = client.patch(
        f"/api/workspaces/{workspace}/cycles/{ended['cycle_id']}", json={"team_id": TEAM, "cancelled": True}
    )
    assert response.status_code == 200, response.text

    assert sweep(repositories, today=TODAY).cycles == 0
    assert _issue(repositories, issue["id"]).cycle_id == ended["cycle_id"]


def test_cycles_outside_the_lookback_are_not_closed(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """A cycle that ended weeks ago, or ends today, is not the sweep's to touch."""
    sign_in(client, MEMBER)
    seed_cycle(client, workspace, name="Old", start_date="2026-01-01", end_date="2026-01-14")
    seed_cycle(client, workspace, name="Today", start_date="2026-02-25", end_date=TODAY)

    assert sweep(repositories, today=TODAY).cycles == 0


def test_the_next_cycle_is_the_earliest_live_one_after() -> None:
    """Never a past, cancelled or other team's cycle."""
    from app.common.db.dynamo.planning import Cycle, cycle_key

    def make(cycle_id: str, start: str, end: str, team: str = TEAM, cancelled: bool = False) -> Cycle:
        """One in-memory cycle."""
        return Cycle(
            workspace_id=WORKSPACE,
            planning_key=cycle_key(team, cycle_id),
            cycle_id=cycle_id,
            team_id=team,
            name=cycle_id,
            start_date=start,
            end_date=end,
            created_by=MEMBER,
            cancelled=cancelled,
        )

    ended = make("E", "2026-02-23", "2026-03-08")
    candidates = [
        ended,
        make("PAST", "2026-03-01", "2026-03-05"),
        make("GONE", "2026-03-09", "2026-03-22", cancelled=True),
        make("ELSE", "2026-03-09", "2026-03-22", team="OTHER"),
        make("LATER", "2026-03-23", "2026-04-05"),
        make("NEXT", "2026-03-09", "2026-03-22"),
    ]

    chosen = next_cycle(candidates, ended, TODAY)

    assert chosen is not None
    assert chosen.cycle_id == "NEXT"


def test_the_issues_consumer_routes_the_schedule_record_to_the_sweep(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """The schedule's payload, posted to the pass-through route, runs a close instead of a recount."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    today = date.today()
    ended = seed_cycle(
        client,
        workspace,
        name="Ended",
        start_date=(today - timedelta(days=15)).isoformat(),
        end_date=(today - timedelta(days=2)).isoformat(),
    )
    following = seed_cycle(
        client,
        workspace,
        name="Next",
        start_date=(today - timedelta(days=1)).isoformat(),
        end_date=(today + timedelta(days=12)).isoformat(),
    )
    issue = seed_issue(
        issues_client, workspace, cycle_id=ended["cycle_id"], status_id=_status_ids(repositories)["unstarted"]
    )
    record = {"eventSource": CYCLE_CLOSE_SOURCE, "eventName": "SWEEP", "eventID": "cycle-close"}

    assert is_cycle_close(record)
    assert not is_cycle_close({"eventSource": "aws:dynamodb"})
    app = FastAPI()
    app.include_router(build_router(repositories))
    with TestClient(app) as consumer:
        response = consumer.post("/events", json={"Records": [record]})

    assert response.status_code == 200, response.text
    assert response.json()["batchItemFailures"] == []

    assert _issue(repositories, issue["id"]).cycle_id == following["cycle_id"]
