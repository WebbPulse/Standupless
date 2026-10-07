"""Search and share links for a private team's issues.

Search fans out only over the teams the caller can see, so a private team's
issues never reach someone outside it, whatever their workspace role. A share
link into a private team resolves only while its creator is still on the team,
so making a team private, or removing someone from it, closes their links.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_team_member, sign_in, sign_out
from tests.domains.views.conftest import TEAM, seed_issue
from tests.domains.views.test_search import index_issue


def test_search_skips_a_private_team_for_everyone_outside_it(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A hit in a private team reaches its members and nobody else."""
    sign_in(issues_client, MEMBER)
    hidden = seed_issue(issues_client, workspace, title="Secret widget plans", team_id=TEAM)
    index_issue(repositories, workspace, TEAM, hidden)
    add_team_member(repositories, workspace, TEAM, MEMBER, "member")
    repositories.memberships.set_team_private(workspace, TEAM, True)

    for outsider in (OWNER, ADMIN):
        sign_in(client, outsider)
        response = client.get(f"/api/workspaces/{workspace}/search", params={"q": "widget"})
        assert response.status_code == 200
        assert response.json()["results"] == []
        assert (
            client.get(f"/api/workspaces/{workspace}/search", params={"q": "widget", "team_id": TEAM}).status_code
            == 404
        )

    sign_in(client, MEMBER)
    response = client.get(f"/api/workspaces/{workspace}/search", params={"q": "widget"})
    assert [row["issue_id"] for row in response.json()["results"]] == [hidden["id"]]


def test_a_share_link_closes_when_its_creator_cannot_see_the_private_team(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """Made while the team was open, the link stops resolving once the team is private without its creator."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace, title="A shared issue", team_id=TEAM)
    sign_in(client, MEMBER)
    created = client.post(
        f"/api/workspaces/{workspace}/share-links", json={"target_type": "issue", "target_id": issue["id"]}
    )
    assert created.status_code == 201, created.text
    token = created.json()["token"]
    sign_out(client)

    assert client.get(f"/api/shared/{token}").status_code == 200

    repositories.memberships.set_team_private(workspace, TEAM, True)
    assert client.get(f"/api/shared/{token}").status_code == 404
    assert client.get(f"/api/shared/{token}/issue").status_code == 404

    add_team_member(repositories, workspace, TEAM, MEMBER, "member")
    assert client.get(f"/api/shared/{token}/issue").status_code == 200
