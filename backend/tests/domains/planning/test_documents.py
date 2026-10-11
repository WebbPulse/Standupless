"""Documents: Markdown pages under a project or an initiative.

The properties worth holding are that a document is reached only through a parent
the caller can read, that project documents follow the project's teams while
initiative documents refuse guests, that only the author, a parent admin or a
workspace admin deletes one, that an edit by someone else or after a pause keeps
the earlier text as a version, that a stale edit is refused, that issue keys in
the text backlink from the issue, and that deleting the parent deletes its
documents.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_member, make_user, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, WORKSPACE, seed_issue, seed_project

PEER = "01JB000000000000000000PEER"


@pytest.fixture
def peer(repositories: Any, workspace: str) -> str:
    """A second plain member, who did not write the documents under test."""
    add_member(repositories, WORKSPACE, PEER, "member")
    make_user(repositories, PEER, "peer@example.com", "Pat Peer")
    return PEER


@pytest.fixture
def views_client(repositories: Any) -> Iterator[TestClient]:
    """A client for the views application, which serves search."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["views"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


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


def _initiative(client: TestClient, workspace: str) -> str:
    """One initiative created through the route."""
    response = client.post(f"{_base(workspace)}/initiatives", json={"name": "Grow"})
    assert response.status_code == 201, response.text
    return response.json()["initiative_id"]


def test_a_project_document_round_trips(client: TestClient, workspace: str) -> None:
    """Create, list, read and rename, with the author and the caller's rights."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]

    created = _create(client, workspace, "project", project_id)

    assert created["title"] == "Launch plan"
    assert created["body"] == "We ship in October."
    assert created["author_id"] == MEMBER
    assert created["parent_name"] == "Launch"
    assert (created["can_edit"], created["can_delete"]) == (True, True)
    listed = client.get(f"{_base(workspace)}/projects/{project_id}/documents")
    assert listed.status_code == 200, listed.text
    assert [row["document_id"] for row in listed.json()["documents"]] == [created["document_id"]]
    assert "body" not in listed.json()["documents"][0]

    path = f"{_base(workspace)}/documents/{created['document_id']}"
    renamed = client.patch(path, json={"title": "  Launch runbook  "})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["title"] == "Launch runbook"
    assert client.get(path).json()["body"] == "We ship in October."


def test_titles_must_not_be_blank(client: TestClient, workspace: str) -> None:
    """A blank title is refused on create and on rename, and a null body is never written."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]

    refused = client.post(f"{_base(workspace)}/projects/{project_id}/documents", json={"title": "   "})
    assert refused.status_code == 422

    created = _create(client, workspace, "project", project_id)
    path = f"{_base(workspace)}/documents/{created['document_id']}"
    assert client.patch(path, json={"title": ""}).status_code == 422
    assert client.patch(path, json={"body": None}).status_code == 422


def test_an_edit_by_someone_else_keeps_a_version(client: TestClient, workspace: str) -> None:
    """The author's own quick edits fold into one version, and another editor starts a new one."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    created = _create(client, workspace, "project", project_id, body="First draft")
    path = f"{_base(workspace)}/documents/{created['document_id']}"

    assert client.patch(path, json={"body": "Second draft"}).status_code == 200
    assert client.get(f"{path}/versions").json()["versions"] == []

    sign_in(client, ADMIN)
    edited = client.patch(path, json={"body": "Reviewed"})
    assert edited.status_code == 200, edited.text
    assert edited.json()["updated_by"] == ADMIN
    versions = client.get(f"{path}/versions").json()["versions"]
    assert [(row["body"], row["edited_by"]) for row in versions] == [("Second draft", MEMBER)]


def test_a_stale_edit_is_a_conflict(client: TestClient, workspace: str) -> None:
    """An editor who read an older copy cannot write over a newer one."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    created = _create(client, workspace, "project", project_id)
    path = f"{_base(workspace)}/documents/{created['document_id']}"

    fresh = client.patch(path, json={"body": "New", "base_updated_at": created["updated_at"]})
    assert fresh.status_code == 200, fresh.text
    stale = client.patch(path, json={"body": "Old", "base_updated_at": created["updated_at"]})

    assert stale.status_code == 409
    assert client.get(path).json()["body"] == "New"


def test_only_the_author_or_an_admin_deletes(client: TestClient, workspace: str, peer: str) -> None:
    """Another member may edit a project document but not delete it."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    created = _create(client, workspace, "project", project_id)
    path = f"{_base(workspace)}/documents/{created['document_id']}"

    sign_in(client, peer)
    seen = client.get(path).json()
    assert (seen["can_edit"], seen["can_delete"]) == (True, False)
    assert client.patch(path, json={"body": "Peer edit"}).status_code == 200
    assert client.delete(path).status_code == 403

    sign_in(client, ADMIN)
    assert client.delete(path).status_code == 204
    assert client.get(path).status_code == 404


def test_a_document_follows_its_projects_teams(client: TestClient, workspace: str) -> None:
    """A guest outside the project's team neither lists nor reads its documents."""
    sign_in(client, OWNER)
    project_id = seed_project(client, workspace, team_id=OTHER_TEAM)["project_id"]
    created = _create(client, workspace, "project", project_id)

    sign_in(client, GUEST)
    assert client.get(f"{_base(workspace)}/projects/{project_id}/documents").status_code == 404
    assert client.get(f"{_base(workspace)}/documents/{created['document_id']}").status_code == 404
    assert client.get(f"{_base(workspace)}/documents").json()["documents"] == []


def test_initiative_documents_refuse_guests(client: TestClient, workspace: str, peer: str) -> None:
    """Any member writes under an initiative, and a guest never reaches its documents."""
    sign_in(client, MEMBER)
    initiative_id = _initiative(client, workspace)
    sign_in(client, peer)
    created = _create(client, workspace, "initiative", initiative_id)
    assert created["parent_kind"] == "initiative"

    sign_in(client, GUEST)
    assert client.get(f"{_base(workspace)}/initiatives/{initiative_id}/documents").status_code == 403
    assert client.get(f"{_base(workspace)}/documents/{created['document_id']}").status_code == 404

    sign_in(client, MEMBER)
    owned = client.get(f"{_base(workspace)}/documents/{created['document_id']}").json()
    assert owned["can_delete"] is True


def test_issue_keys_backlink_from_the_issue(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """A key in the text links the issue, and removing it drops the backlink."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)
    project_id = seed_project(client, workspace)["project_id"]
    created = _create(client, workspace, "project", project_id, body=f"Blocked on {issue['key']} and NOPE-9.")
    backlinks = f"{_base(workspace)}/issues/{issue['id']}/documents"

    assert [row["issue_id"] for row in created["mentions"]] == [issue["id"]]
    assert [row["document_id"] for row in client.get(backlinks).json()["documents"]] == [created["document_id"]]

    path = f"{_base(workspace)}/documents/{created['document_id']}"
    assert client.patch(path, json={"body": "Unblocked"}).json()["mentions"] == []
    assert client.get(backlinks).json()["documents"] == []


def test_the_workspace_list_and_search_find_documents(
    client: TestClient, views_client: TestClient, workspace: str
) -> None:
    """The palette listing carries every readable document, and search matches the body."""
    sign_in(client, MEMBER)
    sign_in(views_client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    initiative_id = _initiative(client, workspace)
    first = _create(client, workspace, "project", project_id, body="The zephyr rollout")
    second = _create(client, workspace, "initiative", initiative_id, title="Goals", body="Nothing here")

    listed = client.get(f"{_base(workspace)}/documents").json()["documents"]
    assert {row["document_id"] for row in listed} == {first["document_id"], second["document_id"]}

    found = views_client.get(f"{_base(workspace)}/search", params={"q": "zephyr"})
    assert found.status_code == 200, found.text
    assert [row["document_id"] for row in found.json()["documents"]] == [first["document_id"]]


def test_deleting_the_parent_deletes_its_documents(client: TestClient, repositories: Any, workspace: str) -> None:
    """Neither a project nor an initiative leaves orphaned documents behind."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    initiative_id = _initiative(client, workspace)
    on_project = _create(client, workspace, "project", project_id)
    on_initiative = _create(client, workspace, "initiative", initiative_id)

    sign_in(client, ADMIN)
    assert client.delete(f"{_base(workspace)}/projects/{project_id}").status_code == 204
    assert client.delete(f"{_base(workspace)}/initiatives/{initiative_id}").status_code == 204

    assert repositories.documents.get(WORKSPACE, on_project["document_id"]) is None
    assert repositories.documents.get(WORKSPACE, on_initiative["document_id"]) is None
    assert repositories.documents.list_for_workspace(WORKSPACE) == []
