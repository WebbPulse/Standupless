"""Project labels and project statuses a team keeps beside the workspace's.

The properties worth holding are that a team admin changes their own team's
entries and nothing else, that a list answers the workspace's entries with one
team's or every team's the caller finds, that a name is unique among the entries
a project could be offered together, that a project is offered the workspace's
entries and its own teams' only, that a team status never becomes a category's
default nor touches the stored workspace set, and that deleting a team status
moves its projects onto the workspace default of its category.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, GUEST, MEMBER, add_team_member, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, TEAM, WORKSPACE, seed_project


def _labels(workspace: str) -> str:
    """The workspace's project label root."""
    return f"/api/workspaces/{workspace}/project-labels"


def _statuses(workspace: str) -> str:
    """The workspace's project status root."""
    return f"/api/workspaces/{workspace}/project-statuses"


def _projects(workspace: str, project_id: str = "") -> str:
    """The project collection, or one project when an id is given."""
    base = f"/api/workspaces/{workspace}/projects"
    return f"{base}/{project_id}" if project_id else base


def _created(client: TestClient, url: str, body: "dict[str, Any]") -> "dict[str, Any]":
    """Create one row through a route, failing loudly on a refusal."""
    response = client.post(url, json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _team_admin(repositories: Any) -> None:
    """Make the workspace member an admin of `TEAM` alone."""
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "admin")


def test_a_team_admin_manages_their_teams_project_labels_only(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A team admin adds, renames and deletes their team's label, and is refused the workspace's and another team's."""
    _team_admin(repositories)
    sign_in(client, ADMIN)
    shared = _created(client, _labels(workspace), {"name": "Shared", "color": "#5e6ad2"})
    sign_in(client, MEMBER)

    own = _created(client, _labels(workspace), {"name": "Mobile", "color": "#5e6ad2", "team_id": TEAM})
    renamed = client.patch(f"{_labels(workspace)}/{own['id']}", json={"name": "iOS"})

    assert own["team_id"] == TEAM
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "iOS"
    assert client.post(_labels(workspace), json={"name": "X", "color": "#000000"}).status_code == 403
    other = client.post(_labels(workspace), json={"name": "X", "color": "#000000", "team_id": OTHER_TEAM})
    assert other.status_code == 403
    assert client.patch(f"{_labels(workspace)}/{shared['id']}", json={"name": "Y"}).status_code == 403
    assert client.delete(f"{_labels(workspace)}/{shared['id']}").status_code == 403
    assert client.delete(f"{_labels(workspace)}/{own['id']}").status_code == 204

    sign_in(client, GUEST)
    refused = client.post(_labels(workspace), json={"name": "Z", "color": "#000000", "team_id": TEAM})
    assert refused.status_code == 403


def test_a_label_list_answers_the_workspace_with_one_or_every_team(client: TestClient, workspace: str) -> None:
    """Without a team every findable team's labels come back; with one only that team's join the workspace's."""
    sign_in(client, ADMIN)
    shared = _created(client, _labels(workspace), {"name": "Shared", "color": "#5e6ad2"})
    mine = _created(client, _labels(workspace), {"name": "Mine", "color": "#5e6ad2", "team_id": TEAM})
    theirs = _created(client, _labels(workspace), {"name": "Theirs", "color": "#5e6ad2", "team_id": OTHER_TEAM})

    def ids(**params: str) -> "set[str]":
        response = client.get(_labels(workspace), params=params)
        assert response.status_code == 200, response.text
        return {row["id"] for row in response.json()["labels"]}

    assert ids() == {shared["id"], mine["id"], theirs["id"]}
    assert ids(team_id=TEAM) == {shared["id"], mine["id"]}
    assert client.get(_labels(workspace), params={"team_id": "nope"}).status_code == 404

    sign_in(client, GUEST)
    assert ids() == {shared["id"], mine["id"]}
    assert client.get(_labels(workspace), params={"team_id": OTHER_TEAM}).status_code == 404


def test_label_names_are_unique_within_what_a_project_is_offered(client: TestClient, workspace: str) -> None:
    """Two teams may share a name, but neither may repeat a workspace label, nor the workspace a team's."""
    sign_in(client, ADMIN)
    _created(client, _labels(workspace), {"name": "Shared", "color": "#5e6ad2"})
    _created(client, _labels(workspace), {"name": "Growth", "color": "#5e6ad2", "team_id": TEAM})
    _created(client, _labels(workspace), {"name": "growth", "color": "#5e6ad2", "team_id": OTHER_TEAM})

    clash = client.post(_labels(workspace), json={"name": "shared", "color": "#000000", "team_id": TEAM})
    taken = client.post(_labels(workspace), json={"name": "GROWTH", "color": "#000000"})

    assert clash.status_code == 409
    assert taken.status_code == 409


def test_a_project_carries_only_labels_its_teams_are_offered(client: TestClient, workspace: str) -> None:
    """A project takes the workspace's labels and its own teams', and refuses another team's as unknown."""
    sign_in(client, ADMIN)
    shared = _created(client, _labels(workspace), {"name": "Shared", "color": "#5e6ad2"})
    mine = _created(client, _labels(workspace), {"name": "Mine", "color": "#5e6ad2", "team_id": TEAM})
    theirs = _created(client, _labels(workspace), {"name": "Theirs", "color": "#5e6ad2", "team_id": OTHER_TEAM})

    project = seed_project(client, workspace, label_ids=[shared["id"], mine["id"]])
    refused = client.post(_projects(workspace), json={"team_id": TEAM, "name": "X", "label_ids": [theirs["id"]]})
    patched = client.patch(_projects(workspace, project["project_id"]), json={"label_ids": [theirs["id"]]})
    widened = client.patch(
        _projects(workspace, project["project_id"]),
        json={"team_ids": [TEAM, OTHER_TEAM], "label_ids": [mine["id"], theirs["id"]]},
    )
    filtered = client.get(_projects(workspace), params={"label_id": mine["id"]}).json()

    assert set(project["label_ids"]) == {shared["id"], mine["id"]}
    assert refused.status_code == 422
    assert patched.status_code == 422
    assert widened.status_code == 200, widened.text
    assert set(widened.json()["label_ids"]) == {mine["id"], theirs["id"]}
    assert [row["project_id"] for row in filtered["projects"]] == [project["project_id"]]


def test_a_team_status_stands_beside_the_workspace_defaults(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A team admin's status leaves the seeded set unstored, is never a default and is numbered on its own."""
    _team_admin(repositories)
    sign_in(client, MEMBER)

    review = _created(client, _statuses(workspace), {"name": "In review", "category": "in_progress", "team_id": TEAM})
    qa = _created(client, _statuses(workspace), {"name": "QA", "category": "in_progress", "team_id": TEAM})
    workspace_write = client.post(_statuses(workspace), json={"name": "X", "category": "planned"})
    other_team = client.post(_statuses(workspace), json={"name": "X", "category": "planned", "team_id": OTHER_TEAM})
    clash = client.post(_statuses(workspace), json={"name": "planned", "category": "planned", "team_id": TEAM})
    moved = client.patch(f"{_statuses(workspace)}/{qa['id']}", json={"position": 0})

    stored = repositories.planning.list_project_statuses(WORKSPACE)
    assert {row.status_id for row in stored} == {review["id"], qa["id"]}
    assert (review["team_id"], review["position"], review["is_default"]) == (TEAM, 0, False)
    assert workspace_write.status_code == 403
    assert other_team.status_code == 403
    assert clash.status_code == 409
    assert moved.status_code == 200, moved.text

    listed = client.get(_statuses(workspace), params={"team_id": TEAM}).json()["statuses"]
    started = [(row["id"], row["position"], row["is_default"]) for row in listed if row["category"] == "in_progress"]
    assert started == [("in_progress", 0, True), (qa["id"], 0, False), (review["id"], 1, False)]


def test_a_project_takes_only_statuses_its_teams_are_offered(client: TestClient, workspace: str) -> None:
    """A team status lands on a project of that team and is refused for a project on another."""
    sign_in(client, ADMIN)
    review = _created(client, _statuses(workspace), {"name": "In review", "category": "in_progress", "team_id": TEAM})

    project = seed_project(client, workspace, status_id=review["id"])
    refused = client.post(_projects(workspace), json={"team_id": OTHER_TEAM, "name": "X", "status_id": review["id"]})
    bare = seed_project(client, workspace, name="Bare", status="in_progress")
    filtered = client.get(_projects(workspace), params={"status": review["id"]}).json()

    assert (project["status"], project["status_id"]) == ("in_progress", review["id"])
    assert refused.status_code == 422
    assert bare["status_id"] == "in_progress"
    assert [row["project_id"] for row in filtered["projects"]] == [project["project_id"]]


def test_deleting_a_team_status_moves_its_projects_to_the_workspace_default(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """The projects in a deleted team status land on the workspace default of the category."""
    sign_in(client, ADMIN)
    shaping = _created(client, _statuses(workspace), {"name": "Shaping", "category": "planned"})
    review = _created(client, _statuses(workspace), {"name": "In review", "category": "planned", "team_id": TEAM})
    project = seed_project(client, workspace, status_id=review["id"])

    elsewhere = client.delete(f"{_statuses(workspace)}/{review['id']}", params={"replacement_status_id": "in_progress"})
    gone = client.delete(f"{_statuses(workspace)}/{review['id']}")

    assert elsewhere.status_code == 422
    assert gone.status_code == 204, gone.text
    row = repositories.planning.get_project(WORKSPACE, project["project_id"])
    assert (row.status, row.status_id) == ("planned", "planned")
    assert shaping["id"] in {status.status_id for status in repositories.planning.list_project_statuses(WORKSPACE)}
