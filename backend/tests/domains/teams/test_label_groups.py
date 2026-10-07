"""Label groups at workspace and team level, through the label routes.

These pin the group rules: a group holds labels of its own scope one level
deep, a move into a group is refused when issues would carry two of its labels,
deleting a group keeps its children as plain labels, and a team hides or renames
an inherited group through the same overrides as any label.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.issues import Issue
from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_member, make_team, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

OTHER = "01JB000000000000000000PRJ2"

BASE = f"/api/workspaces/{WORKSPACE}"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["teams"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def teams(repositories: Any, client: TestClient) -> tuple[str, str]:
    """A workspace with an admin and a member, holding two teams, signed in as the owner."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    make_team(repositories, WORKSPACE, TEAM, "APO")
    make_team(repositories, WORKSPACE, OTHER, "GEM")
    sign_in(client, OWNER)
    return TEAM, OTHER


def _team_label(client: TestClient, name: str, **extra: Any) -> dict[str, Any]:
    """Create one of `TEAM`'s own labels and return it."""
    response = client.post(f"{BASE}/teams/{TEAM}/labels", json={"name": name, "color": "#eb5757", **extra})
    assert response.status_code == 201, response.text
    return response.json()


def _workspace_label(client: TestClient, name: str, **extra: Any) -> dict[str, Any]:
    """Create a workspace label and return it."""
    response = client.post(f"{BASE}/labels", json={"name": name, "color": "#eb5757", **extra})
    assert response.status_code == 201, response.text
    return response.json()


def _team_labels(client: TestClient, team_id: str, **params: Any) -> dict[str, dict[str, Any]]:
    """A team's effective labels keyed by id."""
    rows = client.get(f"{BASE}/teams/{team_id}/labels", params=params).json()["labels"]
    return {row["id"]: row for row in rows}


def _issue(repositories: Any, team_id: str, number: int, label_ids: list[str]) -> Issue:
    """Put one issue carrying `label_ids` in, as the issues domain would have stored it."""
    return repositories.issues.create(
        Issue(
            workspace_id=WORKSPACE,
            team_id=team_id,
            key=f"APO-{number}",
            number=number,
            title=f"Issue {number}",
            status_id="status",
            label_ids=label_ids,
            created_by=OWNER,
        )
    )


def test_a_team_group_holds_team_labels(client: TestClient, teams: tuple[str, str]) -> None:
    """A group is created, a child is created inside it, and both read back with the group fields."""
    group = _team_label(client, "Area", is_group=True)
    child = _team_label(client, "Frontend", parent_id=group["id"])
    assert group["is_group"] is True and group["parent_id"] is None
    assert child["is_group"] is False and child["parent_id"] == group["id"]
    listed = _team_labels(client, TEAM)
    assert listed[child["id"]]["parent_id"] == group["id"]


def test_a_group_cannot_nest_or_hold_a_missing_parent(client: TestClient, teams: tuple[str, str]) -> None:
    """Groups are one level deep, and the parent must be one of the team's groups."""
    group = _team_label(client, "Area", is_group=True)
    plain = _team_label(client, "Bug")
    base = f"{BASE}/teams/{TEAM}/labels"
    nested = client.post(base, json={"name": "Inner", "color": "#eb5757", "is_group": True, "parent_id": group["id"]})
    assert nested.status_code == 422
    not_group = client.post(base, json={"name": "UI", "color": "#eb5757", "parent_id": plain["id"]})
    assert not_group.status_code == 422
    assert client.patch(f"{base}/{group['id']}", json={"parent_id": group["id"]}).status_code == 422


def test_a_team_label_cannot_join_a_workspace_group(client: TestClient, teams: tuple[str, str]) -> None:
    """A group and its children share a scope."""
    group = _workspace_label(client, "Type", is_group=True)
    plain = _team_label(client, "Bug")
    response = client.patch(f"{BASE}/teams/{TEAM}/labels/{plain['id']}", json={"parent_id": group["id"]})
    assert response.status_code == 422


def test_a_label_moves_into_and_out_of_a_group(client: TestClient, teams: tuple[str, str]) -> None:
    """A patch with a parent groups a label, and an explicit null ungroups it."""
    group = _team_label(client, "Area", is_group=True)
    plain = _team_label(client, "Frontend")
    base = f"{BASE}/teams/{TEAM}/labels/{plain['id']}"
    moved = client.patch(base, json={"parent_id": group["id"]})
    assert moved.status_code == 200, moved.text
    assert moved.json()["parent_id"] == group["id"]
    renamed = client.patch(base, json={"name": "Web"})
    assert renamed.json()["parent_id"] == group["id"]
    out = client.patch(base, json={"parent_id": None})
    assert out.status_code == 200
    assert out.json()["parent_id"] is None


def test_a_move_that_would_double_a_group_on_an_issue_is_a_409(
    client: TestClient, teams: tuple[str, str], repositories: Any
) -> None:
    """An issue already carrying a sibling blocks the move, and the count says how many."""
    group = _team_label(client, "Area", is_group=True)
    inside = _team_label(client, "Frontend", parent_id=group["id"])
    outside = _team_label(client, "Backend")
    _issue(repositories, TEAM, 1, [inside["id"], outside["id"]])
    _issue(repositories, TEAM, 2, [outside["id"]])
    response = client.patch(f"{BASE}/teams/{TEAM}/labels/{outside['id']}", json={"parent_id": group["id"]})
    assert response.status_code == 409
    assert response.json()["details"]["issue_count"] == 1
    assert "1 issue carries Backend" in response.json()["message"]


def test_deleting_a_group_keeps_its_children(client: TestClient, teams: tuple[str, str]) -> None:
    """The children stay as plain labels once their group is gone."""
    group = _team_label(client, "Area", is_group=True)
    child = _team_label(client, "Frontend", parent_id=group["id"])
    assert client.delete(f"{BASE}/teams/{TEAM}/labels/{group['id']}").status_code == 204
    listed = _team_labels(client, TEAM)
    assert group["id"] not in listed
    assert listed[child["id"]]["parent_id"] is None


def test_a_workspace_group_reaches_every_team(client: TestClient, teams: tuple[str, str]) -> None:
    """A workspace group and its child appear in each team tagged workspace."""
    group = _workspace_label(client, "Type", is_group=True)
    child = _workspace_label(client, "Bug", parent_id=group["id"])
    for team_id in teams:
        listed = _team_labels(client, team_id)
        assert listed[group["id"]]["is_group"] is True
        assert listed[group["id"]]["scope"] == "workspace"
        assert listed[child["id"]]["parent_id"] == group["id"]


def test_a_workspace_move_is_checked_across_teams(
    client: TestClient, teams: tuple[str, str], repositories: Any
) -> None:
    """An issue in any team carrying a sibling blocks a workspace move."""
    group = _workspace_label(client, "Type", is_group=True)
    inside = _workspace_label(client, "Bug", parent_id=group["id"])
    outside = _workspace_label(client, "Feature")
    _issue(repositories, OTHER, 1, [inside["id"], outside["id"]])
    response = client.patch(f"{BASE}/labels/{outside['id']}", json={"parent_id": group["id"]})
    assert response.status_code == 409
    assert response.json()["details"]["issue_count"] == 1


def test_a_workspace_label_moves_in_and_out(client: TestClient, teams: tuple[str, str]) -> None:
    """The workspace label patch groups and ungroups like the team one."""
    group = _workspace_label(client, "Type", is_group=True)
    plain = _workspace_label(client, "Bug")
    moved = client.patch(f"{BASE}/labels/{plain['id']}", json={"parent_id": group["id"]})
    assert moved.status_code == 200, moved.text
    assert moved.json()["parent_id"] == group["id"]
    out = client.patch(f"{BASE}/labels/{plain['id']}", json={"parent_id": None})
    assert out.json()["parent_id"] is None


def test_deleting_a_workspace_group_keeps_its_children(client: TestClient, teams: tuple[str, str]) -> None:
    """Workspace children survive their group in every team."""
    group = _workspace_label(client, "Type", is_group=True)
    child = _workspace_label(client, "Bug", parent_id=group["id"])
    assert client.delete(f"{BASE}/labels/{group['id']}").status_code == 204
    for team_id in teams:
        listed = _team_labels(client, team_id)
        assert group["id"] not in listed
        assert listed[child["id"]]["parent_id"] is None


def test_hiding_a_workspace_group_hides_its_children_in_that_team(client: TestClient, teams: tuple[str, str]) -> None:
    """A hidden group takes its children with it, in the hiding team only, and a reset brings both back."""
    group = _workspace_label(client, "Type", is_group=True)
    child = _workspace_label(client, "Bug", parent_id=group["id"])
    override = f"{BASE}/teams/{TEAM}/labels/{group['id']}/override"
    assert client.patch(override, json={"hidden": True}).status_code == 200
    visible = _team_labels(client, TEAM)
    assert group["id"] not in visible and child["id"] not in visible
    every = _team_labels(client, TEAM, include_hidden="true")
    assert every[child["id"]]["hidden"] is True
    assert child["id"] in _team_labels(client, OTHER)
    assert client.delete(override).status_code in (200, 204)
    assert child["id"] in _team_labels(client, TEAM)


def test_a_team_renames_an_inherited_group(client: TestClient, teams: tuple[str, str]) -> None:
    """A rename override on a group stays in that team."""
    group = _workspace_label(client, "Type", is_group=True)
    override = f"{BASE}/teams/{TEAM}/labels/{group['id']}/override"
    assert client.patch(override, json={"name": "Kind"}).status_code == 200
    assert _team_labels(client, TEAM)[group["id"]]["name"] == "Kind"
    assert _team_labels(client, OTHER)[group["id"]]["name"] == "Type"


def test_a_member_cannot_create_a_group(client: TestClient, teams: tuple[str, str]) -> None:
    """Group writes are held to team admin like any label write."""
    sign_in(client, MEMBER)
    response = client.post(f"{BASE}/teams/{TEAM}/labels", json={"name": "Area", "color": "#eb5757", "is_group": True})
    assert response.status_code == 403
