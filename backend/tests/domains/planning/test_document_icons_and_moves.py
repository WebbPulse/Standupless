"""Team documents, document icons and moving a document between parents.

The properties worth holding are that a team is a parent like a project, that an
icon is a glyph name or an emoji and clears with null, and that a move refiles
the document under a parent the caller may write under while its history and
backlinks follow it.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import GUEST, MEMBER, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, TEAM, WORKSPACE, seed_issue, seed_project


def _base(workspace: str) -> str:
    """The workspace's API root."""
    return f"/api/workspaces/{workspace}"


def _create(client: TestClient, workspace: str, kind: str, parent_id: str, **payload: Any) -> "dict[str, Any]":
    """Write one document through the route, failing loudly on a refusal."""
    body: "dict[str, Any]" = {"title": "Launch plan", "body": "We ship in October."}
    body.update(payload)
    response = client.post(f"{_base(workspace)}/{kind}s/{parent_id}/documents", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def test_a_team_holds_documents(client: TestClient, workspace: str) -> None:
    """A team lists, creates and offers templates for its documents, and a guest outside it reaches none."""
    sign_in(client, MEMBER)
    created = _create(client, workspace, "team", TEAM)

    assert (created["parent_kind"], created["parent_id"]) == ("team", TEAM)
    assert created["can_edit"] is True
    listed = client.get(f"{_base(workspace)}/teams/{TEAM}/documents").json()["documents"]
    assert [row["document_id"] for row in listed] == [created["document_id"]]
    assert client.get(f"{_base(workspace)}/teams/{TEAM}/document-templates").status_code == 200
    other = _create(client, workspace, "team", OTHER_TEAM)

    sign_in(client, GUEST)
    assert client.get(f"{_base(workspace)}/teams/{OTHER_TEAM}/documents").status_code == 404
    assert client.get(f"{_base(workspace)}/documents/{other['document_id']}").status_code == 404
    listed = client.get(f"{_base(workspace)}/documents").json()["documents"]
    assert [row["document_id"] for row in listed] == [created["document_id"]]


def test_a_document_wears_an_icon(client: TestClient, workspace: str) -> None:
    """An emoji or a glyph name is kept and listed, null clears it, and words are refused."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    created = _create(client, workspace, "project", project_id, icon="🚀")
    path = f"{_base(workspace)}/documents/{created['document_id']}"

    assert created["icon"] == "🚀"
    listed = client.get(f"{_base(workspace)}/projects/{project_id}/documents").json()["documents"]
    assert listed[0]["icon"] == "🚀"
    assert client.patch(path, json={"icon": "book"}).json()["icon"] == "book"
    assert client.patch(path, json={"icon": "not an icon"}).status_code == 422
    cleared = client.patch(path, json={"icon": None})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["icon"] is None
    assert client.get(f"{path}/versions").json()["versions"] == []


def test_a_document_moves_between_parents(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """A move refiles the document, and its body, versions and backlinks follow it."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)
    project_id = seed_project(client, workspace)["project_id"]
    created = _create(client, workspace, "project", project_id, body=f"Blocked on {issue['key']}.")
    path = f"{_base(workspace)}/documents/{created['document_id']}"

    moved = client.patch(path, json={"parent_kind": "team", "parent_id": TEAM})

    assert moved.status_code == 200, moved.text
    assert (moved.json()["parent_kind"], moved.json()["parent_id"]) == ("team", TEAM)
    assert moved.json()["body"] == f"Blocked on {issue['key']}."
    assert client.get(f"{_base(workspace)}/projects/{project_id}/documents").json()["documents"] == []
    team_rows = client.get(f"{_base(workspace)}/teams/{TEAM}/documents").json()["documents"]
    assert [row["document_id"] for row in team_rows] == [created["document_id"]]
    backlinks = client.get(f"{_base(workspace)}/issues/{issue['id']}/documents").json()["documents"]
    assert [(row["document_id"], row["parent_kind"]) for row in backlinks] == [(created["document_id"], "team")]

    initiative = client.post(f"{_base(workspace)}/initiatives", json={"name": "Grow"}).json()["initiative_id"]
    again = client.patch(path, json={"parent_kind": "initiative", "parent_id": initiative})
    assert again.status_code == 200, again.text
    assert client.get(f"{_base(workspace)}/teams/{TEAM}/documents").json()["documents"] == []
    assert client.get(path).json()["parent_id"] == initiative


def test_a_move_needs_a_writable_destination(client: TestClient, repositories: Any, workspace: str) -> None:
    """A parent the caller cannot see or write under, or half a destination, leaves the document where it was."""
    sign_in(client, MEMBER)
    initiative = client.post(f"{_base(workspace)}/initiatives", json={"name": "Grow"}).json()["initiative_id"]
    sign_in(client, GUEST)
    created = _create(client, workspace, "team", TEAM)
    path = f"{_base(workspace)}/documents/{created['document_id']}"

    assert client.patch(path, json={"parent_kind": "team", "parent_id": OTHER_TEAM}).status_code == 422
    assert client.patch(path, json={"parent_kind": "project"}).status_code == 422
    assert client.patch(path, json={"parent_kind": "initiative", "parent_id": initiative}).status_code == 403
    found = repositories.documents.get(WORKSPACE, created["document_id"])
    assert found is not None
    assert (found[0].parent_kind, found[0].parent_id) == ("team", TEAM)
