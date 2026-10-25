"""Insights and dashboards are Business features.

Below Business a breakdown and every dashboard route answer the plan refusal
naming the plan to move to, while the plain status tally the view list shows
stays open to every plan, and a caller outside the workspace still meets its
membership refusal before any plan check.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.domains.helpers import MEMBER, OUTSIDER, sign_in
from tests.domains.views.conftest import TEAM, WORKSPACE, seed_issue

INSIGHTS = f"/api/workspaces/{WORKSPACE}/views/insights"

DASHBOARDS = f"/api/workspaces/{WORKSPACE}/views/dashboards"


def assert_plan_refusal(response: Any, plan: str) -> None:
    """The response is the Insights plan refusal for a workspace on `plan`."""
    assert response.status_code == 403, response.text
    body = response.json()
    assert body["error_code"] == "PLAN_FEATURE_UNAVAILABLE"
    assert body["details"] == {"feature": "insights", "plan": plan, "required_plan": "business"}


@pytest.mark.parametrize("plan", ["free", "standard"])
@pytest.mark.parametrize(
    "params",
    [
        {"group_by": "priority"},
        {"group_by": "status_category", "segment_by": "assignee"},
        {"group_by": "status_category", "measure": "points"},
        {"group_by": "status", "measure": "cycle_time"},
    ],
)
def test_a_breakdown_below_business_is_refused(
    client: TestClient, workspace: str, repositories: Any, plan: str, params: "dict[str, str]"
) -> None:
    """Any grouping, segment or measure past the plain tally needs Business."""
    repositories.workspaces.set_billing(workspace, plan=plan)
    sign_in(client, MEMBER)

    assert_plan_refusal(client.get(INSIGHTS, params={"team_id": TEAM, **params}), plan)


def test_the_plain_status_tally_answers_on_free(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """The view list's issue count reads on every plan."""
    sign_in(issues_client, MEMBER)
    seed_issue(issues_client, workspace)
    sign_in(client, MEMBER)

    response = client.get(INSIGHTS, params={"team_id": TEAM, "group_by": "status_category"})

    assert response.status_code == 200, response.text
    assert response.json()["issue_count"] == 1


def test_business_reads_every_breakdown(client: TestClient, workspace: str, repositories: Any) -> None:
    """On Business a breakdown past the tally answers."""
    repositories.workspaces.set_billing(workspace, plan="business")
    sign_in(client, MEMBER)

    response = client.get(INSIGHTS, params={"team_id": TEAM, "group_by": "priority", "measure": "points"})

    assert response.status_code == 200, response.text


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("get", DASHBOARDS, None),
        ("post", DASHBOARDS, {"name": "Delivery"}),
        ("get", f"{DASHBOARDS}/01JB0000000000000000000DB1", None),
        ("delete", f"{DASHBOARDS}/01JB0000000000000000000DB1", None),
        ("get", f"{DASHBOARDS}/01JB0000000000000000000DB1/widgets/w1/insights", None),
    ],
)
def test_dashboard_routes_below_business_are_refused(
    client: TestClient, workspace: str, method: str, path: str, body: "dict[str, Any] | None"
) -> None:
    """Every dashboard route answers the plan refusal on Free, before it looks the dashboard up."""
    sign_in(client, MEMBER)

    response = client.request(method.upper(), path, json=body)

    assert_plan_refusal(response, "free")


def test_a_dashboard_made_on_business_is_refused_after_a_downgrade(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Moving to Standard closes the dashboards already made, and moving back opens them again."""
    repositories.workspaces.set_billing(workspace, plan="business")
    sign_in(client, MEMBER)
    made = client.post(DASHBOARDS, json={"name": "Delivery"})
    assert made.status_code == 201, made.text
    path = f"{DASHBOARDS}/{made.json()['dashboard_id']}"

    repositories.workspaces.set_billing(workspace, plan="standard")
    assert_plan_refusal(client.get(path), "standard")

    repositories.workspaces.set_billing(workspace, plan="business")
    assert client.get(path).status_code == 200


@pytest.mark.parametrize("path", [INSIGHTS, DASHBOARDS])
def test_an_outsider_meets_the_membership_refusal_first(client: TestClient, workspace: str, path: str) -> None:
    """A caller outside the workspace is refused for who they are, not for the workspace's plan."""
    sign_in(client, OUTSIDER)

    response = client.get(path, params={"group_by": "priority"})

    assert response.status_code in (403, 404), response.text
    assert response.json().get("error_code") != "PLAN_FEATURE_UNAVAILABLE"
