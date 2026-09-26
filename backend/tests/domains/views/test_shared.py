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


def _team_view(client: TestClient, workspace: str, **payload: Any) -> str:
    """Create one team view as a member and answer its id."""
    sign_in(client, MEMBER)
    body: dict[str, Any] = {"name": "A shared view", "team_id": TEAM}
    body.update(payload)
    view = client.post(f"/api/workspaces/{workspace}/views", json=body)
    assert view.status_code == 201, view.text
    sign_out(client)
    return str(view.json()["view_id"])


def test_a_shared_view_shows_only_what_its_filter_selects(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """A view filtered to urgent issues shares the urgent ones and nothing else."""
    sign_in(issues_client, MEMBER)
    seed_issue(issues_client, workspace, title="Urgent one", priority="urgent")
    seed_issue(issues_client, workspace, title="Quiet one", priority="low")

    view_id = _team_view(client, workspace, filter={"team_id": TEAM, "priority": ["urgent"]})
    link = mint(client, workspace, target_type="view", target_id=view_id)
    body = client.get(f"/api/shared/{link['token']}/view").json()

    titles = [row["title"] for row in body["issues"]]
    assert titles == ["Urgent one"]


def test_a_shared_view_follows_its_saved_sort(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """The listing reads in the view's own sort rather than the table's order."""
    sign_in(issues_client, MEMBER)
    seed_issue(issues_client, workspace, title="Low", priority="low")
    seed_issue(issues_client, workspace, title="Urgent", priority="urgent")
    seed_issue(issues_client, workspace, title="Medium", priority="medium")

    view_id = _team_view(client, workspace, sort="priority_desc")
    link = mint(client, workspace, target_type="view", target_id=view_id)
    body = client.get(f"/api/shared/{link['token']}/view").json()

    assert [row["title"] for row in body["issues"]] == ["Urgent", "Medium", "Low"]


def test_a_shared_view_pages_with_an_offset_cursor(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """A second page continues the first rather than repeating it."""
    sign_in(issues_client, MEMBER)
    for index in range(3):
        seed_issue(issues_client, workspace, title=f"Issue {index}")

    view_id = _team_view(client, workspace, sort="key_asc")
    link = mint(client, workspace, target_type="view", target_id=view_id)

    first = client.get(f"/api/shared/{link['token']}/view", params={"limit": 2}).json()
    assert len(first["issues"]) == 2
    assert first["next_cursor"]
    second = client.get(f"/api/shared/{link['token']}/view", params={"limit": 2, "cursor": first["next_cursor"]}).json()
    assert [row["title"] for row in second["issues"]] == ["Issue 2"]
    assert second["next_cursor"] is None


def test_a_filter_link_snapshots_an_unsaved_filter(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """A filter link lists what the filter selected in its team, read anonymously."""
    sign_in(issues_client, MEMBER)
    seed_issue(issues_client, workspace, title="Urgent one", priority="urgent")
    seed_issue(issues_client, workspace, title="Quiet one", priority="low")
    seed_issue(issues_client, workspace, team_id=OTHER_TEAM, title="Elsewhere", priority="urgent")

    link = mint(
        client,
        workspace,
        target_type="filter",
        target_id=TEAM,
        filter={"team_id": TEAM, "priority": ["urgent"]},
        sort="updated_desc",
        title="Urgent work",
    )
    assert link["target_type"] == "filter"
    assert link["title"] == "Urgent work"

    heading = client.get(f"/api/shared/{link['token']}").json()
    assert heading["target_type"] == "view"
    assert heading["title"] == "Urgent work"

    body = client.get(f"/api/shared/{link['token']}/view").json()
    assert [row["title"] for row in body["issues"]] == ["Urgent one"]
    assert client.get(f"/api/shared/{link['token']}/issue").status_code == 404


def test_a_filter_link_defaults_its_title_to_the_team(client: TestClient, workspace: str) -> None:
    """A filter link nobody named takes its team's name."""
    link = mint(client, workspace, target_type="filter", target_id=TEAM, filter={})
    assert link["title"] == "Abc issues"


def test_a_filter_link_cannot_name_another_team(client: TestClient, workspace: str) -> None:
    """A filter whose team_id differs from the link's team is refused, not widened."""
    sign_in(client, MEMBER)
    response = client.post(
        f"/api/workspaces/{workspace}/share-links",
        json={"target_type": "filter", "target_id": TEAM, "filter": {"team_id": OTHER_TEAM}},
    )
    assert response.status_code == 422, response.text


def test_a_filter_link_refuses_an_unknown_filter_key(client: TestClient, workspace: str) -> None:
    """The snapshot is held to the saved view filter's own keys."""
    sign_in(client, MEMBER)
    response = client.post(
        f"/api/workspaces/{workspace}/share-links",
        json={"target_type": "filter", "target_id": TEAM, "filter": {"workspace_id": "elsewhere"}},
    )
    assert response.status_code == 422, response.text
    assert response.json()["error_code"] == "INVALID_FILTER"


def test_a_filter_link_bounds_its_values(client: TestClient, workspace: str) -> None:
    """A snapshot carrying an oversized value list is refused before it is stored."""
    sign_in(client, MEMBER)
    response = client.post(
        f"/api/workspaces/{workspace}/share-links",
        json={"target_type": "filter", "target_id": TEAM, "filter": {"label_id": [f"l{i}" for i in range(51)]}},
    )
    assert response.status_code == 422, response.text


def test_a_filter_link_needs_a_visible_team(client: TestClient, workspace: str) -> None:
    """A team the caller cannot see answers the same 404 an absent one does."""
    sign_in(client, MEMBER)
    response = client.post(
        f"/api/workspaces/{workspace}/share-links",
        json={"target_type": "filter", "target_id": "no-such-team", "filter": {}},
    )
    assert response.status_code == 404, response.text
