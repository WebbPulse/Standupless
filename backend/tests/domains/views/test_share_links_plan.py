"""Public view and filter links are the public roadmap, a Standard feature.

Below Standard creating one answers the plan refusal naming the plan to move to,
and a link minted while the plan allowed it stops opening, with the same 404 a
revoked link answers, until the workspace is back on Standard. Issue links stay
open on every plan.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import MEMBER, sign_in, sign_out
from tests.domains.views.conftest import TEAM, seed_issue


def create_link(client: TestClient, workspace_id: str, **payload: Any) -> Any:
    """Mint one share link as a member through the route."""
    sign_in(client, MEMBER)
    response = client.post(f"/api/workspaces/{workspace_id}/share-links", json=payload)
    sign_out(client)
    return response


def create_view(client: TestClient, workspace_id: str) -> str:
    """Save one team view as a member and answer its id."""
    sign_in(client, MEMBER)
    view = client.post(f"/api/workspaces/{workspace_id}/views", json={"name": "Roadmap", "team_id": TEAM})
    assert view.status_code == 201, view.text
    sign_out(client)
    return str(view.json()["view_id"])


def set_plan(repositories: Any, workspace_id: str, plan: str) -> None:
    """Move the workspace onto one plan."""
    repositories.workspaces.set_billing(workspace_id, plan=plan)


def assert_plan_refusal(response: Any) -> None:
    """The response is the public roadmap refusal naming Standard as the plan to move to."""
    assert response.status_code == 403, response.text
    detail = response.json()
    assert detail["error_code"] == "PLAN_FEATURE_UNAVAILABLE"
    assert detail["details"] == {"feature": "public_roadmap", "plan": "free", "required_plan": "standard"}
    assert "Standard plan" in detail["message"]


def test_free_refuses_a_view_link(client: TestClient, workspace: str) -> None:
    """A view link on Free answers the plan refusal."""
    view_id = create_view(client, workspace)

    assert_plan_refusal(create_link(client, workspace, target_type="view", target_id=view_id))


def test_free_refuses_a_filter_link(client: TestClient, workspace: str) -> None:
    """An unsaved team filter link on Free answers the plan refusal."""
    refused = create_link(client, workspace, target_type="filter", target_id=TEAM, filter={"team_id": TEAM})

    assert_plan_refusal(refused)


def test_free_still_shares_an_issue(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """An issue link mints and opens on Free."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace, title="Public issue")

    created = create_link(client, workspace, target_type="issue", target_id=issue["id"])

    assert created.status_code == 201, created.text
    assert client.get(f"/api/shared/{created.json()['token']}/issue").status_code == 200


def test_standard_mints_view_and_filter_links(client: TestClient, repositories: Any, workspace: str) -> None:
    """On Standard both public listing links mint and open."""
    set_plan(repositories, workspace, "standard")
    view_id = create_view(client, workspace)

    view_link = create_link(client, workspace, target_type="view", target_id=view_id)
    filter_link = create_link(client, workspace, target_type="filter", target_id=TEAM, filter={"team_id": TEAM})

    assert view_link.status_code == 201, view_link.text
    assert filter_link.status_code == 201, filter_link.text
    assert client.get(f"/api/shared/{view_link.json()['token']}/view").status_code == 200
    assert client.get(f"/api/shared/{filter_link.json()['token']}/view").status_code == 200


def test_a_downgrade_closes_listing_links_until_an_upgrade(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """Back on Free a view or filter link answers the revoked 404 while an issue link keeps opening."""
    set_plan(repositories, workspace, "standard")
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace, title="Public issue")
    view_id = create_view(client, workspace)
    view_token = create_link(client, workspace, target_type="view", target_id=view_id).json()["token"]
    filter_token = create_link(client, workspace, target_type="filter", target_id=TEAM, filter={}).json()["token"]
    issue_token = create_link(client, workspace, target_type="issue", target_id=issue["id"]).json()["token"]

    set_plan(repositories, workspace, "free")

    for token in (view_token, filter_token):
        assert client.get(f"/api/shared/{token}").status_code == 404
        closed = client.get(f"/api/shared/{token}/view")
        assert closed.status_code == 404
        assert closed.json()["error_code"] == "NOT_FOUND"
    assert client.get(f"/api/shared/{issue_token}/issue").status_code == 200

    set_plan(repositories, workspace, "standard")

    assert client.get(f"/api/shared/{view_token}/view").status_code == 200
    assert client.get(f"/api/shared/{filter_token}/view").status_code == 200
