"""Issues in a private team, against real tables in moto.

Only the team's own members read its issues. Everyone else, a workspace owner
or admin included, gets the 404 an absent issue gets, sees nothing of it in a
list, and cannot be made its assignee.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_member, add_team_member, sign_in, sign_out
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, create_issue

INSIDER = "user-insider"


@pytest.fixture
def private_issue(client: TestClient, workspace: str, statuses: Any, repositories: Any) -> "dict[str, Any]":
    """One issue in `OTHER_TEAM`, which is then made private with only the insider on it."""
    add_member(repositories, workspace, INSIDER, "member")
    add_team_member(repositories, workspace, OTHER_TEAM, INSIDER, "member")
    sign_in(client, INSIDER)
    created = create_issue(client, workspace, team_id=OTHER_TEAM, title="Private")
    repositories.memberships.set_team_private(workspace, OTHER_TEAM, True)
    sign_out(client)
    return created


def _listed_ids(client: TestClient, workspace: str) -> set[str]:
    """Every issue id the caller's workspace issue list answers."""
    response = client.get(f"/api/workspaces/{workspace}/issues")
    assert response.status_code == 200, response.text
    return {issue["id"] for issue in response.json()["issues"]}


def test_a_team_member_reads_and_lists_the_issue(client: TestClient, workspace: str, private_issue: Any) -> None:
    """Membership is what a private team's content is made of."""
    sign_in(client, INSIDER)
    assert client.get(f"/api/workspaces/{workspace}/issues/{private_issue['id']}").status_code == 200
    assert private_issue["id"] in _listed_ids(client, workspace)


@pytest.mark.parametrize("subject", [OWNER, ADMIN, MEMBER])
def test_anyone_outside_the_team_sees_the_issue_as_absent(
    client: TestClient, workspace: str, private_issue: Any, subject: str
) -> None:
    """Workspace role does not open a private team's issues; only a membership does."""
    sign_in(client, subject)
    assert client.get(f"/api/workspaces/{workspace}/issues/{private_issue['id']}").status_code == 404
    assert client.get(f"/api/workspaces/{workspace}/issues/by-key/{private_issue['key']}").status_code == 404
    assert (
        client.patch(f"/api/workspaces/{workspace}/issues/{private_issue['id']}", json={"priority": "high"}).status_code
        == 404
    )
    assert private_issue["id"] not in _listed_ids(client, workspace)


def test_an_outsider_cannot_file_into_the_team(client: TestClient, workspace: str, private_issue: Any) -> None:
    """Creating in a team is reading it first, so the refusal is the absent-team 404."""
    sign_in(client, MEMBER)
    response = client.post(f"/api/workspaces/{workspace}/issues", json={"team_id": OTHER_TEAM, "title": "Nope"})
    assert response.status_code == 404


def test_an_outsider_cannot_be_made_the_assignee(client: TestClient, workspace: str, private_issue: Any) -> None:
    """Assigning someone who cannot open the team would hide the issue from them."""
    sign_in(client, INSIDER)
    response = client.patch(f"/api/workspaces/{workspace}/issues/{private_issue['id']}", json={"assignee_id": MEMBER})
    assert response.status_code == 422
    assert (
        client.patch(
            f"/api/workspaces/{workspace}/issues/{private_issue['id']}", json={"assignee_id": INSIDER}
        ).status_code
        == 200
    )


def test_an_open_team_is_unaffected(client: TestClient, workspace: str, private_issue: Any) -> None:
    """A private team next door changes nothing about an open one."""
    sign_in(client, MEMBER)
    created = create_issue(client, workspace, team_id=TEAM, title="Open")
    assert client.get(f"/api/workspaces/{workspace}/issues/{created['id']}").status_code == 200
    assert created["id"] in _listed_ids(client, workspace)
