"""Sub-initiatives: initiatives nested under a parent, and the progress graph over a subtree.

The properties worth holding are that a parent must exist and may never be the
initiative itself or one below it, that a chain stops at the depth cap, that a
parent's rollup takes in every project below it while `project_ids` stays its
own, that deleting a parent lifts its children rather than orphaning them, and
that the progress graph counts the subtree's issues by their own dates.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi.testclient import TestClient

from app.common.initiative_tree import MAX_INITIATIVE_DEPTH
from tests.domains.helpers import ADMIN, MEMBER, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, TEAM, WORKSPACE, seed_issue, seed_project


def _base(workspace: str) -> str:
    """The workspace's initiatives collection."""
    return f"/api/workspaces/{workspace}/initiatives"


def _create(client: TestClient, workspace: str, **payload: Any) -> "dict[str, Any]":
    """Create one initiative through the route, failing loudly on a refusal."""
    body: "dict[str, Any]" = {"name": "Expand to Europe"}
    body.update(payload)
    response = client.post(_base(workspace), json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _get(client: TestClient, workspace: str, initiative_id: str) -> "dict[str, Any]":
    """One initiative as the API reads it."""
    response = client.get(f"{_base(workspace)}/{initiative_id}")
    assert response.status_code == 200, response.text
    return response.json()


def _add(client: TestClient, workspace: str, initiative_id: str, project_id: str) -> None:
    """Put a project in an initiative, failing loudly on a refusal."""
    response = client.put(f"{_base(workspace)}/{initiative_id}/projects/{project_id}")
    assert response.status_code == 200, response.text


def test_a_sub_initiative_names_its_parent_and_the_parent_lists_it(client: TestClient, workspace: str) -> None:
    """Creating under a parent sets the chain both ways, and null on a patch makes it top level."""
    sign_in(client, MEMBER)
    root = _create(client, workspace, name="Company goals")["initiative_id"]
    child = _create(client, workspace, name="Grow revenue", parent_initiative_id=root)
    grandchild = _create(client, workspace, name="Launch in Europe", parent_initiative_id=child["initiative_id"])

    assert child["parent_initiative_id"] == root
    assert [row["name"] for row in grandchild["ancestors"]] == ["Company goals", "Grow revenue"]
    assert _get(client, workspace, root)["sub_initiative_ids"] == [child["initiative_id"]]

    path = f"{_base(workspace)}/{grandchild['initiative_id']}"
    detached = client.patch(path, json={"parent_initiative_id": None})
    assert detached.status_code == 200, detached.text
    assert detached.json()["parent_initiative_id"] is None
    assert detached.json()["ancestors"] == []
    assert _get(client, workspace, child["initiative_id"])["sub_initiative_ids"] == []


def test_a_parent_must_exist_and_never_close_a_cycle(client: TestClient, workspace: str) -> None:
    """A missing parent, the initiative itself or one of its descendants is refused."""
    sign_in(client, MEMBER)
    root = _create(client, workspace, name="Root")["initiative_id"]
    child = _create(client, workspace, name="Child", parent_initiative_id=root)["initiative_id"]
    grandchild = _create(client, workspace, name="Grandchild", parent_initiative_id=child)["initiative_id"]

    missing = {"name": "Orphan", "parent_initiative_id": "01JB000000000000000000NOPE"}
    assert client.post(_base(workspace), json=missing).status_code == 422
    assert client.patch(f"{_base(workspace)}/{root}", json={"parent_initiative_id": root}).status_code == 422
    assert client.patch(f"{_base(workspace)}/{root}", json={"parent_initiative_id": grandchild}).status_code == 422
    assert _get(client, workspace, root)["parent_initiative_id"] is None


def test_nesting_stops_at_the_depth_cap(client: TestClient, workspace: str) -> None:
    """A chain runs to the cap, and moving a subtree under a parent counts the subtree's own height."""
    sign_in(client, MEMBER)
    chain = [_create(client, workspace, name="Level 1")["initiative_id"]]
    for level in range(2, MAX_INITIATIVE_DEPTH + 1):
        chain.append(_create(client, workspace, name=f"Level {level}", parent_initiative_id=chain[-1])["initiative_id"])

    too_deep = {"name": "One too many", "parent_initiative_id": chain[-1]}
    assert client.post(_base(workspace), json=too_deep).status_code == 422

    other = _create(client, workspace, name="Other root")["initiative_id"]
    _create(client, workspace, name="Other child", parent_initiative_id=other)
    moved = client.patch(f"{_base(workspace)}/{other}", json={"parent_initiative_id": chain[-2]})
    assert moved.status_code == 422
    allowed = client.patch(f"{_base(workspace)}/{other}", json={"parent_initiative_id": chain[-3]})
    assert allowed.status_code == 200, allowed.text


def test_a_parent_rolls_up_the_projects_of_every_sub_initiative(client: TestClient, workspace: str) -> None:
    """The rollup covers the whole subtree, while `project_ids` stays the parent's own."""
    sign_in(client, MEMBER)
    root = _create(client, workspace, name="Root")["initiative_id"]
    child = _create(client, workspace, name="Child", parent_initiative_id=root)["initiative_id"]
    own = seed_project(client, workspace, name="Own", health="on_track")["project_id"]
    nested = seed_project(client, workspace, team_id=OTHER_TEAM, name="Nested", health="off_track")["project_id"]
    _add(client, workspace, root, own)
    _add(client, workspace, child, nested)

    body = _get(client, workspace, root)
    assert body["project_ids"] == [own]
    assert sorted(body["rollup_project_ids"]) == sorted([own, nested])
    assert body["project_count"] == 2
    assert body["project_health"] == {"on_track": 1, "at_risk": 0, "off_track": 1, "none": 0}

    listed = {row["initiative_id"]: row for row in client.get(_base(workspace)).json()["initiatives"]}
    assert listed[root]["project_count"] == 2
    assert listed[child]["project_ids"] == [nested]
    assert listed[child]["ancestors"] == [{"initiative_id": root, "name": "Root"}]


def test_deleting_a_parent_lifts_its_sub_initiatives_to_its_own_parent(client: TestClient, workspace: str) -> None:
    """No sub-initiative is left pointing at a deleted row."""
    sign_in(client, MEMBER)
    root = _create(client, workspace, name="Root")["initiative_id"]
    middle = _create(client, workspace, name="Middle", parent_initiative_id=root)["initiative_id"]
    leaf = _create(client, workspace, name="Leaf", parent_initiative_id=middle)["initiative_id"]

    sign_in(client, ADMIN)
    assert client.delete(f"{_base(workspace)}/{middle}").status_code == 204

    assert _get(client, workspace, leaf)["parent_initiative_id"] == root
    assert _get(client, workspace, root)["sub_initiative_ids"] == [leaf]

    assert client.delete(f"{_base(workspace)}/{root}").status_code == 204
    assert _get(client, workspace, leaf)["parent_initiative_id"] is None


def test_the_progress_graph_counts_the_issues_of_the_whole_subtree(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """Scope and completion are read off the subtree's issues, cancelled ones left out, through today."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    root = _create(client, workspace, name="Root", target_date="2999-01-01")["initiative_id"]
    child = _create(client, workspace, name="Child", parent_initiative_id=root)["initiative_id"]
    project_id = seed_project(client, workspace, name="Nested")["project_id"]
    _add(client, workspace, child, project_id)
    categories = {row.category: row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, TEAM)}
    seed_issue(issues_client, workspace, project_id=project_id, title="Open")
    seed_issue(issues_client, workspace, project_id=project_id, title="Done", status_id=categories["completed"])
    seed_issue(issues_client, workspace, project_id=project_id, title="Dropped", status_id=categories["cancelled"])
    seed_issue(issues_client, workspace, title="Outside")

    response = client.get(f"{_base(workspace)}/{root}/progress")

    assert response.status_code == 200, response.text
    body = response.json()
    today = datetime.now(UTC).date().isoformat()
    assert body["measure"] == "issues"
    assert body["end_date"] == "2999-01-01"
    assert body["days"][-1] == {"date": today, "scope": 2, "started": 1, "completed": 1}
    assert body["start_date"] == body["days"][0]["date"]
