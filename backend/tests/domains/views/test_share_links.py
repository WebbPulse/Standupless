"""Share links: who may mint one, what a listing shows, and what it never shows.

The token is shown exactly once, at create time. Every later read of the link
renders a tokenless path, so a read grant on the settings page is not a grant on
the shares themselves. Two tests below assert that absence directly, because it is
the property most easily lost to a well meaning "include the URL" change.

The anonymous reads live in `test_shared.py`. This file is the member-facing half.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, GUEST, MEMBER, OUTSIDER, make_user, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM, seed_issue


def create_link(client: TestClient, workspace_id: str, **payload: Any) -> Any:
    """Mint one share link through the route."""
    return client.post(f"/api/workspaces/{workspace_id}/share-links", json=payload)


def test_a_member_shares_an_issue_and_sees_the_token_once(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """Creating a link answers a token, and the listing then renders none."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace, title="A shared issue")

    sign_in(client, MEMBER)
    created = create_link(client, workspace, target_type="issue", target_id=issue["id"])
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["token"]
    assert body["url"].endswith(f"/shared/{body['token']}")
    assert body["title"] == "A shared issue"

    listed = client.get(f"/api/workspaces/{workspace}/share-links")
    assert listed.status_code == 200
    rows = listed.json()["share_links"]
    assert len(rows) == 1
    assert "token" not in rows[0]
    assert body["token"] not in rows[0]["url"]


def test_a_guest_cannot_share_outside_their_teams(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """An issue in a team the guest is outside of is a 404, not a refusal to share."""
    sign_in(issues_client, MEMBER)
    hidden = seed_issue(issues_client, workspace, team_id=OTHER_TEAM, title="Hidden")

    sign_in(client, GUEST)
    refused = create_link(client, workspace, target_type="issue", target_id=hidden["id"])

    assert refused.status_code == 404


def test_the_listing_hides_links_onto_invisible_teams(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """A guest's listing carries only the teams they hold a membership in."""
    sign_in(issues_client, MEMBER)
    visible = seed_issue(issues_client, workspace, team_id=TEAM, title="Visible")
    hidden = seed_issue(issues_client, workspace, team_id=OTHER_TEAM, title="Hidden")

    sign_in(client, MEMBER)
    create_link(client, workspace, target_type="issue", target_id=visible["id"])
    create_link(client, workspace, target_type="issue", target_id=hidden["id"])

    sign_in(client, GUEST)
    rows = client.get(f"/api/workspaces/{workspace}/share-links").json()["share_links"]

    assert [row["title"] for row in rows] == ["Visible"]


def test_a_listing_narrows_to_one_target(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """An issue page asks for its own links and gets only those."""
    sign_in(issues_client, MEMBER)
    first = seed_issue(issues_client, workspace, title="First")
    second = seed_issue(issues_client, workspace, title="Second")

    sign_in(client, MEMBER)
    create_link(client, workspace, target_type="issue", target_id=first["id"])
    create_link(client, workspace, target_type="issue", target_id=second["id"])

    rows = client.get(
        f"/api/workspaces/{workspace}/share-links",
        params={"target_type": "issue", "target_id": first["id"]},
    ).json()["share_links"]

    assert [row["title"] for row in rows] == ["First"]


def test_an_unknown_target_is_refused(client: TestClient, workspace: str) -> None:
    """A link onto an issue that does not exist is a 404 rather than a dangling row."""
    sign_in(client, MEMBER)

    refused = create_link(client, workspace, target_type="issue", target_id="01JB0000000000000000000XXX")

    assert refused.status_code == 404


def test_the_creator_revokes_their_own_link(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """Revoking drops the link from the listing."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)

    sign_in(client, MEMBER)
    created = create_link(client, workspace, target_type="issue", target_id=issue["id"]).json()

    revoked = client.delete(f"/api/workspaces/{workspace}/share-links/{created['token_hash']}")
    assert revoked.status_code == 204

    rows = client.get(f"/api/workspaces/{workspace}/share-links").json()["share_links"]
    assert [row["revoked_at"] is not None for row in rows] == [True]


def test_another_member_cannot_revoke_a_link_they_did_not_create(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """A link belongs to its creator, or to a team admin, and to nobody else."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)

    sign_in(client, MEMBER)
    created = create_link(client, workspace, target_type="issue", target_id=issue["id"]).json()

    sign_in(client, GUEST)
    refused = client.delete(f"/api/workspaces/{workspace}/share-links/{created['token_hash']}")

    assert refused.status_code in (403, 404)


def test_an_admin_may_revoke_any_link(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """One person can close a share they did not publish, which is what takedown needs."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)

    sign_in(client, MEMBER)
    created = create_link(client, workspace, target_type="issue", target_id=issue["id"]).json()

    sign_in(client, ADMIN)
    assert client.delete(f"/api/workspaces/{workspace}/share-links/{created['token_hash']}").status_code == 204


def test_an_unknown_hash_is_a_404(client: TestClient, workspace: str) -> None:
    """A hash naming nothing answers the same 404 an invisible link does."""
    sign_in(client, MEMBER)

    assert client.delete(f"/api/workspaces/{workspace}/share-links/deadbeef").status_code == 404


def test_an_outsider_reaches_nothing(client: TestClient, workspace: str, repositories: Any) -> None:
    """Someone outside the workspace sees the workspace's own 404."""
    make_user(repositories, OUTSIDER, "outsider@example.com", "Ozzy Outsider")
    sign_in(client, OUTSIDER)

    assert client.get(f"/api/workspaces/{workspace}/share-links").status_code == 404
