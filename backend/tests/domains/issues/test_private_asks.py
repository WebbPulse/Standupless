"""Private asks, filed from a Slack DM or private channel, against real tables in moto.

A private ask is read by the person who filed it, its assignee, its requester and
the explicit members of its team. Everyone else, a workspace owner or admin
included, gets the 404 an absent issue gets and never sees it in a list or a
delta, where it reads as removed.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.base import utc_now
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_member, add_team_member, make_private, sign_in
from tests.domains.issues.conftest import TEAM, create_issue

INSIDER = "user-insider"


@pytest.fixture
def private_ask(client: TestClient, workspace: str, statuses: Any, repositories: Any) -> "dict[str, Any]":
    """One private ask in `TEAM`, filed by `MEMBER`, with `INSIDER` an explicit member of the team."""
    add_member(repositories, workspace, INSIDER, "member")
    add_team_member(repositories, workspace, TEAM, INSIDER, "member")
    sign_in(client, MEMBER)
    created = create_issue(client, workspace, title="Payroll question")
    make_private(repositories, workspace, created["id"])
    return created


def _listed_ids(client: TestClient, workspace: str, **params: Any) -> "set[str]":
    """Every issue id the caller's workspace issue list answers."""
    response = client.get(f"/api/workspaces/{workspace}/issues", params=params)
    assert response.status_code == 200, response.text
    return {issue["id"] for issue in response.json()["issues"]}


@pytest.mark.parametrize("subject", [MEMBER, INSIDER, GUEST])
def test_the_requester_and_team_members_read_and_list_it(
    client: TestClient, workspace: str, private_ask: Any, subject: str
) -> None:
    """The person who asked and each explicit member of the team, a guest on it included, see the ask."""
    sign_in(client, subject)
    read = client.get(f"/api/workspaces/{workspace}/issues/{private_ask['id']}")
    assert read.status_code == 200
    assert read.json()["private"] is True
    assert client.get(f"/api/workspaces/{workspace}/issues/by-key/{private_ask['key']}").status_code == 200
    assert private_ask["id"] in _listed_ids(client, workspace)
    assert private_ask["id"] in _listed_ids(client, workspace, team_id=TEAM)


@pytest.mark.parametrize("subject", [OWNER, ADMIN])
def test_anyone_else_sees_it_as_absent_whatever_their_role(
    client: TestClient, workspace: str, private_ask: Any, subject: str
) -> None:
    """A workspace role alone does not open a private ask: read, key, edit and list all miss it."""
    sign_in(client, subject)
    assert client.get(f"/api/workspaces/{workspace}/issues/{private_ask['id']}").status_code == 404
    assert client.get(f"/api/workspaces/{workspace}/issues/by-key/{private_ask['key']}").status_code == 404
    assert (
        client.patch(f"/api/workspaces/{workspace}/issues/{private_ask['id']}", json={"priority": "high"}).status_code
        == 404
    )
    assert private_ask["id"] not in _listed_ids(client, workspace)
    assert private_ask["id"] not in _listed_ids(client, workspace, team_id=TEAM)


def test_a_delta_reads_it_as_removed_for_an_outsider(
    client: TestClient, workspace: str, private_ask: Any, repositories: Any
) -> None:
    """A polling outsider learns only that the ask left their list; a member gets the row itself."""
    cursor = (utc_now() - timedelta(seconds=30)).isoformat()
    make_private(repositories, workspace, private_ask["id"])

    sign_in(client, ADMIN)
    outsider = client.get(f"/api/workspaces/{workspace}/issues", params={"updated_since": cursor, "team_id": TEAM})
    assert outsider.status_code == 200, outsider.text
    assert private_ask["id"] not in {row["id"] for row in outsider.json()["issues"]}
    assert private_ask["id"] in outsider.json()["removed_ids"]

    sign_in(client, INSIDER)
    member = client.get(f"/api/workspaces/{workspace}/issues", params={"updated_since": cursor, "team_id": TEAM})
    assert private_ask["id"] in {row["id"] for row in member.json()["issues"]}


def test_an_assignee_reads_it_and_sub_issues_inherit_privacy(
    client: TestClient, workspace: str, private_ask: Any, repositories: Any
) -> None:
    """Assigning the ask opens it to the assignee, and a sub-issue filed under it is private too."""
    sign_in(client, MEMBER)
    child = create_issue(client, workspace, title="Follow up", parent_id=private_ask["id"])
    assert child["private"] is True

    stored = repositories.issues.get(workspace, private_ask["id"])
    repositories.issues.replace(stored.model_copy(update={"assignee_id": ADMIN}))
    sign_in(client, ADMIN)
    assert client.get(f"/api/workspaces/{workspace}/issues/{private_ask['id']}").status_code == 200
    assert client.get(f"/api/workspaces/{workspace}/issues/{child['id']}").status_code == 404
