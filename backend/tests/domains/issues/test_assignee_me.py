"""`assignee_id: "me"` on issue create and patch, resolved the way the list filters resolve it."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import MEMBER, OWNER, sign_in
from tests.domains.issues.conftest import create_issue


def test_create_assigns_me_to_the_caller(client: TestClient, workspace: str, statuses: Any) -> None:
    """A create naming `me` stores the caller's own id as the assignee."""
    sign_in(client, MEMBER)
    created = create_issue(client, workspace, assignee_id="me")
    assert created["assignee_id"] == MEMBER


def test_patch_assigns_me_to_the_caller(client: TestClient, workspace: str, statuses: Any) -> None:
    """A patch naming `me` moves the issue to the caller, whoever created it."""
    sign_in(client, OWNER)
    created = create_issue(client, workspace, assignee_id=OWNER)

    sign_in(client, MEMBER)
    response = client.patch(f"/api/workspaces/{workspace}/issues/{created['id']}", json={"assignee_id": "me"})

    assert response.status_code == 200, response.text
    assert response.json()["assignee_id"] == MEMBER


def test_bulk_patch_assigns_me_to_the_caller(client: TestClient, workspace: str, statuses: Any) -> None:
    """The bulk patch shares the single patch's resolution."""
    sign_in(client, OWNER)
    first = create_issue(client, workspace, title="First")
    second = create_issue(client, workspace, title="Second")

    response = client.patch(
        f"/api/workspaces/{workspace}/issues",
        json={"issue_ids": [first["id"], second["id"]], "patch": {"assignee_id": "me"}},
    )

    assert response.status_code == 200, response.text
    assert {row["assignee_id"] for row in response.json()["issues"]} == {OWNER}


def test_me_filter_finds_an_issue_created_for_me(client: TestClient, workspace: str, statuses: Any) -> None:
    """What a create stores for `me` is what the `assignee_id=me` filter reads back."""
    sign_in(client, MEMBER)
    created = create_issue(client, workspace, assignee_id="me")

    listed = client.get(f"/api/workspaces/{workspace}/issues", params={"assignee_id": "me"})

    assert listed.status_code == 200, listed.text
    assert [row["id"] for row in listed.json()["issues"]] == [created["id"]]
