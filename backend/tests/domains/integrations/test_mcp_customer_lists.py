"""The customer filter and request sort through the MCP `list_issues` and `list_projects` tools.

The tools run the same list path as the HTTP routes, so these tests hold only
the MCP end: the arguments reach that path, the project rows carry the count
they were ordered by, and a guest key is refused rather than answered.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.customers import Customer, CustomerRequest
from app.common.db.dynamo.issues import Issue
from tests.domains.helpers import GUEST, MEMBER, OWNER
from tests.domains.integrations.conftest import TEAM, WORKSPACE, seed_issue
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal, seed_planning


def _ask(repositories: Any, target_kind: str, target_id: str) -> str:
    """One customer asking once for an issue or project, answering the customer's id."""
    customer = Customer(workspace_id=WORKSPACE, name="Acme", created_by=OWNER)
    repositories.customers.create(customer)
    repositories.customers.add_request(
        CustomerRequest(
            workspace_id=WORKSPACE,
            customer_id=customer.customer_id,
            target_kind=target_kind,
            target_id=target_id,
            team_ids=[TEAM],
            author_id=OWNER,
        )
    )
    return customer.customer_id


def test_list_issues_filters_by_customer(client: TestClient, repositories: Any, issue: Issue) -> None:
    """`customer_id` keeps the asked for issue, and the request sort puts it first."""
    other = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS3", "ABC", 2)
    customer = _ask(repositories, "issue", issue.issue_id)
    secret = mint_for(repositories, MEMBER, ("issues:read",))

    asked = answer(tool(client, secret, "list_issues", {"team_id": TEAM, "customer_id": customer}))
    unasked = answer(tool(client, secret, "list_issues", {"team_id": TEAM, "customer_id": "none"}))
    ordered = answer(tool(client, secret, "list_issues", {"team_id": TEAM, "sort": "customer_requests_desc"}))

    assert [row["issue_key"] for row in asked["issues"]] == [issue.key]
    assert [row["issue_key"] for row in unasked["issues"]] == [other.key]
    assert [row["issue_key"] for row in ordered["issues"]] == [issue.key, other.key]


def test_list_projects_filters_and_sorts_by_customer(client: TestClient, repositories: Any, workspace: str) -> None:
    """`customer_id` narrows projects and the request sort carries each row's count."""
    asked = seed_planning(repositories, workspace, TEAM, "Asked")["project_id"]
    unasked = seed_planning(repositories, workspace, TEAM, "Unasked")["project_id"]
    customer = _ask(repositories, "project", asked)
    secret = mint_for(repositories, MEMBER, ("teams:read",))

    narrowed = answer(tool(client, secret, "list_projects", {"customer_id": customer}))
    ordered = answer(tool(client, secret, "list_projects", {"sort": "customer_requests_desc"}))

    assert [row["project_id"] for row in narrowed["projects"]] == [asked]
    assert [row["project_id"] for row in ordered["projects"]] == [asked, unasked]
    assert [row["customer_request_count"] for row in ordered["projects"]] == [1, 0]


def test_a_guest_is_refused_customer_lists(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A guest key may not filter or sort either list by customer."""
    customer = _ask(repositories, "issue", issue.issue_id)
    secret = mint_for(repositories, GUEST, ("issues:read", "teams:read"))

    assert refusal(tool(client, secret, "list_issues", {"team_id": TEAM, "customer_id": customer}))
    assert refusal(tool(client, secret, "list_issues", {"team_id": TEAM, "sort": "customer_requests_desc"}))
    assert refusal(tool(client, secret, "list_projects", {"sort": "customer_requests_desc"}))
    assert answer(tool(client, secret, "list_issues", {"team_id": TEAM}))["issues"]
