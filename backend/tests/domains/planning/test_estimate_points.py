"""Estimate points in cycle and project progress, under a team's estimate settings.

The properties worth holding are that every T-shirt size, extended ones included,
weighs its fixed number of points in the totals, that a zero estimate counts as
estimated, and that a team's "count unestimated issues" toggle decides whether an
unestimated issue adds one point or none to its cycle and its project.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.planning import CycleSnapshot, RollupCounts
from app.common.estimates import estimate_points, is_unestimated
from app.domains.planning.consumers.rollup import handle_record
from app.domains.planning.history import burn_up
from tests.domains.helpers import MEMBER, sign_in
from tests.domains.planning.conftest import TEAM, WORKSPACE, seed_cycle, seed_issue, seed_project


def _image(**attributes: str) -> "dict[str, Any]":
    """One stream image in DynamoDB's wire encoding, strings throughout."""
    return {name: {"S": value} for name, value in attributes.items()}


def _insert(new: "dict[str, Any]", event_id: str) -> "dict[str, Any]":
    """One INSERT stream record shaped the way Lambda delivers it."""
    return {"eventName": "INSERT", "eventID": event_id, "dynamodb": {"NewImage": new}}


def _status_ids(repositories: Any) -> "dict[str, str]":
    """The seeded statuses of TEAM, keyed by category."""
    return {row.category: row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, TEAM)}


def test_tshirt_sizes_map_onto_fixed_points() -> None:
    """XS to XXXL weigh 1, 2, 3, 5, 8, 13 and 21, and zero is an estimate worth nothing."""
    sizes = {"XS": 1, "S": 2, "M": 3, "L": 5, "XL": 8, "XXL": 13, "XXXL": 21}
    for size, points in sizes.items():
        assert estimate_points(size) == points
    assert estimate_points("0") == 0
    assert is_unestimated("0") is False
    assert is_unestimated(None) is True
    assert is_unestimated(" ") is True


def _seed_cycle_issues(client: TestClient, repositories: Any, workspace: str) -> str:
    """A cycle holding an XXL issue, an XS issue, a zero estimate and two unestimated issues."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace)
    todo = _status_ids(repositories)["unstarted"]
    base = {"workspace_id": WORKSPACE, "team_id": TEAM, "status_id": todo, "cycle_id": cycle["cycle_id"]}
    estimates = {"I1": "XXL", "I2": "XS", "I3": "0", "I4": "", "I5": None}
    for index, (issue_id, estimate) in enumerate(estimates.items()):
        attributes = {**base, "issue_id": issue_id}
        if estimate is not None:
            attributes["estimate"] = estimate
        handle_record(repositories, _insert(_image(**attributes), event_id=str(index + 1)))
    return cycle["cycle_id"]


def test_a_cycle_skips_unestimated_issues_by_default(client: TestClient, repositories: Any, workspace: str) -> None:
    """XXL and XS sum to 14 points, and the two unestimated issues add nothing."""
    repositories.teams.update(WORKSPACE, TEAM, estimate_scale="tshirt", estimate_extended=True)
    cycle_id = _seed_cycle_issues(client, repositories, workspace)

    body = client.get(f"/api/workspaces/{workspace}/cycles/{cycle_id}", params={"team_id": TEAM}).json()

    assert body["counts"]["todo"] == 5
    assert body["points"]["todo"] == 14
    assert body["unestimated"]["todo"] == 2


def test_a_cycle_counts_unestimated_issues_as_one_point_when_the_team_does(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """The toggle reads at once, in the cycle, its list and its burn-up, with no recount."""
    repositories.teams.update(WORKSPACE, TEAM, estimate_scale="tshirt", estimate_extended=True)
    cycle_id = _seed_cycle_issues(client, repositories, workspace)
    repositories.teams.update(WORKSPACE, TEAM, estimate_count_unestimated=True)

    body = client.get(f"/api/workspaces/{workspace}/cycles/{cycle_id}", params={"team_id": TEAM}).json()
    listed = client.get(f"/api/workspaces/{workspace}/cycles", params={"team_id": TEAM}).json()

    assert body["points"]["todo"] == 16
    assert [row["points"]["todo"] for row in listed["cycles"]] == [16]

    repositories.teams.update(WORKSPACE, TEAM, estimate_scale="off")
    off = client.get(f"/api/workspaces/{workspace}/cycles/{cycle_id}", params={"team_id": TEAM}).json()
    assert off["points"]["todo"] == 14


def test_a_burn_up_reads_unestimated_issues_through_the_toggle() -> None:
    """A snapshot's unestimated issues add a point a day only when the team counts them."""
    from tests.domains.planning.test_cycle_history import _cycle

    cycle = _cycle(
        start_date="2026-03-01",
        end_date="2026-03-02",
        points=RollupCounts(todo=5),
        unestimated=RollupCounts(todo=2),
    )
    snapshot = CycleSnapshot(
        day="2026-03-01",
        points=RollupCounts(todo=3),
        unestimated=RollupCounts(todo=1),
    )

    skipped = burn_up(cycle, [snapshot], "2026-03-02")
    counted = burn_up(cycle, [snapshot], "2026-03-02", count_unestimated=True)

    assert [day.scope_points for day in skipped] == [3, 5]
    assert [day.scope_points for day in counted] == [4, 7]


def test_a_project_totals_points_and_counts_unestimated_issues_by_team(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """A project recount sums each estimate, and an unestimated issue adds one point only when counted."""
    repositories.teams.update(WORKSPACE, TEAM, estimate_scale="tshirt", estimate_extended=True)
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    todo = _status_ids(repositories)["unstarted"]
    first = seed_issue(issues_client, workspace, project_id=project_id, status_id=todo, estimate="XXXL")
    seed_issue(issues_client, workspace, project_id=project_id, status_id=todo, estimate="M")
    seed_issue(issues_client, workspace, project_id=project_id, status_id=todo)

    image = _image(
        workspace_id=WORKSPACE,
        issue_id=first["id"],
        team_id=TEAM,
        status_id=todo,
        project_id=project_id,
        estimate="XXXL",
    )
    handle_record(repositories, _insert(image, event_id="1"))
    body = client.get(f"/api/workspaces/{workspace}/projects/{project_id}").json()
    assert body["counts"]["todo"] == 3
    assert body["points"]["todo"] == 24

    repositories.teams.update(WORKSPACE, TEAM, estimate_count_unestimated=True)
    handle_record(repositories, _insert(image, event_id="2"))
    body = client.get(f"/api/workspaces/{workspace}/projects/{project_id}").json()
    assert body["points"]["todo"] == 25
