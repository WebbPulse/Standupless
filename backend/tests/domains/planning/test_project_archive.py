"""Archiving and restoring a project: hidden from the list by default, readable, restorable and recorded."""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.domains.helpers import GUEST, MEMBER, OWNER, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, seed_project


def _path(workspace: str, project_id: str = "", action: str = "") -> str:
    """The project collection, one project, or one of its archive actions."""
    base = f"/api/workspaces/{workspace}/projects"
    if not project_id:
        return base
    return f"{base}/{project_id}/{action}" if action else f"{base}/{project_id}"


def test_an_archived_project_leaves_the_list_but_stays_readable(client: TestClient, workspace: str) -> None:
    """The list hides it unless asked, and its own read still answers it with the archive time."""
    sign_in(client, MEMBER)
    kept = seed_project(client, workspace, name="Kept")
    gone = seed_project(client, workspace, name="Gone")

    archived = client.post(_path(workspace, gone["project_id"], "archive"))
    listed = client.get(_path(workspace))
    everything = client.get(_path(workspace), params={"include_archived": True})
    read = client.get(_path(workspace, gone["project_id"]))

    assert archived.status_code == 200
    assert archived.json()["archived_at"] is not None
    assert [row["project_id"] for row in listed.json()["projects"]] == [kept["project_id"]]
    assert {row["name"] for row in everything.json()["projects"]} == {"Kept", "Gone"}
    assert read.json()["archived_at"] == archived.json()["archived_at"]
    assert kept["archived_at"] is None


def test_restoring_returns_the_project_to_the_list(client: TestClient, workspace: str) -> None:
    """A restore clears the archive time and the project lists again."""
    sign_in(client, MEMBER)
    project = seed_project(client, workspace)
    client.post(_path(workspace, project["project_id"], "archive"))

    restored = client.post(_path(workspace, project["project_id"], "unarchive"))
    listed = client.get(_path(workspace))

    assert restored.status_code == 200
    assert restored.json()["archived_at"] is None
    assert [row["project_id"] for row in listed.json()["projects"]] == [project["project_id"]]


def test_archive_and_restore_are_idempotent_and_recorded_once(client: TestClient, workspace: str) -> None:
    """A repeated archive or restore answers the project unchanged and adds no second activity row."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]

    first = client.post(_path(workspace, project_id, "archive")).json()
    second = client.post(_path(workspace, project_id, "archive")).json()
    client.post(_path(workspace, project_id, "unarchive"))
    client.post(_path(workspace, project_id, "unarchive"))
    rows = client.get(_path(workspace, project_id, "activity")).json()["activity"]

    assert first["archived_at"] == second["archived_at"]
    assert sorted(row["kind"] for row in rows) == ["archived", "created", "unarchived"]


def test_a_project_on_a_hidden_team_cannot_be_archived(client: TestClient, workspace: str) -> None:
    """A caller who sees none of its teams gets a 404 on both actions."""
    sign_in(client, OWNER)
    hidden = seed_project(client, workspace, team_id=OTHER_TEAM)

    sign_in(client, GUEST)
    archived = client.post(_path(workspace, hidden["project_id"], "archive"))
    restored = client.post(_path(workspace, hidden["project_id"], "unarchive"))

    assert archived.status_code == 404
    assert restored.status_code == 404
