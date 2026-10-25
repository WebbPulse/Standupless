"""Restoring an earlier document version.

The properties worth holding are that a restore puts the version's body back
as an edit by the caller while leaving the title alone, that the body it
replaced is kept as a version even inside the caller's own edit session so a
restore can itself be undone, that it is held to the right to edit and to the
stale body guard, and that an unknown version or an unreadable document is a
404.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common import documents as documents_module
from app.common.body_versions import BODY_CHANGED, body_version
from tests.domains.helpers import ADMIN, GUEST, MEMBER, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, seed_project


def _base(workspace: str) -> str:
    """The workspace's API root."""
    return f"/api/workspaces/{workspace}"


def _document_with_history(client: TestClient, workspace: str, **project: Any) -> "tuple[str, str]":
    """A project document the member wrote and the admin rewrote, answering its path and the kept version id."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace, **project)["project_id"]
    created = client.post(
        f"{_base(workspace)}/projects/{project_id}/documents",
        json={"title": "Launch plan", "body": "First draft"},
    )
    assert created.status_code == 201, created.text
    path = f"{_base(workspace)}/documents/{created.json()['document_id']}"
    sign_in(client, ADMIN)
    edited = client.patch(path, json={"body": "Reviewed", "title": "Launch runbook"})
    assert edited.status_code == 200, edited.text
    versions = client.get(f"{path}/versions").json()["versions"]
    assert [row["body"] for row in versions] == ["First draft"]
    return path, versions[0]["version_id"]


def test_a_restore_puts_the_version_body_back_as_an_edit(client: TestClient, workspace: str) -> None:
    """The body comes back, the title stays, and the restorer is recorded as the editor."""
    path, version_id = _document_with_history(client, workspace)
    current = client.get(path).json()

    restored = client.post(f"{path}/versions/{version_id}/restore", json={"base_body_version": current["body_version"]})

    assert restored.status_code == 200, restored.text
    read = restored.json()
    assert (read["body"], read["title"]) == ("First draft", "Launch runbook")
    assert read["body_version"] == body_version("First draft")
    assert read["updated_by"] == ADMIN
    assert client.get(path).json()["body"] == "First draft"


def test_the_replaced_body_stays_in_the_history(client: TestClient, workspace: str) -> None:
    """A restore inside the caller's own edit session still keeps the body it replaced, so it can be undone."""
    path, version_id = _document_with_history(client, workspace)

    restored = client.post(f"{path}/versions/{version_id}/restore", json={})
    assert restored.status_code == 200, restored.text
    versions = client.get(f"{path}/versions").json()["versions"]

    assert [(row["body"], row["edited_by"]) for row in versions] == [("Reviewed", ADMIN), ("First draft", MEMBER)]
    undone = client.post(f"{path}/versions/{versions[0]['version_id']}/restore")
    assert undone.status_code == 200, undone.text
    assert undone.json()["body"] == "Reviewed"
    assert [row["body"] for row in client.get(f"{path}/versions").json()["versions"]][:1] == ["First draft"]


def test_a_restore_against_a_stale_body_is_refused_with_the_current_body(client: TestClient, workspace: str) -> None:
    """A restore chosen against an older body is a 409 carrying the body that is there now, and nothing changes."""
    path, version_id = _document_with_history(client, workspace)
    seen = client.get(path).json()["body_version"]
    sign_in(client, MEMBER)
    assert client.patch(path, json={"body": "Theirs"}).status_code == 200

    sign_in(client, ADMIN)
    stale = client.post(f"{path}/versions/{version_id}/restore", json={"base_body_version": seen})

    assert stale.status_code == 409, stale.text
    assert stale.json()["error_code"] == BODY_CHANGED
    assert stale.json()["details"] == {"body": "Theirs", "body_version": body_version("Theirs")}
    assert client.get(path).json()["body"] == "Theirs"


def test_a_restore_that_loses_a_race_after_its_read_is_refused(
    client: TestClient, workspace: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A body landing between the restore's read and its write refuses the restore."""
    path, version_id = _document_with_history(client, workspace)
    document_id = path.rsplit("/", 1)[1]
    documents = repositories.documents
    original = documents.replace

    def racing(previous: Any, document: Any, body: Any, **kwargs: Any) -> Any:
        """Let a teammate's body land just before this write."""
        stored = documents.get_body(workspace, document_id)
        documents._repository.put(stored.model_copy(update={"body": "Theirs"}).model_dump(mode="json"))
        return original(previous, document, body, **kwargs)

    monkeypatch.setattr(documents, "replace", racing)
    stale = client.post(f"{path}/versions/{version_id}/restore")
    monkeypatch.undo()

    assert stale.status_code == 409, stale.text
    assert stale.json()["error_code"] == BODY_CHANGED
    assert client.get(path).json()["body"] == "Theirs"


def test_a_restore_takes_the_right_to_edit(client: TestClient, workspace: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """A reader who may not edit the document is refused, and the body is left alone."""
    path, version_id = _document_with_history(client, workspace)
    monkeypatch.setattr(documents_module.Rights, "can_edit", lambda self, parent: False)

    refused = client.post(f"{path}/versions/{version_id}/restore")
    monkeypatch.undo()

    assert refused.status_code == 403, refused.text
    assert client.get(path).json()["body"] == "Reviewed"


def test_a_guest_outside_the_team_cannot_reach_the_restore(client: TestClient, workspace: str) -> None:
    """A document under a team the guest cannot see answers 404, as reading it does."""
    path, version_id = _document_with_history(client, workspace, team_id=OTHER_TEAM)

    sign_in(client, GUEST)
    hidden = client.post(f"{path}/versions/{version_id}/restore")

    assert hidden.status_code == 404, hidden.text


def test_an_unknown_version_is_not_found(client: TestClient, workspace: str) -> None:
    """A version id the document does not keep is a 404."""
    path, _ = _document_with_history(client, workspace)

    missing = client.post(f"{path}/versions/01M0000000000000000000000/restore")

    assert missing.status_code == 404, missing.text
    assert client.get(path).json()["body"] == "Reviewed"
