"""The MCP `list_projects` tool's health, priority, member, date and update age filters.

The tool runs the route's own matcher, so these hold only that each argument
reaches it, `me` reads as the caller, the filters combine, and a value the
route refuses is a tool refusal rather than a silent empty page.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, MEMBER
from tests.domains.integrations.conftest import TEAM
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal


def _create(client: TestClient, secret: str, **fields: Any) -> "dict[str, Any]":
    """Create one project on the team through the tool."""
    return answer(tool(client, secret, "create_project", {"team_ids": [TEAM], **fields}))


def _names(client: TestClient, secret: str, **arguments: Any) -> set[str]:
    """The project names `list_projects` answers for these arguments."""
    return {row["name"] for row in answer(tool(client, secret, "list_projects", arguments))["projects"]}


def test_list_projects_takes_the_property_filters(client: TestClient, repositories: Any, workspace: str) -> None:
    """Health, priority, members with `me`, and both dates narrow the list, alone and together."""
    writer = mint_for(repositories, MEMBER, ("projects:write", "projects:read"))
    _create(client, writer, name="Mine", health="at_risk", priority="high", member_ids=["me"], target_date="2026-05-01")
    _create(client, writer, name="Theirs", health="at_risk", priority="low", member_ids=[ADMIN])
    _create(client, writer, name="Bare", start_date="2026-02-01")

    assert _names(client, writer, health="at_risk") == {"Mine", "Theirs"}
    assert _names(client, writer, health="none") == {"Bare"}
    assert _names(client, writer, priority=["high", "none"]) == {"Mine", "Bare"}
    assert _names(client, writer, member_id="me") == {"Mine"}
    assert _names(client, writer, member_id="none") == {"Bare"}
    assert _names(client, writer, target_date_before="2026-06-01") == {"Mine"}
    assert _names(client, writer, start_date_after="2026-01-01") == {"Bare"}
    assert _names(client, writer, health="at_risk", priority="low") == {"Theirs"}
    assert _names(client, writer, not_updated_within_days=7) == {"Mine", "Theirs", "Bare"}
    assert _names(client, writer, updated_within_days=7) == set()


def test_list_projects_refuses_a_malformed_filter(client: TestClient, repositories: Any, workspace: str) -> None:
    """An unknown health, a non day bound or a zero day age is a refusal."""
    reader = mint_for(repositories, MEMBER, ("projects:read",))

    assert refusal(tool(client, reader, "list_projects", {"health": "sunny"}))
    assert refusal(tool(client, reader, "list_projects", {"start_date_before": "June"}))
    assert refusal(tool(client, reader, "list_projects", {"updated_within_days": 0}))
