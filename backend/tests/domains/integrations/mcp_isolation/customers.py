"""Isolation arguments for the customer MCP tools."""

from __future__ import annotations

from typing import Any

from app.common.db.dynamo.customers import Customer, CustomerRequest
from tests.domains.helpers import OWNER

ANSWERS_AT_HOME: frozenset[str] = frozenset({"list_customers", "create_customer"})


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """A customer of the other workspace with one request for its project, so their ids can be named."""
    project = repositories.planning.list_projects(workspace_id)[0]
    customer = Customer(
        workspace_id=workspace_id, name="Classified customer", domains=["classified.example"], created_by=OWNER
    )
    repositories.customers.create(customer)
    request = CustomerRequest(
        workspace_id=workspace_id,
        customer_id=customer.customer_id,
        target_kind="project",
        target_id=project.project_id,
        team_ids=[team_id],
        body="Classified quote",
        author_id=OWNER,
    )
    repositories.customers.add_request(request)
    return {"customer_id": customer.customer_id, "customer_request_id": request.request_id}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's rows, one set per tool."""
    customer = foreign["customer_id"]
    request = foreign["customer_request_id"]
    project = foreign["project_id"]
    return {
        "list_customers": {},
        "create_customer": {"name": "Lands at home"},
        "update_customer": {"customer_id": customer, "name": "Should not land"},
        "merge_customers": {"customer_id": customer, "into_customer_id": customer},
        "delete_customer": {"customer_id": customer},
        "create_customer_request": {"customer_id": customer, "project_id": project, "body": "Should not land"},
        "list_customer_requests": {"customer_id": customer},
        "delete_customer_request": {"customer_id": customer, "request_id": request},
    }
