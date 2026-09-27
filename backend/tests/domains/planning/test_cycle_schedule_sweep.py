"""The hourly automatic cycles sweep, the started issue auto-add, and the close over auto cycles.

The properties worth holding are that the sweep stocks only teams with cycles on
and still alive, that the schedule's synthetic record reaches it through the
planning consumer route, that the close rolls unfinished issues into the next
automatic cycle, and that a started issue with no cycle joins the active one.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.common.cycle_schedule import ensure_cycles
from app.common.db.dynamo.team_config import default_cycle_settings
from app.domains.issues.consumers.rollup import auto_add_to_cycle
from app.domains.issues.consumers.rollup import handle_record as issues_handle_record
from app.domains.issues.cycle_close import sweep as close_sweep
from app.domains.planning.consumers.rollup import build_router
from app.domains.planning.cycle_schedule import CYCLE_SCHEDULE_SOURCE, is_cycle_schedule, sweep
from tests.domains.helpers import MEMBER, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, TEAM, WORKSPACE, seed_issue

TUESDAY = date(2026, 3, 10)


def _enable(repositories: Any, team_id: str = TEAM, **overrides: Any) -> Any:
    """Store enabled cycle settings for one team."""
    settings = default_cycle_settings(WORKSPACE, team_id).model_copy(update={"enabled": True, **overrides})
    return repositories.team_config.put_cycle_settings(settings)


def _statuses(repositories: Any) -> "dict[str, str]":
    """The seeded statuses of TEAM, keyed by category."""
    return {row.category: row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, TEAM)}


def _record(new: "dict[str, str]", old: "dict[str, str] | None" = None) -> "dict[str, Any]":
    """One issues stream record with string images."""
    dynamodb: "dict[str, Any]" = {"NewImage": {k: {"S": v} for k, v in new.items()}}
    if old is not None:
        dynamodb["OldImage"] = {k: {"S": v} for k, v in old.items()}
    return {"eventName": "MODIFY" if old else "INSERT", "eventID": "1", "dynamodb": dynamodb}


def test_the_sweep_stocks_enabled_teams_only(repositories: Any, workspace: str) -> None:
    """A team with cycles on gets its cycles; a team with them off gets none."""
    _enable(repositories)
    repositories.team_config.put_cycle_settings(default_cycle_settings(WORKSPACE, OTHER_TEAM))

    summary = sweep(repositories, TUESDAY)

    assert summary.teams == 1
    assert summary.created == 3
    assert len(repositories.planning.list_for_roadmap(WORKSPACE, TEAM)) == 3
    assert repositories.planning.list_for_roadmap(WORKSPACE, OTHER_TEAM) == []


def test_a_second_sweep_creates_nothing(repositories: Any, workspace: str) -> None:
    """A retried or overlapping run is a no-op."""
    _enable(repositories)
    sweep(repositories, TUESDAY)

    assert sweep(repositories, TUESDAY).created == 0


def test_the_sweep_tops_up_as_cycles_end(repositories: Any, workspace: str) -> None:
    """Two weeks on, one more cycle is created so two stay upcoming."""
    _enable(repositories)
    sweep(repositories, TUESDAY)

    later = sweep(repositories, TUESDAY + timedelta(weeks=2))

    assert later.created == 1
    names = [c.name for c in repositories.planning.list_for_roadmap(WORKSPACE, TEAM)]
    assert names == ["Cycle 1", "Cycle 2", "Cycle 3", "Cycle 4"]


def test_a_team_being_deleted_is_skipped(repositories: Any, workspace: str) -> None:
    """A tombstoned team's settings never bring cycles back."""
    _enable(repositories)
    repositories.teams.mark_deleting(WORKSPACE, TEAM)

    summary = sweep(repositories, TUESDAY)

    assert summary.skipped == 1
    assert summary.created == 0


def test_the_schedule_record_runs_the_sweep_through_the_consumer_route(repositories: Any, workspace: str) -> None:
    """The synthetic record the schedule posts is told apart and runs the sweep."""
    _enable(repositories)
    record = {"eventSource": CYCLE_SCHEDULE_SOURCE, "eventName": "SWEEP", "eventID": "cycle-schedule"}
    assert is_cycle_schedule(record)
    assert not is_cycle_schedule({"eventSource": "aws:dynamodb"})

    app = FastAPI()
    app.include_router(build_router(repositories))
    with TestClient(app) as consumer:
        response = consumer.post("/events", json={"Records": [record]})

    assert response.status_code == 200, response.text
    assert response.json()["batchItemFailures"] == []
    assert len(repositories.planning.list_for_roadmap(WORKSPACE, TEAM)) >= 3


def test_the_close_rolls_unfinished_issues_into_the_next_auto_cycle(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """When an automatic cycle ends, its open issues land in the one after it."""
    sign_in(issues_client, MEMBER)
    settings = _enable(repositories)
    ensure_cycles(repositories.planning, settings, TUESDAY)
    first, second, _ = repositories.planning.list_for_roadmap(WORKSPACE, TEAM)
    open_issue = seed_issue(
        issues_client, workspace, cycle_id=first.cycle_id, status_id=_statuses(repositories)["unstarted"]
    )

    day_after = (date.fromisoformat(first.end_date) + timedelta(days=1)).isoformat()
    summary = close_sweep(repositories, today=day_after)

    assert summary.carried == 1
    assert summary.without_next == 0
    row = repositories.issues.get(WORKSPACE, open_issue["id"])
    assert row is not None
    assert row.cycle_id == second.cycle_id


def test_a_started_issue_joins_the_active_cycle(issues_client: TestClient, repositories: Any, workspace: str) -> None:
    """Moving an issue with no cycle into a started status adds it to the current cycle."""
    sign_in(issues_client, MEMBER)
    settings = _enable(repositories)
    ensure_cycles(repositories.planning, settings)
    statuses = _statuses(repositories)
    issue = seed_issue(issues_client, workspace, status_id=statuses["unstarted"])
    base = {"workspace_id": WORKSPACE, "team_id": TEAM, "issue_id": issue["id"]}

    issues_handle_record(
        repositories,
        _record({**base, "status_id": statuses["started"]}, {**base, "status_id": statuses["unstarted"]}),
    )

    row = repositories.issues.get(WORKSPACE, issue["id"])
    assert row is not None
    active = [c for c in repositories.planning.list_for_roadmap(WORKSPACE, TEAM) if c.status() == "active"]
    assert row.cycle_id == active[0].cycle_id
    rows = repositories.activity.list_for_issue(WORKSPACE, issue["id"]).items
    added = [row for row in rows if row.get("field") == "cycle_id"]
    assert len(added) == 1
    assert added[0]["actor_kind"] == "system"
    assert added[0]["to_value"] == active[0].cycle_id


def test_auto_add_leaves_other_issues_alone(issues_client: TestClient, repositories: Any, workspace: str) -> None:
    """Not started, already in a cycle, or the setting off: nothing moves."""
    sign_in(issues_client, MEMBER)
    settings = _enable(repositories)
    ensure_cycles(repositories.planning, settings)
    statuses = _statuses(repositories)
    issue = seed_issue(issues_client, workspace, status_id=statuses["backlog"])
    base = {"workspace_id": WORKSPACE, "team_id": TEAM, "issue_id": issue["id"]}

    unstarted = _record({**base, "status_id": statuses["unstarted"]}, {**base, "status_id": statuses["backlog"]})
    assert auto_add_to_cycle(repositories, unstarted) is False

    in_cycle = _record(
        {**base, "status_id": statuses["started"], "cycle_id": "somewhere"},
        {**base, "status_id": statuses["backlog"]},
    )
    assert auto_add_to_cycle(repositories, in_cycle) is False

    started = _record({**base, "status_id": statuses["started"]}, {**base, "status_id": statuses["backlog"]})
    _enable(repositories, auto_add_started=False)
    assert auto_add_to_cycle(repositories, started) is False

    _enable(repositories)
    assert auto_add_to_cycle(repositories, started) is True
    assert auto_add_to_cycle(repositories, started) is False
