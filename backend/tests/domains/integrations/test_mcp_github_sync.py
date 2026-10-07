"""The GitHub issue sync MCP tools, the public repository setting included."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.domains.integrations.mcp.tools import TOOLS_BY_NAME
from app.domains.integrations.team_sync import PUBLIC_TWO_WAY
from tests.domains.helpers import ADMIN, MEMBER
from tests.domains.integrations.conftest import REPOSITORY_FULL_NAME, REPOSITORY_ID, TEAM, WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal


def test_the_tools_need_the_team_scopes() -> None:
    """Reading is `teams:read`, changing is `teams:write`."""
    assert TOOLS_BY_NAME["get_team_github_sync"].scopes == ("teams:read",)
    assert TOOLS_BY_NAME["update_team_github_sync"].scopes == ("teams:write",)


def test_a_team_without_a_link_reads_as_unlinked(client: TestClient, repositories: Any, installed: str) -> None:
    """No link is an answer, not an error."""
    secret = mint_for(repositories, MEMBER, ("teams:read",))

    read = answer(tool(client, secret, "get_team_github_sync", {"team_id": "ABC"}))

    assert read == {"team_id": TEAM, "linked": False}


def test_an_admin_links_by_full_name_and_changes_one_setting(
    client: TestClient, repositories: Any, installed: str
) -> None:
    """The repository resolves by owner/name, and a later call keeps what it does not name."""
    secret = mint_for(repositories, ADMIN, ("teams:write", "teams:read"))

    linked = answer(
        tool(client, secret, "update_team_github_sync", {"team_id": TEAM, "repository": REPOSITORY_FULL_NAME})
    )
    changed = answer(tool(client, secret, "update_team_github_sync", {"team_id": TEAM, "sync_labels": False}))
    read = answer(tool(client, secret, "get_team_github_sync", {"team_id": TEAM}))

    assert linked["linked"] is True
    assert linked["repository_id"] == REPOSITORY_ID
    assert linked["direction"] == "two_way"
    assert changed["sync_labels"] is False
    assert changed["repository_id"] == REPOSITORY_ID
    assert read == changed


def test_an_unlinked_team_needs_a_repository(client: TestClient, repositories: Any, installed: str) -> None:
    """There is nothing to keep, so the repository is required."""
    secret = mint_for(repositories, ADMIN, ("teams:write",))

    text = refusal(tool(client, secret, "update_team_github_sync", {"team_id": TEAM, "enabled": False}))

    assert "name a repository" in text


def test_two_way_on_a_public_repository_follows_the_setting(
    client: TestClient, repositories: Any, installed: str
) -> None:
    """Refused while the setting is off, saved once an agent turns it on."""
    repositories.github.set_repository_private(WORKSPACE, REPOSITORY_ID, False)
    secret = mint_for(repositories, ADMIN, ("teams:write",))

    text = refusal(tool(client, secret, "update_team_github_sync", {"team_id": TEAM, "repository": REPOSITORY_ID}))
    saved = answer(
        tool(
            client,
            secret,
            "update_team_github_sync",
            {"team_id": TEAM, "repository": REPOSITORY_ID, "allow_public_two_way": True},
        )
    )

    assert PUBLIC_TWO_WAY in text
    assert saved["direction"] == "two_way"
    assert saved["allow_public_two_way"] is True
    assert saved["repository_private"] is False


def test_a_member_may_not_change_the_link(client: TestClient, repositories: Any, installed: str) -> None:
    """Changing the sync needs team admin, as the route does."""
    secret = mint_for(repositories, MEMBER, ("teams:write",))

    refusal(tool(client, secret, "update_team_github_sync", {"team_id": TEAM, "repository": REPOSITORY_ID}))

    assert repositories.github.get_team_sync(WORKSPACE, TEAM) is None
