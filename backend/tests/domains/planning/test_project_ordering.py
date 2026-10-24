"""Manual project ordering: a workspace-wide fractional key every viewer shares.

The properties worth holding are that a new project lands ahead of every placed
one, that a drag writes one key that reads back for everyone, and that a key
outside the base 62 alphabet or a null one is refused.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import MEMBER, OWNER, sign_in
from tests.domains.planning.conftest import WORKSPACE, seed_project


def _path(workspace: str, project_id: str = "") -> str:
    """The project collection, or one project when an id is given."""
    base = f"/api/workspaces/{workspace}/projects"
    return f"{base}/{project_id}" if project_id else base


def _manual(client: TestClient, workspace: str) -> "list[str]":
    """The listed project names in manual order, placed keys first."""
    rows = client.get(_path(workspace)).json()["projects"]
    placed = sorted((row for row in rows if row["sort_order"]), key=lambda row: row["sort_order"])
    return [row["name"] for row in placed]


def test_each_new_project_is_placed_ahead_of_the_rest(client: TestClient, workspace: str) -> None:
    """Creating a project gives it a key that sorts before every existing key."""
    sign_in(client, MEMBER)

    first = seed_project(client, workspace, name="First")
    second = seed_project(client, workspace, name="Second")

    assert first["sort_order"] and second["sort_order"]
    assert second["sort_order"] < first["sort_order"]
    assert _manual(client, workspace) == ["Second", "First"]


def test_a_reorder_writes_one_key_that_every_viewer_reads(client: TestClient, workspace: str) -> None:
    """Patching `sort_order` moves the project for the next reader too."""
    sign_in(client, MEMBER)
    seed_project(client, workspace, name="Bottom")
    top = seed_project(client, workspace, name="Top")

    moved = client.patch(_path(workspace, top["project_id"]), json={"sort_order": "zz"})

    assert moved.status_code == 200
    assert moved.json()["sort_order"] == "zz"
    sign_in(client, OWNER)
    assert _manual(client, workspace) == ["Bottom", "Top"]
    assert client.get(_path(workspace, top["project_id"])).json()["sort_order"] == "zz"


def test_a_malformed_or_null_key_is_refused(client: TestClient, workspace: str) -> None:
    """Only 1 to 64 base 62 characters are a position, and a placed project stays placed."""
    sign_in(client, MEMBER)
    project = seed_project(client, workspace)

    for value in ("", "a-b", "x" * 65, None):
        response = client.patch(_path(workspace, project["project_id"]), json={"sort_order": value})
        assert response.status_code == 422, value


def test_a_project_stored_before_ordering_reads_unplaced(client: TestClient, repositories: Any, workspace: str) -> None:
    """A row without a key answers null, and the next new project still leads the placed ones."""
    sign_in(client, MEMBER)
    old = seed_project(client, workspace, name="Old")
    row = next(row for row in repositories.planning.list_projects(WORKSPACE) if row.project_id == old["project_id"])
    repositories.planning.replace_project(row.model_copy(update={"sort_order": None}))
    placed = seed_project(client, workspace, name="Placed")

    assert client.get(_path(workspace, old["project_id"])).json()["sort_order"] is None
    assert placed["sort_order"] == "V"
    newest = seed_project(client, workspace, name="Newest")
    assert newest["sort_order"] < placed["sort_order"]


def test_another_field_patch_keeps_the_key(client: TestClient, workspace: str) -> None:
    """The row is written whole, so editing a field leaves the position where it was."""
    sign_in(client, MEMBER)
    project = seed_project(client, workspace)

    renamed = client.patch(_path(workspace, project["project_id"]), json={"name": "Renamed"})

    assert renamed.json()["sort_order"] == project["sort_order"]
