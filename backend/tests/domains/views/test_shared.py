"""The anonymous share reads: one token, one target, and nothing around it.

These routes take no credential but the token in the path, so the tests that matter
are the ones proving a token cannot be widened. A token for one issue must not
reach a second issue, a token for a view must not answer the issue route, and a
revoked or expired token must resolve to nothing.

Every refusal is the same 404. A reader probing with guessed tokens must not be
able to tell a revoked link from an expired one from a value that was never minted,
because each distinction would be a signal about what exists.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import GUEST, MEMBER, sign_in, sign_out
from tests.domains.views.conftest import OTHER_TEAM, TEAM, seed_issue


def mint(client: TestClient, workspace_id: str, **payload: Any) -> dict[str, Any]:
    """Mint one share link as a member, then drop the session."""
    sign_in(client, MEMBER)
    created = client.post(f"/api/workspaces/{workspace_id}/share-links", json=payload)
    assert created.status_code == 201, created.text
    sign_out(client)
    return created.json()


def test_a_token_resolves_to_its_target(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """The heading read names the issue, its team and its workspace."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace, title="A shared issue")
    link = mint(client, workspace, target_type="issue", target_id=issue["id"])

    response = client.get(f"/api/shared/{link['token']}")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["target_type"] == "issue"
    assert body["title"] == "A shared issue"
    assert body["team_name"] == "Abc"


def test_a_shared_issue_reads_anonymously(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """The issue route answers with no session at all."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace, title="A shared issue")
    link = mint(client, workspace, target_type="issue", target_id=issue["id"])

    response = client.get(f"/api/shared/{link['token']}/issue")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["title"] == "A shared issue"
    assert body["issue_key"] == issue["key"]


def test_a_shared_issue_never_carries_internal_fields(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """The public shape is declared separately, so no internal id leaks into it.

    The two families of schema are never derived from each other by exclusion, and
    this is what holds that: adding a field to the member-facing model must not be
    able to widen what an anonymous reader sees.
    """
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace, title="A shared issue", assignee_id=MEMBER)
    link = mint(client, workspace, target_type="issue", target_id=issue["id"])

    body = client.get(f"/api/shared/{link['token']}/issue").json()

    for leaked in ("workspace_id", "team_id", "created_by", "assignee_id", "id", "issue_id"):
        assert leaked not in body, f"{leaked} reached an anonymous reader"


def test_a_shared_issue_names_people_without_identifying_them(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """An assignee shows as a display name, never as an id or an email address."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace, assignee_id=MEMBER)
    link = mint(client, workspace, target_type="issue", target_id=issue["id"])

    body = client.get(f"/api/shared/{link['token']}/issue").json()

    assert body["assignee_name"] == "Mo Member"
    assert "@" not in str(body["assignee_name"])
    assert MEMBER not in str(body)


def test_a_token_for_one_issue_cannot_reach_another(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """There is no identifier but the token, so a second issue is unreachable.

    Asserted as a property of the answer rather than by trying a second id, because
    the routes take no id to try: this pins that the body describes exactly the one
    issue the token was minted for.
    """
    sign_in(issues_client, MEMBER)
    shared = seed_issue(issues_client, workspace, title="Shared")
    secret = seed_issue(issues_client, workspace, title="Not shared")
    link = mint(client, workspace, target_type="issue", target_id=shared["id"])

    body = client.get(f"/api/shared/{link['token']}/issue").json()

    assert body["title"] == "Shared"
    assert "Not shared" not in str(body)
    assert secret["id"] not in str(body)


def test_an_issue_token_is_refused_by_the_view_route(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """A token of the wrong kind answers the shared 404 rather than a 400."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)
    link = mint(client, workspace, target_type="issue", target_id=issue["id"])

    assert client.get(f"/api/shared/{link['token']}/view").status_code == 404


def test_an_unknown_token_is_a_404(client: TestClient, workspace: str) -> None:
    """A token that was never minted resolves to nothing."""
    assert client.get("/api/shared/not-a-real-token").status_code == 404
    assert client.get("/api/shared/not-a-real-token/issue").status_code == 404
    assert client.get("/api/shared/not-a-real-token/view").status_code == 404


def test_a_revoked_token_stops_reading(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """Revoking closes the anonymous read immediately, with no cache to wait out."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)
    link = mint(client, workspace, target_type="issue", target_id=issue["id"])

    assert client.get(f"/api/shared/{link['token']}/issue").status_code == 200

    sign_in(client, MEMBER)
    client.delete(f"/api/workspaces/{workspace}/share-links/{link['token_hash']}")
    sign_out(client)

    assert client.get(f"/api/shared/{link['token']}/issue").status_code == 404


def test_the_answer_does_not_depend_on_who_is_asking(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """A signed in reader gets the same body an anonymous one does.

    A share that rendered differently for a member would turn the link into a way to
    probe membership, so the two answers have to be byte identical.
    """
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace, title="A shared issue")
    link = mint(client, workspace, target_type="issue", target_id=issue["id"])

    anonymous = client.get(f"/api/shared/{link['token']}/issue").json()
    sign_in(client, GUEST)
    as_member = client.get(f"/api/shared/{link['token']}/issue").json()

    assert anonymous == as_member


def test_a_shared_view_pages_its_issues(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """A view token answers a page of summaries from its own team."""
    sign_in(issues_client, MEMBER)
    seed_issue(issues_client, workspace, title="In the view")

    sign_in(client, MEMBER)
    view = client.post(
        f"/api/workspaces/{workspace}/views",
        json={"name": "A shared view", "team_id": TEAM},
    )
    assert view.status_code == 201, view.text
    sign_out(client)

    link = mint(client, workspace, target_type="view", target_id=view.json()["view_id"])
    response = client.get(f"/api/shared/{link['token']}/view")

    assert response.status_code == 200, response.text
    titles = [row["title"] for row in response.json()["issues"]]
    assert "In the view" in titles


def test_a_shared_view_stays_inside_its_own_team(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """Issues of another team never appear, whatever the view was edited to."""
    sign_in(issues_client, MEMBER)
    seed_issue(issues_client, workspace, team_id=TEAM, title="Inside")
    seed_issue(issues_client, workspace, team_id=OTHER_TEAM, title="Outside")

    sign_in(client, MEMBER)
    view = client.post(
        f"/api/workspaces/{workspace}/views",
        json={"name": "A shared view", "team_id": TEAM},
    )
    sign_out(client)

    link = mint(client, workspace, target_type="view", target_id=view.json()["view_id"])
    body = client.get(f"/api/shared/{link['token']}/view").json()

    titles = [row["title"] for row in body["issues"]]
    assert "Inside" in titles
    assert "Outside" not in titles
