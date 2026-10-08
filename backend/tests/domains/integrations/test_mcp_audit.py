"""The `list_audit_events` MCP tool.

It runs the same `app.common.audit.list_page` the audit log route runs, so these
hold that an owner or admin reads the log through it with the route's filters, a
member is refused, and a plan without the audit log is refused by name rather than
answered with an empty page.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common import audit
from app.domains.integrations.mcp.tools import TOOLS_BY_NAME
from tests.domains.helpers import ADMIN, MEMBER, OWNER
from tests.domains.integrations.conftest import WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

SCOPES = ("settings:read", "admin")


def business(repositories: Any) -> None:
    """Put the fixture workspace on the plan that includes the audit log."""
    repositories.workspaces.set_billing(WORKSPACE, plan="business")


def test_an_admin_reads_the_log_with_filters(client: TestClient, repositories: Any, workspace: str) -> None:
    business(repositories)
    audit.record_system(repositories, WORKSPACE, "plan.changed", actor_id="stripe")
    audit.record_system(repositories, WORKSPACE, "team.created", actor_id=OWNER, actor_kind="user", source="web")
    secret = mint_for(repositories, ADMIN, SCOPES)

    everything = answer(tool(client, secret, "list_audit_events"))
    by_owner = answer(tool(client, secret, "list_audit_events", {"actor": "owner@example.com"}))
    by_event = answer(tool(client, secret, "list_audit_events", {"event": "plan.changed"}))

    assert {row["event"] for row in everything["events"]} == {"plan.changed", "team.created"}
    assert [row["event"] for row in by_owner["events"]] == ["team.created"]
    assert by_owner["events"][0]["actor_name"] == "Olive Owner"
    assert [row["actor_id"] for row in by_event["events"]] == ["stripe"]
    assert "available" not in everything


def test_the_tool_pages_with_a_cursor(client: TestClient, repositories: Any, workspace: str) -> None:
    business(repositories)
    for _ in range(3):
        audit.record_system(repositories, WORKSPACE, "plan.changed")
    secret = mint_for(repositories, OWNER, SCOPES)

    first = answer(tool(client, secret, "list_audit_events", {"limit": 2}))
    second = answer(tool(client, secret, "list_audit_events", {"limit": 2, "cursor": first["next_cursor"]}))

    assert len(first["events"]) == 2
    assert len(second["events"]) == 1
    assert second["next_cursor"] is None


def test_a_bad_date_is_refused(client: TestClient, repositories: Any, workspace: str) -> None:
    business(repositories)
    secret = mint_for(repositories, ADMIN, SCOPES)

    assert "ISO 8601" in refusal(tool(client, secret, "list_audit_events", {"since": "last tuesday"}))


def test_a_plan_without_the_audit_log_is_refused_by_name(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    audit.record_system(repositories, WORKSPACE, "plan.changed")
    secret = mint_for(repositories, ADMIN, SCOPES)

    assert "Business plan" in refusal(tool(client, secret, "list_audit_events"))


def test_a_member_cannot_read_the_log(client: TestClient, repositories: Any, workspace: str) -> None:
    business(repositories)
    secret = mint_for(repositories, MEMBER, ("settings:read",))

    body = tool(client, secret, "list_audit_events").json()

    assert "error" in body or body["result"]["isError"] is True


def test_the_tool_only_reads() -> None:
    found = TOOLS_BY_NAME["list_audit_events"]

    assert found.scopes == SCOPES
    assert found.destructive is False
