"""Estimate points in cycle and project progress, under a team's estimate settings.

The properties worth holding are that every T-shirt size, extended ones included,
weighs its fixed number of points in the totals, that a zero estimate counts as
estimated, and that a team's "count unestimated issues" toggle decides whether an
unestimated issue adds one point or none to its cycle and its project. A project
measures its scope and progress in points once a team on it estimates, weighing
each issue on its own team's scale, and falls back to issue counts otherwise.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.planning import CycleSnapshot, RollupCounts
from app.common.estimates import estimate_points, is_unestimated, issue_weight
from app.domains.planning.consumers.rollup import handle_record
from app.domains.planning.history import burn_up
from tests.domains.helpers import ADMIN, MEMBER, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, TEAM, WORKSPACE, seed_cycle, seed_issue, seed_project


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


def test_an_issue_weighs_on_its_own_teams_scale() -> None:
    """Off weighs one, a size its points, a number itself, and unestimated one or none by the toggle."""
    assert issue_weight("XL", "off", count_unestimated=False) == 1
    assert issue_weight("", "off", count_unestimated=False) == 1
    assert issue_weight("L", "tshirt", count_unestimated=False) == 5
    assert issue_weight("8", "fibonacci", count_unestimated=False) == 8
    assert issue_weight("", "tshirt", count_unestimated=False) == 0
    assert issue_weight(None, "linear", count_unestimated=True) == 1
    assert issue_weight("0", "linear", count_unestimated=True) == 0


def _statuses_of(repositories: Any, team_id: str) -> "dict[str, str]":
    """One team's seeded statuses, keyed by category."""
    return {row.category: row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, team_id)}


def _recount(repositories: Any, issue: "dict[str, Any]", project_id: str, event_id: str) -> None:
    """Run the project recount off one stored issue's insert record."""
    stored = repositories.issues.get(WORKSPACE, issue["id"])
    assert stored is not None
    attributes = {
        "workspace_id": WORKSPACE,
        "issue_id": stored.issue_id,
        "team_id": stored.team_id,
        "status_id": stored.status_id,
        "project_id": project_id,
        "project_milestone_id": stored.project_milestone_id or "",
        "estimate": stored.estimate or "",
    }
    handle_record(repositories, _insert(_image(**{k: v for k, v in attributes.items() if v}), event_id=event_id))


def test_a_project_measures_mixed_sizes_in_points(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """An L done, an M started and an XS to do read as 5 of 9 points, while counts stay in issues."""
    repositories.teams.update(WORKSPACE, TEAM, estimate_scale="tshirt")
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    milestone = client.post(f"/api/workspaces/{workspace}/projects/{project_id}/milestones", json={"name": "Beta"})
    assert milestone.status_code == 201, milestone.text
    milestone_id = milestone.json()["milestone_id"]
    mine = _statuses_of(repositories, TEAM)
    first = seed_issue(
        issues_client,
        workspace,
        project_id=project_id,
        status_id=mine["completed"],
        estimate="L",
        project_milestone_id=milestone_id,
    )
    seed_issue(issues_client, workspace, project_id=project_id, status_id=mine["started"], estimate="M")
    seed_issue(issues_client, workspace, project_id=project_id, status_id=mine["unstarted"], estimate="XS")
    seed_issue(issues_client, workspace, project_id=project_id, status_id=mine["unstarted"])

    _recount(repositories, first, project_id, "1")

    body = client.get(f"/api/workspaces/{workspace}/projects/{project_id}").json()
    assert body["measure"] == "points"
    assert body["counts"] == {"todo": 2, "in_progress": 1, "done": 1, "cancelled": 0, "total": 4}
    assert body["progress"] == {"todo": 1, "in_progress": 3, "done": 5, "cancelled": 0, "total": 9}
    listed = client.get(f"/api/workspaces/{workspace}/projects/{project_id}/milestones").json()
    rows = listed.get("milestones") or listed["items"]
    assert [(row["measure"], row["progress"]["done"]) for row in rows] == [("points", 5)]

    repositories.teams.update(WORKSPACE, TEAM, estimate_count_unestimated=True)
    _recount(repositories, first, project_id, "2")
    body = client.get(f"/api/workspaces/{workspace}/projects/{project_id}").json()
    assert body["progress"]["todo"] == 2


def test_a_project_without_estimating_teams_measures_in_issues(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """With estimates off on every team, progress is the issue count and the unit says issues."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    mine = _statuses_of(repositories, TEAM)
    first = seed_issue(issues_client, workspace, project_id=project_id, status_id=mine["completed"])
    seed_issue(issues_client, workspace, project_id=project_id, status_id=mine["unstarted"])

    _recount(repositories, first, project_id, "1")

    body = client.get(f"/api/workspaces/{workspace}/projects/{project_id}").json()
    assert body["measure"] == "issues"
    assert body["progress"] == body["counts"] == {"todo": 1, "in_progress": 0, "done": 1, "cancelled": 0, "total": 2}


def test_a_cross_team_project_sums_each_issue_on_its_own_teams_scale(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """A t-shirt XL and a Fibonacci 3 sum to 11 points, and an off team's issue weighs one."""
    repositories.teams.update(WORKSPACE, TEAM, estimate_scale="tshirt")
    repositories.teams.update(WORKSPACE, OTHER_TEAM, estimate_scale="fibonacci")
    sign_in(client, ADMIN)
    sign_in(issues_client, MEMBER)
    project_id = seed_project(client, workspace, team_ids=[TEAM, OTHER_TEAM])["project_id"]
    mine = _statuses_of(repositories, TEAM)
    theirs = _statuses_of(repositories, OTHER_TEAM)
    first = seed_issue(issues_client, workspace, project_id=project_id, status_id=mine["completed"], estimate="XL")
    seed_issue(
        issues_client, workspace, team_id=OTHER_TEAM, project_id=project_id, status_id=theirs["unstarted"], estimate="3"
    )

    _recount(repositories, first, project_id, "1")
    body = client.get(f"/api/workspaces/{workspace}/projects/{project_id}").json()
    assert body["measure"] == "points"
    assert body["progress"] == {"todo": 3, "in_progress": 0, "done": 8, "cancelled": 0, "total": 11}

    repositories.teams.update(WORKSPACE, OTHER_TEAM, estimate_scale="off")
    _recount(repositories, first, project_id, "2")
    body = client.get(f"/api/workspaces/{workspace}/projects/{project_id}").json()
    assert body["measure"] == "points"
    assert body["progress"] == {"todo": 1, "in_progress": 0, "done": 8, "cancelled": 0, "total": 9}

    initiative = client.post(f"/api/workspaces/{workspace}/initiatives", json={"name": "Grow"})
    assert initiative.status_code == 201, initiative.text
    initiative_id = initiative.json()["initiative_id"]
    added = client.put(f"/api/workspaces/{workspace}/initiatives/{initiative_id}/projects/{project_id}")
    assert added.status_code == 200, added.text
    rolled = client.get(f"/api/workspaces/{workspace}/initiatives/{initiative_id}").json()
    assert rolled["measure"] == "points"
    assert rolled["progress"]["done"] == 8
    assert rolled["counts"]["done"] == 1
