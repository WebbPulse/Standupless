"""Project updates: the feed of health reports posted on one project.

The properties worth holding are that updates are reached only through a project
the caller can read, that they list newest first and page, that posting one sets
the project's health and `last_update_at`, that only the author or an admin edits
or deletes one, that deleting the newest falls the project back to the one before
it, and that deleting the project deletes its updates.
"""

from __future__ import annotations

import itertools
from datetime import UTC, datetime, timedelta
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.dynamodb import encode_start_key, new_ulid

from app.common.db.dynamo.planning import is_project_update, project_update_key
from app.common.project_updates import cursor_scope
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OUTSIDER, OWNER, add_team_member, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, TEAM, WORKSPACE, seed_project


@pytest.fixture(autouse=True)
def ordered_ids(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Mint ids a millisecond apart, so updates posted in one millisecond still sort in order."""
    start = datetime.now(UTC)
    counter = itertools.count()
    monkeypatch.setattr(
        "app.common.project_updates.new_planning_id",
        lambda: new_ulid(start + timedelta(milliseconds=next(counter))),
    )
    yield


def _path(workspace: str, project_id: str, update_id: str = "") -> str:
    """A project's update feed, or one update when an id is given."""
    base = f"/api/workspaces/{workspace}/projects/{project_id}/updates"
    return f"{base}/{update_id}" if update_id else base


def _post(client: TestClient, workspace: str, project_id: str, **payload: Any) -> "dict[str, Any]":
    """Post one update through the route, failing loudly on a refusal."""
    body: "dict[str, Any]" = {"body": "All good", "health": "on_track"}
    body.update(payload)
    response = client.post(_path(workspace, project_id), json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _project(client: TestClient, workspace: str, project_id: str) -> "dict[str, Any]":
    """One project as the API reads it."""
    response = client.get(f"/api/workspaces/{workspace}/projects/{project_id}")
    assert response.status_code == 200, response.text
    return response.json()


def test_posting_an_update_sets_the_projects_health_and_last_update(client: TestClient, workspace: str) -> None:
    """The project mirrors its newest update, which is what the progress panel reads."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    assert _project(client, workspace, project_id).get("last_update_at") is None

    update = _post(client, workspace, project_id, body="Slipping a week", health="at_risk")

    assert update["body"] == "Slipping a week"
    assert update["health"] == "at_risk"
    assert update["author_id"] == MEMBER
    assert update["project_id"] == project_id
    assert update["edited_at"] is None
    assert update["can_edit"] is True
    project = _project(client, workspace, project_id)
    assert project["health"] == "at_risk"
    assert project["last_update_at"] == update["created_at"]


def test_the_feed_lists_newest_first_and_pages(client: TestClient, workspace: str) -> None:
    """A cursor resumes the same feed, and the last page carries no cursor."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    for index in range(5):
        _post(client, workspace, project_id, body=f"Update {index}")

    first = client.get(_path(workspace, project_id), params={"limit": 2}).json()
    assert [row["body"] for row in first["updates"]] == ["Update 4", "Update 3"]
    assert first["next_cursor"]

    second = client.get(_path(workspace, project_id), params={"limit": 2, "cursor": first["next_cursor"]}).json()
    assert [row["body"] for row in second["updates"]] == ["Update 2", "Update 1"]

    third = client.get(_path(workspace, project_id), params={"limit": 2, "cursor": second["next_cursor"]}).json()
    assert [row["body"] for row in third["updates"]] == ["Update 0"]
    assert third["next_cursor"] is None


def test_a_cursor_from_another_project_starts_the_feed_over(client: TestClient, workspace: str) -> None:
    """The cursor is unsigned, so a key outside this project's prefix is ignored."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    other_id = seed_project(client, workspace, name="Other")["project_id"]
    _post(client, workspace, project_id, body="Mine")
    foreign = encode_start_key(
        {"workspace_id": WORKSPACE, "planning_key": project_update_key(other_id, "01JB0000000000000000000000")},
        scope=cursor_scope(WORKSPACE, project_id),
    )

    listed = client.get(_path(workspace, project_id), params={"cursor": foreign}).json()

    assert [row["body"] for row in listed["updates"]] == ["Mine"]


def test_an_update_needs_a_body_and_a_health(client: TestClient, workspace: str) -> None:
    """A blank body, a missing health or an unknown health is refused."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]

    assert client.post(_path(workspace, project_id), json={"body": "  ", "health": "on_track"}).status_code == 422
    assert client.post(_path(workspace, project_id), json={"body": "Fine"}).status_code == 422
    assert client.post(_path(workspace, project_id), json={"body": "Fine", "health": "great"}).status_code == 422
    assert (
        client.post(_path(workspace, project_id), json={"body": "x" * 20000, "health": "on_track"}).status_code == 422
    )


def test_the_author_edits_an_update_and_it_is_marked_edited(client: TestClient, workspace: str) -> None:
    """An edit keeps the post time and stamps `edited_at`; a health change on the newest moves the project."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    update = _post(client, workspace, project_id)
    path = _path(workspace, project_id, update["update_id"])

    edited = client.patch(path, json={"body": "Actually off", "health": "off_track"})

    assert edited.status_code == 200, edited.text
    assert edited.json()["body"] == "Actually off"
    assert edited.json()["created_at"] == update["created_at"]
    assert edited.json()["edited_at"] is not None
    assert _project(client, workspace, project_id)["health"] == "off_track"
    assert client.patch(path, json={"body": None}).status_code == 422
    assert client.patch(path, json={"health": None}).status_code == 422


def test_editing_an_older_update_leaves_the_projects_health(client: TestClient, workspace: str) -> None:
    """Only the newest update is mirrored onto the project."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    older = _post(client, workspace, project_id, health="on_track")
    _post(client, workspace, project_id, health="at_risk")

    assert (
        client.patch(_path(workspace, project_id, older["update_id"]), json={"health": "off_track"}).status_code == 200
    )

    assert _project(client, workspace, project_id)["health"] == "at_risk"


def test_only_the_author_or_an_admin_edits_or_deletes(client: TestClient, repositories: Any, workspace: str) -> None:
    """Another writer sees the update but may not change it; admins moderate."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    update = _post(client, workspace, project_id)
    path = _path(workspace, project_id, update["update_id"])

    sign_in(client, GUEST)
    listed = client.get(_path(workspace, project_id)).json()["updates"]
    assert [row["can_edit"] for row in listed] == [False]
    assert client.patch(path, json={"body": "Mine now"}).status_code == 403
    assert client.delete(path).status_code == 403

    add_team_member(repositories, WORKSPACE, TEAM, GUEST, "admin")
    assert client.get(_path(workspace, project_id)).json()["updates"][0]["can_edit"] is True
    assert client.patch(path, json={"body": "Moderated"}).status_code == 200

    sign_in(client, ADMIN)
    assert client.delete(path).status_code == 204
    assert client.get(_path(workspace, project_id)).json()["updates"] == []


def test_deleting_the_newest_update_falls_back_to_the_one_before(client: TestClient, workspace: str) -> None:
    """The project mirrors the previous update, and keeps its health once none is left."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    first = _post(client, workspace, project_id, health="at_risk")
    second = _post(client, workspace, project_id, health="off_track")

    assert client.delete(_path(workspace, project_id, second["update_id"])).status_code == 204
    project = _project(client, workspace, project_id)
    assert project["health"] == "at_risk"
    assert project["last_update_at"] == first["created_at"]

    assert client.delete(_path(workspace, project_id, first["update_id"])).status_code == 204
    project = _project(client, workspace, project_id)
    assert project["health"] == "at_risk"
    assert project.get("last_update_at") is None


def test_deleting_an_older_update_leaves_the_project(client: TestClient, workspace: str) -> None:
    """Removing a report that is not the newest changes nothing the project mirrors."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    first = _post(client, workspace, project_id, health="at_risk")
    second = _post(client, workspace, project_id, health="off_track")

    assert client.delete(_path(workspace, project_id, first["update_id"])).status_code == 204

    project = _project(client, workspace, project_id)
    assert project["health"] == "off_track"
    assert project["last_update_at"] == second["created_at"]


def test_a_hidden_or_unknown_project_or_update_is_a_404(client: TestClient, workspace: str) -> None:
    """Updates follow the project's visibility, and a missing update is not found."""
    sign_in(client, OWNER)
    hidden = seed_project(client, workspace, team_id=OTHER_TEAM)["project_id"]
    update = _post(client, workspace, hidden)
    nope = "01JB0000000000000000NOPE01"
    assert client.patch(_path(workspace, hidden, nope), json={"body": "X"}).status_code == 404
    assert client.delete(_path(workspace, hidden, nope)).status_code == 404

    sign_in(client, GUEST)
    assert client.get(_path(workspace, hidden)).status_code == 404
    assert client.post(_path(workspace, hidden), json={"body": "X", "health": "on_track"}).status_code == 404
    assert client.patch(_path(workspace, hidden, update["update_id"]), json={"body": "X"}).status_code == 404
    assert client.delete(_path(workspace, hidden, update["update_id"])).status_code == 404

    sign_in(client, OUTSIDER)
    assert client.get(_path(workspace, hidden)).status_code == 404


def test_deleting_a_project_deletes_its_updates(client: TestClient, repositories: Any, workspace: str) -> None:
    """No update row outlives its project."""
    sign_in(client, OWNER)
    project_id = seed_project(client, workspace)["project_id"]
    _post(client, workspace, project_id)
    _post(client, workspace, project_id, health="at_risk")

    assert client.delete(f"/api/workspaces/{workspace}/projects/{project_id}").status_code == 204

    rows, _ = repositories.planning.list_project_updates(WORKSPACE, project_id, limit=50, start_key=None)
    assert rows == []


def test_the_project_listing_is_not_polluted_by_updates(client: TestClient, repositories: Any, workspace: str) -> None:
    """Update rows share the table but not the project prefix, and are told apart by kind."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    update = _post(client, workspace, project_id)

    projects = client.get(f"/api/workspaces/{workspace}/projects").json()["projects"]

    assert [row["project_id"] for row in projects] == [project_id]
    row = repositories.planning.get_project_update(WORKSPACE, project_id, update["update_id"])
    assert row is not None
    assert is_project_update({"kind": row.kind})


def test_an_update_records_the_client_it_came_through(client: TestClient, workspace: str) -> None:
    """A browser post is the web source and an API key post is the api source."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    by_browser = _post(client, workspace, project_id, body="From the page")
    sign_in(client, MEMBER, actor_kind="api_key", tenant_id=workspace, scope="projects:read projects:write")
    by_key = _post(client, workspace, project_id, body="From a script")

    assert by_browser["source"] == "web"
    assert by_key["source"] == "api"
