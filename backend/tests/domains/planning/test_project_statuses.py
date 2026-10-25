"""Project statuses, the workspace's own stages inside the six fixed project status categories.

The properties worth holding are that a workspace reads six seeded defaults whose
ids are the categories, that an existing project needs no migration, that only an
admin edits the set, that a status keeps its category, that a project takes a
status by id and a bare category lands on the category's default, that the list
filters by status or by category, and that deleting a status moves its projects
onto a replacement in the same category while each category keeps one status.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.planning import PROJECT_STATUSES
from tests.domains.helpers import ADMIN, GUEST, MEMBER, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, WORKSPACE, seed_project


def _base(workspace: str) -> str:
    """The workspace's project status root."""
    return f"/api/workspaces/{workspace}/project-statuses"


def _projects(workspace: str, project_id: str = "") -> str:
    """The project collection, or one project when an id is given."""
    base = f"/api/workspaces/{workspace}/projects"
    return f"{base}/{project_id}" if project_id else base


def _status(client: TestClient, workspace: str, **payload: Any) -> "dict[str, Any]":
    """Create one project status through the route, failing loudly on a refusal."""
    body: "dict[str, Any]" = {"name": "In review", "category": "in_progress"}
    body.update(payload)
    response = client.post(_base(workspace), json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _listed(client: TestClient, workspace: str) -> "list[dict[str, Any]]":
    """The workspace's project statuses as the list route answers them."""
    response = client.get(_base(workspace))
    assert response.status_code == 200, response.text
    return response.json()["statuses"]


def test_a_workspace_reads_the_six_seeded_defaults(client: TestClient, repositories: Any, workspace: str) -> None:
    """Before any edit the list is the six categories, each its own default, and nothing is stored."""
    sign_in(client, MEMBER)

    listed = _listed(client, workspace)

    assert [row["id"] for row in listed] == list(PROJECT_STATUSES)
    assert [row["category"] for row in listed] == list(PROJECT_STATUSES)
    assert [row["name"] for row in listed] == ["Backlog", "Planned", "In progress", "Paused", "Completed", "Canceled"]
    assert all(row["is_default"] for row in listed)
    assert repositories.planning.list_project_statuses(WORKSPACE) == []


def test_an_existing_project_sits_in_its_category_default(client: TestClient, workspace: str) -> None:
    """A project made with a bare category answers that category's seeded status id."""
    sign_in(client, MEMBER)

    project = seed_project(client, workspace, status="planned")

    assert (project["status"], project["status_id"]) == ("planned", "planned")
    counted = {row["id"]: row["project_count"] for row in _listed(client, workspace)}
    assert counted["planned"] == 1


def test_only_an_admin_changes_project_statuses(client: TestClient, workspace: str) -> None:
    """A member and a guest read the statuses and are refused every write."""
    for subject in (MEMBER, GUEST):
        sign_in(client, subject)
        assert client.get(_base(workspace)).status_code == 200
        assert client.post(_base(workspace), json={"name": "X", "category": "planned"}).status_code == 403
        assert client.patch(f"{_base(workspace)}/planned", json={"name": "Y"}).status_code == 403
        assert client.delete(f"{_base(workspace)}/planned").status_code == 403


def test_a_status_is_added_renamed_recoloured_and_reordered(client: TestClient, workspace: str) -> None:
    """A new status lands last in its category, and a patch renames, recolours and moves it."""
    sign_in(client, ADMIN)

    review = _status(client, workspace, color="#5E6AD2")
    assert (review["category"], review["position"], review["color"]) == ("in_progress", 1, "#5e6ad2")
    assert review["is_default"] is False

    moved = client.patch(f"{_base(workspace)}/{review['id']}", json={"name": "Reviewing", "position": 0, "color": None})
    assert moved.status_code == 200, moved.text
    assert (moved.json()["name"], moved.json()["position"], moved.json()["color"]) == ("Reviewing", 0, None)

    started = [row for row in _listed(client, workspace) if row["category"] == "in_progress"]
    assert [row["id"] for row in started] == [review["id"], "in_progress"]
    assert [row["position"] for row in started] == [0, 1]
    assert next(row for row in started if row["id"] == "in_progress")["is_default"] is True

    renamed = client.patch(f"{_base(workspace)}/in_progress", json={"name": "Building"})
    assert renamed.json()["name"] == "Building"
    assert renamed.json()["category"] == "in_progress"


def test_project_status_names_are_unique_and_input_is_checked(client: TestClient, workspace: str) -> None:
    """A taken name answers 409, and a blank name, unknown category or bad colour 422."""
    sign_in(client, ADMIN)
    _status(client, workspace, name="Shaping", category="planned")

    assert client.post(_base(workspace), json={"name": "shaping", "category": "backlog"}).status_code == 409
    assert client.post(_base(workspace), json={"name": "PLANNED", "category": "backlog"}).status_code == 409
    assert client.post(_base(workspace), json={"name": " ", "category": "backlog"}).status_code == 422
    assert client.post(_base(workspace), json={"name": "X", "category": "started"}).status_code == 422
    assert client.post(_base(workspace), json={"name": "X", "category": "planned", "color": "red"}).status_code == 422
    assert client.patch(f"{_base(workspace)}/nope", json={"name": "Y"}).status_code == 404


def test_a_project_takes_a_status_by_id_and_a_category_lands_on_its_default(client: TestClient, workspace: str) -> None:
    """`status_id` sets the status and its category; a bare category keeps a status already in it."""
    sign_in(client, ADMIN)
    review = _status(client, workspace)

    project = seed_project(client, workspace, status_id=review["id"])
    assert (project["status"], project["status_id"]) == ("in_progress", review["id"])

    url = _projects(workspace, project["project_id"])
    kept = client.patch(url, json={"status": "in_progress"})
    assert kept.json()["status_id"] == review["id"]

    paused = client.patch(url, json={"status": "paused"})
    assert (paused.json()["status"], paused.json()["status_id"]) == ("paused", "paused")

    back = client.patch(url, json={"status_id": review["id"]})
    assert (back.json()["status"], back.json()["status_id"]) == ("in_progress", review["id"])

    assert client.patch(url, json={"status_id": "01JB0000000000000000NOPE00"}).status_code == 422
    assert client.patch(url, json={"status_id": review["id"], "status": "planned"}).status_code == 422
    assert client.patch(url, json={"status_id": None}).status_code == 422


def test_closing_through_a_custom_completed_status_stamps_completion(client: TestClient, workspace: str) -> None:
    """A custom status in the completed category closes the project as the seeded one does."""
    sign_in(client, ADMIN)
    shipped = _status(client, workspace, name="Shipped", category="completed")
    project = seed_project(client, workspace)

    closed = client.patch(_projects(workspace, project["project_id"]), json={"status_id": shipped["id"]})

    assert closed.status_code == 200, closed.text
    assert closed.json()["status"] == "completed"
    assert closed.json()["completed_at"] is not None


def test_the_list_filters_by_status_or_by_category(client: TestClient, workspace: str) -> None:
    """A status id keeps the projects in it, a seeded one too; an alias or `category:` keeps the whole category."""
    sign_in(client, ADMIN)
    review = _status(client, workspace)
    seed_project(client, workspace, name="Reviewing", status_id=review["id"])
    seed_project(client, workspace, name="Building", status="in_progress")
    seed_project(client, workspace, name="Waiting", status="planned")

    def names(value: str) -> set[str]:
        """The project names the list answers for one status filter."""
        response = client.get(_projects(workspace), params={"status": value})
        assert response.status_code == 200, response.text
        return {row["name"] for row in response.json()["projects"]}

    assert names(review["id"]) == {"Reviewing"}
    assert names("in_progress") == {"Building"}
    assert names("category:in_progress") == {"Reviewing", "Building"}
    assert names("started") == {"Reviewing", "Building"}
    assert names("planned") == {"Waiting"}
    assert client.get(_projects(workspace), params={"status": "category:nope"}).status_code == 422
    assert client.get(_projects(workspace), params={"status": "someday"}).status_code == 422


def test_deleting_a_status_moves_its_projects_onto_the_replacement(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """Projects in a deleted status land on the named replacement, or the category's first other status."""
    sign_in(client, ADMIN)
    review = _status(client, workspace)
    qa = _status(client, workspace, name="QA")
    seeded = seed_project(client, workspace, name="Seeded", status="in_progress")
    custom = seed_project(client, workspace, name="Custom", status_id=review["id"])
    hidden = seed_project(client, workspace, name="Hidden", team_id=OTHER_TEAM, status="in_progress")

    gone = client.delete(f"{_base(workspace)}/in_progress", params={"replacement_status_id": qa["id"]})
    assert gone.status_code == 204, gone.text
    for project in (seeded, hidden):
        row = repositories.planning.get_project(WORKSPACE, project["project_id"])
        assert (row.status, row.status_id) == ("in_progress", qa["id"])

    assert client.delete(f"{_base(workspace)}/{review['id']}").status_code == 204
    moved = client.get(_projects(workspace, custom["project_id"])).json()
    assert (moved["status"], moved["status_id"]) == ("in_progress", qa["id"])

    started = [row for row in _listed(client, workspace) if row["category"] == "in_progress"]
    assert [(row["id"], row["position"], row["is_default"]) for row in started] == [(qa["id"], 0, True)]

    later = client.patch(_projects(workspace, custom["project_id"]), json={"status": "paused"}).json()
    assert later["status_id"] == "paused"
    back = client.patch(_projects(workspace, custom["project_id"]), json={"status": "in_progress"}).json()
    assert back["status_id"] == qa["id"]


def test_a_category_keeps_at_least_one_status_and_a_replacement_stays_in_it(client: TestClient, workspace: str) -> None:
    """The last status of a category cannot go, nor can a replacement from another category be named."""
    sign_in(client, ADMIN)
    shaping = _status(client, workspace, name="Shaping", category="planned")

    assert client.delete(f"{_base(workspace)}/backlog").status_code == 422
    other = client.delete(f"{_base(workspace)}/planned", params={"replacement_status_id": "backlog"})
    assert other.status_code == 422
    assert client.delete(f"{_base(workspace)}/nope").status_code == 404
    assert (
        client.delete(f"{_base(workspace)}/planned", params={"replacement_status_id": shaping["id"]}).status_code == 204
    )
    assert client.delete(f"{_base(workspace)}/{shaping['id']}").status_code == 422


def test_a_status_change_is_recorded_by_status_id(client: TestClient, workspace: str) -> None:
    """The activity feed names the statuses a project moved between."""
    sign_in(client, ADMIN)
    review = _status(client, workspace)
    project = seed_project(client, workspace, status="in_progress")

    client.patch(_projects(workspace, project["project_id"]), json={"status_id": review["id"]})
    feed = client.get(f"{_projects(workspace, project['project_id'])}/activity")

    assert feed.status_code == 200, feed.text
    changes = [row for row in feed.json()["activity"] if row.get("field") == "status"]
    assert [(row["from"], row["to"]) for row in changes] == [("in_progress", review["id"])]
