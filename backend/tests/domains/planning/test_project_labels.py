"""Project labels, the workspace's one set of labels for projects, and the short project id.

The properties worth holding are that any reader lists project labels while only
an admin changes them, that names are unique ignoring case, that a project only
carries labels that exist, that the list filters by label, that counts follow
what the caller can see, that a deleted label leaves every project, and that a
project answers a short id.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, GUEST, MEMBER, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, seed_project


def _base(workspace: str) -> str:
    """The workspace's project label root."""
    return f"/api/workspaces/{workspace}/project-labels"


def _label(client: TestClient, workspace: str, **payload: Any) -> "dict[str, Any]":
    """Create one project label through the route, failing loudly on a refusal."""
    body: "dict[str, Any]" = {"name": "Q3", "color": "#5E6AD2"}
    body.update(payload)
    response = client.post(_base(workspace), json=body)
    assert response.status_code == 201, response.text
    return response.json()


def test_a_project_label_round_trips(client: TestClient, workspace: str) -> None:
    """Create, list, edit and delete, with the colour normalised."""
    sign_in(client, ADMIN)
    created = _label(client, workspace, name="  Q3  ", description="Third quarter")
    assert (created["name"], created["color"], created["description"]) == ("Q3", "#5e6ad2", "Third quarter")

    listed = client.get(_base(workspace)).json()["labels"]
    assert [row["id"] for row in listed] == [created["id"]]

    edited = client.patch(f"{_base(workspace)}/{created['id']}", json={"name": "Q4", "description": ""})
    assert edited.status_code == 200, edited.text
    assert (edited.json()["name"], edited.json()["description"]) == ("Q4", None)

    assert client.delete(f"{_base(workspace)}/{created['id']}").status_code == 204
    assert client.get(_base(workspace)).json()["labels"] == []
    assert client.patch(f"{_base(workspace)}/{created['id']}", json={"name": "Q5"}).status_code == 404


def test_only_an_admin_changes_project_labels(client: TestClient, workspace: str) -> None:
    """A member and a guest read the labels and are refused every write."""
    sign_in(client, ADMIN)
    label = _label(client, workspace)
    for subject in (MEMBER, GUEST):
        sign_in(client, subject)
        assert client.get(_base(workspace)).status_code == 200
        assert client.post(_base(workspace), json={"name": "X", "color": "#000000"}).status_code == 403
        assert client.patch(f"{_base(workspace)}/{label['id']}", json={"name": "Y"}).status_code == 403
        assert client.delete(f"{_base(workspace)}/{label['id']}").status_code == 403


def test_project_label_names_are_unique_ignoring_case(client: TestClient, workspace: str) -> None:
    """A second label of the same name, or a rename onto one, answers 409."""
    sign_in(client, ADMIN)
    _label(client, workspace, name="Growth")
    other = _label(client, workspace, name="Infra")
    assert client.post(_base(workspace), json={"name": "growth", "color": "#000000"}).status_code == 409
    assert client.patch(f"{_base(workspace)}/{other['id']}", json={"name": "GROWTH"}).status_code == 409
    assert client.patch(f"{_base(workspace)}/{other['id']}", json={"name": "infra"}).status_code == 200


def test_project_label_input_is_checked(client: TestClient, workspace: str) -> None:
    """A blank name and a malformed colour are refused."""
    sign_in(client, ADMIN)
    assert client.post(_base(workspace), json={"name": " ", "color": "#000000"}).status_code == 422
    assert client.post(_base(workspace), json={"name": "Q3", "color": "red"}).status_code == 422


def test_a_project_carries_existing_labels(client: TestClient, workspace: str) -> None:
    """Labels set on create and patch, repeats dropped, an unknown one and null refused."""
    sign_in(client, ADMIN)
    first = _label(client, workspace, name="Growth")
    second = _label(client, workspace, name="Infra")
    project = seed_project(client, workspace, label_ids=[first["id"]])
    assert project["label_ids"] == [first["id"]]

    url = f"/api/workspaces/{workspace}/projects/{project['project_id']}"
    patched = client.patch(url, json={"label_ids": [second["id"], first["id"]]})
    assert patched.status_code == 200, patched.text
    assert patched.json()["label_ids"] == [second["id"], first["id"]]

    assert client.patch(url, json={"label_ids": ["01JB0000000000000000NOPE00"]}).status_code == 422
    assert client.patch(url, json={"label_ids": None}).status_code == 422
    assert client.patch(url, json={"label_ids": [first["id"], first["id"]]}).json()["label_ids"] == [first["id"]]
    response = client.post(
        f"/api/workspaces/{workspace}/projects", json={"team_id": OTHER_TEAM, "name": "X", "label_ids": ["nope"]}
    )
    assert response.status_code == 422


def test_the_list_filters_by_label(client: TestClient, workspace: str) -> None:
    """`label_id` keeps projects carrying any named label, `none` the unlabelled ones."""
    sign_in(client, ADMIN)
    growth = _label(client, workspace, name="Growth")
    infra = _label(client, workspace, name="Infra")
    tagged = seed_project(client, workspace, name="Tagged", label_ids=[growth["id"]])
    both = seed_project(client, workspace, name="Both", label_ids=[growth["id"], infra["id"]])
    plain = seed_project(client, workspace, name="Plain")

    def names(*values: str) -> set[str]:
        """The project names the list answers for these label filter values."""
        response = client.get(f"/api/workspaces/{workspace}/projects", params={"label_id": list(values)})
        assert response.status_code == 200, response.text
        return {row["name"] for row in response.json()["projects"]}

    assert names(growth["id"]) == {tagged["name"], both["name"]}
    assert names(infra["id"]) == {both["name"]}
    assert names("none") == {plain["name"]}
    assert names("none", infra["id"]) == {plain["name"], both["name"]}


def test_counts_follow_what_the_caller_can_see(client: TestClient, workspace: str) -> None:
    """A guest's count leaves out the projects on a team it cannot see."""
    sign_in(client, ADMIN)
    label = _label(client, workspace)
    seed_project(client, workspace, label_ids=[label["id"]])
    seed_project(client, workspace, team_id=OTHER_TEAM, label_ids=[label["id"]])
    assert client.get(_base(workspace)).json()["labels"][0]["project_count"] == 2

    sign_in(client, GUEST)
    assert client.get(_base(workspace)).json()["labels"][0]["project_count"] == 1


def test_a_deleted_label_leaves_every_project(client: TestClient, workspace: str) -> None:
    """Deleting a label strips it from the projects that carried it."""
    sign_in(client, ADMIN)
    gone = _label(client, workspace, name="Gone")
    kept = _label(client, workspace, name="Kept")
    project = seed_project(client, workspace, label_ids=[gone["id"], kept["id"]])
    assert client.delete(f"{_base(workspace)}/{gone['id']}").status_code == 204
    read = client.get(f"/api/workspaces/{workspace}/projects/{project['project_id']}").json()
    assert read["label_ids"] == [kept["id"]]


def test_a_project_answers_a_short_id(client: TestClient, workspace: str) -> None:
    """The short id is the lowercased tail of the project id."""
    sign_in(client, ADMIN)
    project = seed_project(client, workspace)
    assert project["slug_id"] == project["project_id"][-8:].lower()
