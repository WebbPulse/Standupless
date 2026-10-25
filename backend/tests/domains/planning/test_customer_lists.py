"""The customer filter and the customer request and revenue sorts on the issue and project lists.

The properties worth holding are that both lists narrow to the issues or
projects a customer asked for, or that none did, and leave out the ones a
customer asked for under `customer_id_not`; that the request sort puts the most
asked for first with unrequested rows last; that the revenue sort sums each
asking customer once; that the important filter and sort count only requests
marked important; and that a guest, who may not read customers, is refused
either rather than learning who asked for what from the order of a list.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.customer_fields import legacy_tier_id
from app.common.db.dynamo.customers import Customer, CustomerRepository
from tests.domains.helpers import GUEST, MEMBER, sign_in
from tests.domains.planning.conftest import TEAM, WORKSPACE, seed_issue, seed_project


def _base(workspace: str) -> str:
    """The workspace's API root."""
    return f"/api/workspaces/{workspace}"


def _customer(client: TestClient, workspace: str, name: str, revenue: int = 0) -> str:
    """Create one customer through the route, answering its id."""
    response = client.post(f"{_base(workspace)}/customers", json={"name": name, "revenue": revenue})
    assert response.status_code == 201, response.text
    return response.json()["customer_id"]


def _ask(
    client: TestClient, workspace: str, kind: str, target_id: str, customer_id: str, important: bool = False
) -> None:
    """File one request from a customer for an issue or project."""
    response = client.post(
        f"{_base(workspace)}/{kind}s/{target_id}/customer-requests",
        json={"customer_id": customer_id, "important": important},
    )
    assert response.status_code == 201, response.text


def _issues(issues_client: TestClient, workspace: str, **params: Any) -> "list[str]":
    """The ids the team's issue list answers under `params`."""
    response = issues_client.get(f"{_base(workspace)}/issues", params={"team_id": TEAM, "limit": 100, **params})
    assert response.status_code == 200, response.text
    return [row["id"] for row in response.json()["issues"]]


def _projects(client: TestClient, workspace: str, **params: Any) -> "list[dict[str, Any]]":
    """The rows the project list answers under `params`."""
    response = client.get(f"{_base(workspace)}/projects", params=params)
    assert response.status_code == 200, response.text
    return response.json()["projects"]


def _seed_issues(client: TestClient, issues_client: TestClient, workspace: str) -> "dict[str, str]":
    """Three issues: one asked for by two customers, one by one, one by none."""
    acme = _customer(client, workspace, "Acme", revenue=100)
    beta = _customer(client, workspace, "Beta", revenue=5000)
    popular = seed_issue(issues_client, workspace, title="Popular")["id"]
    rich = seed_issue(issues_client, workspace, title="Rich")["id"]
    quiet = seed_issue(issues_client, workspace, title="Quiet")["id"]
    _ask(client, workspace, "issue", popular, acme)
    _ask(client, workspace, "issue", popular, acme)
    _ask(client, workspace, "issue", rich, beta)
    return {"acme": acme, "beta": beta, "popular": popular, "rich": rich, "quiet": quiet}


def test_the_issue_list_filters_by_customer(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """Any of, none of and the no customer value narrow the issue list on the server."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    rows = _seed_issues(client, issues_client, workspace)

    assert _issues(issues_client, workspace, customer_id=rows["acme"]) == [rows["popular"]]
    assert set(_issues(issues_client, workspace, customer_id=[rows["acme"], "none"])) == {
        rows["popular"],
        rows["quiet"],
    }
    assert set(_issues(issues_client, workspace, customer_id_not=rows["acme"])) == {rows["rich"], rows["quiet"]}
    assert set(_issues(issues_client, workspace, customer_id_not="none")) == {rows["popular"], rows["rich"]}


def test_the_issue_list_sorts_by_requests_and_revenue(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """The request sort counts every request, the revenue sort each customer once, unrequested issues last."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    rows = _seed_issues(client, issues_client, workspace)

    assert _issues(issues_client, workspace, sort="customer_requests_desc") == [
        rows["popular"],
        rows["rich"],
        rows["quiet"],
    ]
    assert _issues(issues_client, workspace, sort="customer_revenue_desc") == [
        rows["rich"],
        rows["popular"],
        rows["quiet"],
    ]


def test_the_project_list_filters_and_sorts_by_customer(client: TestClient, workspace: str) -> None:
    """Projects narrow by customer and order by request count, carrying the count they were ordered by."""
    sign_in(client, MEMBER)
    acme = _customer(client, workspace, "Acme", revenue=10)
    beta = _customer(client, workspace, "Beta", revenue=900)
    asked = seed_project(client, workspace, name="Asked")["project_id"]
    twice = seed_project(client, workspace, name="Twice")["project_id"]
    unasked = seed_project(client, workspace, name="Unasked")["project_id"]
    _ask(client, workspace, "project", asked, beta)
    _ask(client, workspace, "project", twice, acme)
    _ask(client, workspace, "project", twice, beta)

    assert [row["project_id"] for row in _projects(client, workspace, customer_id=acme)] == [twice]
    assert [row["project_id"] for row in _projects(client, workspace, customer_id="none")] == [unasked]
    assert {row["project_id"] for row in _projects(client, workspace, customer_id_not=acme)} == {asked, unasked}

    by_requests = _projects(client, workspace, sort="customer_requests_desc")
    assert [row["project_id"] for row in by_requests] == [twice, asked, unasked]
    assert [row["customer_request_count"] for row in by_requests] == [2, 1, 0]

    by_revenue = _projects(client, workspace, sort="customer_revenue_desc")
    assert [row["project_id"] for row in by_revenue] == [twice, asked, unasked]
    assert [row["customer_revenue"] for row in by_revenue] == [910, 900, 0]

    plain = _projects(client, workspace)
    assert all(row.get("customer_request_count") is None for row in plain)
    assert client.get(f"{_base(workspace)}/projects", params={"sort": "nonsense"}).status_code == 422


def test_guests_cannot_list_by_customer(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """A guest is refused a customer filter or sort on either list, and still reads the plain lists."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    customer = _customer(client, workspace, "Acme")
    sign_in(client, GUEST)
    sign_in(issues_client, GUEST)
    issues = f"{_base(workspace)}/issues"
    projects = f"{_base(workspace)}/projects"

    assert issues_client.get(issues, params={"team_id": TEAM, "customer_id": customer}).status_code == 403
    assert issues_client.get(issues, params={"team_id": TEAM, "customer_id_not": "none"}).status_code == 403
    assert issues_client.get(issues, params={"team_id": TEAM, "sort": "customer_requests_desc"}).status_code == 403
    assert client.get(projects, params={"customer_id": customer}).status_code == 403
    assert client.get(projects, params={"sort": "customer_revenue_desc"}).status_code == 403
    assert issues_client.get(issues, params={"team_id": TEAM}).status_code == 200
    assert client.get(projects).status_code == 200


def test_the_lists_filter_and_sort_by_important_requests(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """Only requests marked important count toward the important filter and sort."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    acme = _customer(client, workspace, "Acme")
    many = seed_issue(issues_client, workspace, title="Many")["id"]
    flagged = seed_issue(issues_client, workspace, title="Flagged")["id"]
    quiet = seed_issue(issues_client, workspace, title="Quiet")["id"]
    _ask(client, workspace, "issue", many, acme)
    _ask(client, workspace, "issue", many, acme)
    _ask(client, workspace, "issue", flagged, acme, important=True)

    assert _issues(issues_client, workspace, customer_id="important") == [flagged]
    assert set(_issues(issues_client, workspace, customer_id_not="important")) == {many, quiet}
    assert _issues(issues_client, workspace, sort="customer_important_desc")[0] == flagged

    asked = seed_project(client, workspace, name="Asked")["project_id"]
    urgent = seed_project(client, workspace, name="Urgent")["project_id"]
    _ask(client, workspace, "project", asked, acme)
    _ask(client, workspace, "project", urgent, acme, important=True)

    assert [row["project_id"] for row in _projects(client, workspace, customer_id="important")] == [urgent]
    ordered = _projects(client, workspace, sort="customer_important_desc")
    assert [row["project_id"] for row in ordered] == [urgent, asked]
    assert [row["customer_important_count"] for row in ordered] == [1, 0]


def _profiled(repositories: Any, name: str, **fields: Any) -> str:
    """Store one customer with the given status, tier, revenue and size, answering its id."""
    return repositories.customers.create(
        Customer(workspace_id=WORKSPACE, name=name, created_by=MEMBER, **fields)
    ).customer_id


def _seed_profiles(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> "dict[str, str]":
    """An issue asked for by a large active customer, one by a small trial customer twice, one by none.

    The small customer carries the legacy `status` and `tier` strings, so the
    filters are held to read those as the seeded entries they map to.
    """
    big = _profiled(repositories, "Big", status_id="active", tier_id="tier-enterprise", revenue=900_000, size=5000)
    small = _profiled(repositories, "Small", status="trial", tier="Startup", revenue=1_000, size=4)
    large = seed_issue(issues_client, workspace, title="Large")["id"]
    modest = seed_issue(issues_client, workspace, title="Modest")["id"]
    quiet = seed_issue(issues_client, workspace, title="Quiet")["id"]
    _ask(client, workspace, "issue", large, big, important=True)
    _ask(client, workspace, "issue", modest, small)
    _ask(client, workspace, "issue", modest, small)
    return {"large": large, "modest": modest, "quiet": quiet}


def test_the_issue_list_filters_by_customer_fields(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """Status, tier, revenue, size, request count and the important flag narrow the issue list on the server."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    rows = _seed_profiles(client, issues_client, repositories, workspace)

    assert _issues(issues_client, workspace, customer_status_id="active") == [rows["large"]]
    assert _issues(issues_client, workspace, customer_status_id="trial") == [rows["modest"]]
    assert set(_issues(issues_client, workspace, customer_status_id_not="none")) == {rows["large"], rows["modest"]}
    assert _issues(issues_client, workspace, customer_tier_id=legacy_tier_id("Startup")) == [rows["modest"]]
    assert set(_issues(issues_client, workspace, customer_tier_id_not="tier-enterprise")) == {
        rows["modest"],
        rows["quiet"],
    }
    assert _issues(issues_client, workspace, customer_revenue_min=500_000) == [rows["large"]]
    assert _issues(issues_client, workspace, customer_size_max=10) == [rows["modest"]]
    assert _issues(issues_client, workspace, customer_request_count_min=2) == [rows["modest"]]
    assert _issues(issues_client, workspace, customer_request_count_max=0) == [rows["quiet"]]
    assert _issues(issues_client, workspace, customer_important="true") == [rows["large"]]
    grouped = '[{"match": "any", "customer_size_min": "1000", "customer_request_count_max": 0}]'
    assert set(_issues(issues_client, workspace, groups=grouped)) == {rows["large"], rows["quiet"]}

    issues = f"{_base(workspace)}/issues"
    assert issues_client.get(issues, params={"team_id": TEAM, "customer_revenue_min": -1}).status_code == 422
    sign_in(issues_client, GUEST)
    assert issues_client.get(issues, params={"team_id": TEAM, "customer_status_id": "active"}).status_code == 403
    assert issues_client.get(issues, params={"team_id": TEAM, "customer_important": "true"}).status_code == 403


def test_customer_field_filters_cost_one_planning_query(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Any mix of customer conditions reads customers and requests together, once, and never apart."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    rows = _seed_profiles(client, issues_client, repositories, workspace)
    calls: list[str] = []
    together = CustomerRepository.list_customers_and_requests

    def counted(self: CustomerRepository, *args: Any, **kwargs: Any) -> Any:
        """Count one combined read and answer it as the repository would."""
        calls.append("together")
        return together(self, *args, **kwargs)

    def refused(self: CustomerRepository, *args: Any, **kwargs: Any) -> Any:
        """Fail a separate read, which a profile filter must never make."""
        raise AssertionError("a customer field filter read customers or requests on their own")

    monkeypatch.setattr(CustomerRepository, "list_customers_and_requests", counted)
    monkeypatch.setattr(CustomerRepository, "list_customers", refused)
    monkeypatch.setattr(CustomerRepository, "list_requests", refused)

    found = _issues(
        issues_client,
        workspace,
        customer_status_id="active",
        customer_tier_id_not="none",
        customer_revenue_min=1,
        customer_size_min=1,
        customer_request_count_min=1,
        customer_important="true",
        groups='[{"customer_tier_id": "tier-enterprise", "customer_size_max": "9999"}]',
    )

    assert found == [rows["large"]]
    assert calls == ["together"]
