"""The authorization matrix for the issue routes.

The invariant design section 2 fixes is that invisible and absent look identical:
a non-member 404s on the workspace, and a guest 404s on any project they hold no
membership in. A 403 anywhere in that set would confirm the resource exists, so
each case below asserts the status code rather than only the refusal.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, GUEST, MEMBER, OUTSIDER, OWNER, sign_in, sign_out
from tests.domains.issues.conftest import OTHER_PROJECT, PROJECT, create_issue


@pytest.fixture
def issue(client: TestClient, workspace: str, statuses: Any) -> "dict[str, Any]":
    """One issue in the project the guest can see, created by the owner."""
    sign_in(client, OWNER)
    created = create_issue(client, workspace)
    sign_out(client)
    return created


@pytest.fixture
def hidden_issue(client: TestClient, workspace: str, statuses: Any) -> "dict[str, Any]":
    """One issue in the project the guest holds no membership in."""
    sign_in(client, OWNER)
    created = create_issue(client, workspace, project_id=OTHER_PROJECT, title="Hidden")
    sign_out(client)
    return created


def test_an_unauthenticated_caller_is_401(client: TestClient, workspace: str, issue: Any) -> None:
    """No claims at all is unauthenticated rather than not found."""
    assert client.get(f"/api/workspaces/{workspace}/issues").status_code == 401


def test_a_non_member_sees_the_workspace_as_absent(client: TestClient, workspace: str, issue: Any) -> None:
    """A stranger cannot tell a workspace they are outside from one that is gone."""
    sign_in(client, OUTSIDER)

    assert client.get(f"/api/workspaces/{workspace}/issues").status_code == 404
    assert client.get(f"/api/workspaces/{workspace}/issues/{issue['id']}").status_code == 404


@pytest.mark.parametrize("subject", [OWNER, ADMIN, MEMBER])
def test_every_workspace_role_reads_and_writes_issues(
    client: TestClient, workspace: str, statuses: Any, subject: str
) -> None:
    """An owner, an admin and a member all reach every project of the workspace."""
    sign_in(client, subject)
    created = create_issue(client, workspace, title=f"By {subject}")

    assert client.get(f"/api/workspaces/{workspace}/issues/{created['id']}").status_code == 200
    assert (
        client.patch(f"/api/workspaces/{workspace}/issues/{created['id']}", json={"priority": "high"}).status_code
        == 200
    )


def test_a_guest_reaches_the_project_it_is_a_member_of(
    client: TestClient, workspace: str, statuses: Any, issue: Any
) -> None:
    """A project membership is what a guest's access is made of."""
    sign_in(client, GUEST)

    assert client.get(f"/api/workspaces/{workspace}/issues/{issue['id']}").status_code == 200
    assert create_issue(client, workspace, title="By the guest")["project_id"] == PROJECT


def test_a_guest_sees_a_project_it_is_outside_as_absent(client: TestClient, workspace: str, hidden_issue: Any) -> None:
    """The guest invariant, on a read of one issue and on the list alike."""
    sign_in(client, GUEST)

    assert client.get(f"/api/workspaces/{workspace}/issues/{hidden_issue['id']}").status_code == 404
    assert client.get(f"/api/workspaces/{workspace}/issues/{hidden_issue['id']}/links").status_code == 404
    assert client.get(f"/api/workspaces/{workspace}/issues/{hidden_issue['id']}/activity").status_code == 404


def test_a_guest_cannot_create_in_a_project_it_is_outside(client: TestClient, workspace: str, statuses: Any) -> None:
    """A create names its project in the body, so the same rule has to hold there."""
    sign_in(client, GUEST)

    response = client.post(
        f"/api/workspaces/{workspace}/issues",
        json={"project_id": OTHER_PROJECT, "title": "Sneaking in"},
    )
    assert response.status_code == 404


def test_a_guest_list_omits_the_project_it_is_outside(
    client: TestClient, workspace: str, statuses: Any, issue: Any, hidden_issue: Any
) -> None:
    """The fan-out reads only the visible projects rather than filtering after."""
    sign_in(client, GUEST)

    listed = client.get(f"/api/workspaces/{workspace}/issues").json()["issues"]

    assert [row["id"] for row in listed] == [issue["id"]]


def test_a_guest_cannot_look_up_a_hidden_project_by_key(client: TestClient, workspace: str, hidden_issue: Any) -> None:
    """The key names the project, so the lookup has to apply the same rule."""
    sign_in(client, GUEST)

    assert client.get(f"/api/workspaces/{workspace}/issues/by-key/XYZ-1").status_code == 404


def test_a_project_admin_deletes_anyone_s_issue(client: TestClient, workspace: str, statuses: Any, issue: Any) -> None:
    """A workspace admin implies project admin, which the contract states."""
    sign_in(client, ADMIN)

    assert client.delete(f"/api/workspaces/{workspace}/issues/{issue['id']}").status_code == 204


def test_a_creator_deletes_their_own_childless_issue(client: TestClient, workspace: str, statuses: Any) -> None:
    """The contract's second delete clause: the creator, while it has no children."""
    sign_in(client, MEMBER)
    created = create_issue(client, workspace, title="Mine")

    assert client.delete(f"/api/workspaces/{workspace}/issues/{created['id']}").status_code == 204


def test_a_creator_cannot_delete_their_issue_once_it_has_children(
    client: TestClient, workspace: str, statuses: Any
) -> None:
    """Deleting a parent reparents children, which is an admin's decision."""
    sign_in(client, MEMBER)
    parent = create_issue(client, workspace, title="Parent")
    create_issue(client, workspace, title="Child", parent_id=parent["id"])

    assert client.delete(f"/api/workspaces/{workspace}/issues/{parent['id']}").status_code == 403


def test_a_member_cannot_delete_someone_else_s_issue(
    client: TestClient, workspace: str, statuses: Any, issue: Any
) -> None:
    """Not the creator and not an admin is a refusal, not a not found.

    The issue is visible to them, so hiding it would be a lie; only the verb is
    refused.
    """
    sign_in(client, MEMBER)

    assert client.delete(f"/api/workspaces/{workspace}/issues/{issue['id']}").status_code == 403


def test_a_guest_cannot_delete_an_issue_in_a_project_it_is_outside(
    client: TestClient, workspace: str, hidden_issue: Any
) -> None:
    """Invisible beats unauthorised, so the answer stays a 404."""
    sign_in(client, GUEST)

    assert client.delete(f"/api/workspaces/{workspace}/issues/{hidden_issue['id']}").status_code == 404


def test_an_assignee_must_be_able_to_see_the_project(client: TestClient, workspace: str, statuses: Any) -> None:
    """Assigning a guest an issue they cannot open would hide it from them."""
    sign_in(client, OWNER)

    response = client.post(
        f"/api/workspaces/{workspace}/issues",
        json={"project_id": OTHER_PROJECT, "title": "Assigned", "assignee_id": GUEST},
    )
    assert response.status_code == 422


def test_an_assignee_outside_the_workspace_is_refused(client: TestClient, workspace: str, statuses: Any) -> None:
    """Membership of the workspace is the floor for being assignable."""
    sign_in(client, OWNER)

    response = client.post(
        f"/api/workspaces/{workspace}/issues",
        json={"project_id": PROJECT, "title": "Assigned", "assignee_id": OUTSIDER},
    )
    assert response.status_code == 422
