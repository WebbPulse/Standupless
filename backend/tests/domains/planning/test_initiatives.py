"""Initiatives: workspace-level groups of projects across teams.

The properties worth holding are that a guest is refused every initiative route,
that an initiative rolls up the progress and health of the projects in it, that a
project sits in at most one initiative and moves when added to another, that
deleting an initiative leaves its projects in place outside it, and that its
update feed mirrors health the way a project's does.
"""

from __future__ import annotations

import itertools
from datetime import UTC, datetime, timedelta
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.dynamodb import new_ulid

from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_member, make_user, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, WORKSPACE, seed_project

PEER = "01JB000000000000000000PEER"


@pytest.fixture
def peer(repositories: Any, workspace: str) -> str:
    """A second plain member, who neither created nor owns the initiatives under test."""
    add_member(repositories, WORKSPACE, PEER, "member")
    make_user(repositories, PEER, "peer@example.com", "Pat Peer")
    return PEER


@pytest.fixture(autouse=True)
def ordered_ids(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Mint ids a millisecond apart, so updates posted in one millisecond still sort in order."""
    start = datetime.now(UTC)
    counter = itertools.count()
    monkeypatch.setattr(
        "app.common.initiative_writes.new_planning_id",
        lambda: new_ulid(start + timedelta(milliseconds=next(counter))),
    )
    yield


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


def _add(client: TestClient, workspace: str, initiative_id: str, project_id: str) -> "dict[str, Any]":
    """Put a project in an initiative, failing loudly on a refusal."""
    response = client.put(f"{_base(workspace)}/{initiative_id}/projects/{project_id}")
    assert response.status_code == 200, response.text
    return response.json()


def test_a_member_creates_reads_and_patches_an_initiative(client: TestClient, workspace: str) -> None:
    """The fields round trip, and null clears the optional ones."""
    sign_in(client, MEMBER)
    created = _create(
        client, workspace, description="EU launch", owner_id=ADMIN, status="active", target_date="2026-12-01"
    )

    assert created["status"] == "active"
    assert created["owner_id"] == ADMIN
    assert created["created_by"] == MEMBER
    assert created["project_ids"] == []
    assert created["project_count"] == 0

    patched = client.patch(
        f"{_base(workspace)}/{created['initiative_id']}",
        json={"name": "Expand to the EU", "owner_id": None, "status": "completed", "target_date": None},
    )

    assert patched.status_code == 200, patched.text
    body = patched.json()
    assert body["name"] == "Expand to the EU"
    assert body["owner_id"] is None
    assert body["status"] == "completed"
    assert body["target_date"] is None
    assert body["description"] == "EU launch"


def test_name_and_status_cannot_be_cleared_and_the_owner_must_be_a_member(client: TestClient, workspace: str) -> None:
    """A null name or status, an unknown status or an outside owner is refused."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)["initiative_id"]
    path = f"{_base(workspace)}/{initiative_id}"

    assert client.patch(path, json={"name": None}).status_code == 422
    assert client.patch(path, json={"status": None}).status_code == 422
    assert client.patch(path, json={"status": "shipped"}).status_code == 422
    assert client.post(_base(workspace), json={"name": "X", "owner_id": "01JB000000000000000000NOPE"}).status_code == 422


def test_a_guest_is_refused_every_initiative_route(client: TestClient, workspace: str) -> None:
    """An initiative spans the workspace, so a guest sees none of it."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)["initiative_id"]
    project_id = seed_project(client, workspace)["project_id"]
    sign_in(client, GUEST)

    assert client.get(_base(workspace)).status_code == 403
    assert client.post(_base(workspace), json={"name": "Mine"}).status_code == 403
    assert client.get(f"{_base(workspace)}/{initiative_id}").status_code == 403
    assert client.patch(f"{_base(workspace)}/{initiative_id}", json={"name": "Y"}).status_code == 403
    assert client.put(f"{_base(workspace)}/{initiative_id}/projects/{project_id}").status_code == 403
    assert client.get(f"{_base(workspace)}/{initiative_id}/updates").status_code == 403
    assert client.get(f"/api/workspaces/{workspace}/projects", params={"initiative_id": initiative_id}).status_code == 403


def test_the_list_sorts_by_target_date_filters_by_status_and_pages(client: TestClient, workspace: str) -> None:
    """Dated initiatives come first by date, undated last, and a cursor resumes the list."""
    sign_in(client, MEMBER)
    _create(client, workspace, name="Undated")
    _create(client, workspace, name="Late", target_date="2027-03-01", status="active")
    _create(client, workspace, name="Early", target_date="2026-11-01", status="active")

    listed = client.get(_base(workspace)).json()
    assert [row["name"] for row in listed["initiatives"]] == ["Early", "Late", "Undated"]

    active = client.get(_base(workspace), params={"status": "active"}).json()
    assert [row["name"] for row in active["initiatives"]] == ["Early", "Late"]
    assert client.get(_base(workspace), params={"status": "nope"}).status_code == 422

    first = client.get(_base(workspace), params={"limit": 2}).json()
    assert len(first["initiatives"]) == 2
    second = client.get(_base(workspace), params={"limit": 2, "cursor": first["next_cursor"]}).json()
    assert [row["name"] for row in second["initiatives"]] == ["Undated"]
    assert second["next_cursor"] is None


def test_an_initiative_rolls_up_the_health_of_its_projects(client: TestClient, workspace: str) -> None:
    """Projects on different teams count together, tallied by health."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)["initiative_id"]
    first = seed_project(client, workspace, name="Billing", health="at_risk")["project_id"]
    second = seed_project(client, workspace, team_id=OTHER_TEAM, name="Docs")["project_id"]
    seed_project(client, workspace, name="Outside")

    assert _add(client, workspace, initiative_id, first)["initiative_id"] == initiative_id
    _add(client, workspace, initiative_id, second)

    body = _get(client, workspace, initiative_id)
    assert sorted(body["project_ids"]) == sorted([first, second])
    assert body["project_count"] == 2
    assert body["project_health"] == {"on_track": 0, "at_risk": 1, "off_track": 0, "none": 1}

    filtered = client.get(f"/api/workspaces/{workspace}/projects", params={"initiative_id": initiative_id}).json()
    assert sorted(row["project_id"] for row in filtered["projects"]) == sorted([first, second])


def test_a_project_moves_when_added_to_another_initiative(client: TestClient, workspace: str) -> None:
    """A project belongs to at most one initiative."""
    sign_in(client, MEMBER)
    one = _create(client, workspace, name="One")["initiative_id"]
    two = _create(client, workspace, name="Two")["initiative_id"]
    project_id = seed_project(client, workspace)["project_id"]

    _add(client, workspace, one, project_id)
    moved = _add(client, workspace, two, project_id)

    assert moved["initiative_id"] == two
    assert _get(client, workspace, one)["project_ids"] == []
    assert _get(client, workspace, two)["project_ids"] == [project_id]


def test_removing_a_project_needs_it_to_be_in_that_initiative(client: TestClient, workspace: str) -> None:
    """Removal from an initiative the project is not in is a 404 and changes nothing."""
    sign_in(client, MEMBER)
    one = _create(client, workspace, name="One")["initiative_id"]
    two = _create(client, workspace, name="Two")["initiative_id"]
    project_id = seed_project(client, workspace)["project_id"]
    _add(client, workspace, one, project_id)

    assert client.delete(f"{_base(workspace)}/{two}/projects/{project_id}").status_code == 404

    removed = client.delete(f"{_base(workspace)}/{one}/projects/{project_id}")
    assert removed.status_code == 200, removed.text
    assert removed.json()["initiative_id"] is None
    assert _get(client, workspace, one)["project_ids"] == []


def test_a_project_patch_sets_and_clears_its_initiative(client: TestClient, workspace: str) -> None:
    """The project form picks an initiative directly; an unknown one is refused."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)["initiative_id"]
    project_id = seed_project(client, workspace)["project_id"]
    path = f"/api/workspaces/{workspace}/projects/{project_id}"

    assert client.patch(path, json={"initiative_id": "01JB000000000000000000NOPE"}).status_code == 422
    assert client.patch(path, json={"initiative_id": initiative_id}).json()["initiative_id"] == initiative_id
    assert _get(client, workspace, initiative_id)["project_ids"] == [project_id]
    assert client.patch(path, json={"initiative_id": None}).json()["initiative_id"] is None

    created = seed_project(client, workspace, name="Born inside", initiative_id=initiative_id)
    assert created["initiative_id"] == initiative_id


def test_deleting_an_initiative_leaves_its_projects_outside_it(
    client: TestClient, workspace: str, peer: str
) -> None:
    """The projects survive with no initiative, and only the creator, owner or an admin may delete."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)["initiative_id"]
    project_id = seed_project(client, workspace)["project_id"]
    _add(client, workspace, initiative_id, project_id)
    client.post(f"{_base(workspace)}/{initiative_id}/updates", json={"body": "Fine", "health": "on_track"})

    sign_in(client, peer)
    assert client.delete(f"{_base(workspace)}/{initiative_id}").status_code == 403
    sign_in(client, ADMIN)
    response = client.delete(f"{_base(workspace)}/{initiative_id}")

    assert response.status_code == 204, response.text
    assert client.get(f"{_base(workspace)}/{initiative_id}").status_code == 404
    project = client.get(f"/api/workspaces/{workspace}/projects/{project_id}").json()
    assert project.get("initiative_id") is None


def test_the_update_feed_mirrors_health_and_falls_back_on_delete(client: TestClient, workspace: str) -> None:
    """The newest update sets the initiative's health; deleting it restores the one before."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)["initiative_id"]
    feed = f"{_base(workspace)}/{initiative_id}/updates"

    first = client.post(feed, json={"body": "Started", "health": "on_track"}).json()
    second = client.post(feed, json={"body": "Slipping", "health": "at_risk"}).json()

    assert first["can_edit"] is True
    assert _get(client, workspace, initiative_id)["health"] == "at_risk"
    listed = client.get(feed).json()
    assert [row["body"] for row in listed["updates"]] == ["Slipping", "Started"]

    edited = client.patch(f"{feed}/{second['update_id']}", json={"health": "off_track"})
    assert edited.status_code == 200, edited.text
    assert edited.json()["edited_at"] is not None
    assert _get(client, workspace, initiative_id)["health"] == "off_track"

    assert client.delete(f"{feed}/{second['update_id']}").status_code == 204
    body = _get(client, workspace, initiative_id)
    assert body["health"] == "on_track"
    assert body["last_update_at"] == first["created_at"]


def test_only_the_author_owner_or_an_admin_edits_an_update(client: TestClient, workspace: str, peer: str) -> None:
    """Another member reads the update without an edit right; the initiative's owner and an admin may edit."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace, owner_id=ADMIN)["initiative_id"]
    feed = f"{_base(workspace)}/{initiative_id}/updates"
    update = client.post(feed, json={"body": "Mine", "health": "on_track"}).json()

    sign_in(client, peer)
    assert client.get(feed).json()["updates"][0]["can_edit"] is False
    assert client.patch(f"{feed}/{update['update_id']}", json={"body": "Not mine"}).status_code == 403
    assert client.delete(f"{feed}/{update['update_id']}").status_code == 403

    sign_in(client, ADMIN)
    assert client.patch(f"{feed}/{update['update_id']}", json={"body": "Owner edit"}).status_code == 200
    sign_in(client, OWNER)
    assert client.get(feed).json()["updates"][0]["can_edit"] is True
