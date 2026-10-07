"""Private teams through the MCP tools.

The tools hold the routes' rules: a private team is absent to a credential
outside it, a team admin turns privacy on only on the Business plan, and a
workspace admin outside the team can still administer it without reading it.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.team_refs import team_not_found_message
from tests.domains.helpers import ADMIN, MEMBER, add_team_member
from tests.domains.integrations.conftest import TEAM, WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal


def test_update_team_turns_privacy_on_only_on_business(client: TestClient, repositories: Any, workspace: str) -> None:
    """The plan refusal comes back as a tool error, and on Business the flag lands."""
    secret = mint_for(repositories, ADMIN, ("teams:write", "teams:read"))
    repositories.workspaces.set_billing(WORKSPACE, plan="free")
    assert "Business" in refusal(tool(client, secret, "update_team", {"team_id": "ABC", "private": True})) or (
        "not included" in refusal(tool(client, secret, "update_team", {"team_id": "ABC", "private": True}))
    )
    assert repositories.memberships.is_private_team(WORKSPACE, TEAM) is False

    repositories.workspaces.set_billing(WORKSPACE, plan="business")
    updated = answer(tool(client, secret, "update_team", {"team_id": "ABC", "private": True}))
    assert updated["private"] is True
    assert repositories.memberships.is_private_team(WORKSPACE, TEAM) is True


def test_a_private_team_is_absent_to_a_credential_outside_it(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A member outside the team neither lists it nor reads it; a member on it does both."""
    repositories.memberships.set_team_private(WORKSPACE, TEAM, True)
    outsider = mint_for(repositories, MEMBER, ("teams:read", "issues:read"))

    listed = answer(tool(client, outsider, "list_teams", {}))
    assert TEAM not in {team["team_id"] for team in listed["teams"]}
    assert refusal(tool(client, outsider, "get_team", {"team_id": "ABC"})) == team_not_found_message("ABC")

    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "member")
    listed = answer(tool(client, outsider, "list_teams", {}))
    assert {team["team_id"]: team["private"] for team in listed["teams"]}[TEAM] is True


def test_a_workspace_admin_administers_a_private_team_without_reading_it(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """Renaming works by key, while the team's content stays out of reach until they join."""
    repositories.memberships.set_team_private(WORKSPACE, TEAM, True)
    secret = mint_for(repositories, ADMIN, ("teams:write", "teams:read"))

    renamed = answer(tool(client, secret, "update_team", {"team_id": "ABC", "name": "Vault"}))
    assert renamed["name"] == "Vault"
    assert refusal(tool(client, secret, "get_team", {"team_id": "ABC"})) == team_not_found_message("ABC")
