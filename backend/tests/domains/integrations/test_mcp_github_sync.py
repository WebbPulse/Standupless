"""The GitHub issue sync MCP tools, the public repository setting included."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.domains.integrations.mcp.tools import TOOLS_BY_NAME
from app.domains.integrations.team_sync import PUBLIC_TWO_WAY
from tests.domains.helpers import ADMIN, MEMBER
from tests.domains.integrations.conftest import OTHER_TEAM, REPOSITORY_FULL_NAME, REPOSITORY_ID, TEAM, WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal


def test_the_tools_need_the_team_scopes() -> None:
    """Reading is `teams:read`, changing is `teams:write`."""
    assert TOOLS_BY_NAME["get_team_github_sync"].scopes == ("teams:read",)
    assert TOOLS_BY_NAME["update_team_github_sync"].scopes == ("teams:write",)
    assert TOOLS_BY_NAME["pin_team_repository"].scopes == ("teams:write",)


def test_a_team_without_a_link_reads_as_unlinked(client: TestClient, repositories: Any, installed: str) -> None:
    """No link is an answer, not an error."""
    secret = mint_for(repositories, MEMBER, ("teams:read",))

    read = answer(tool(client, secret, "get_team_github_sync", {"team_id": "ABC"}))

    assert read == {"team_id": TEAM, "linked": False, "pinned_repositories": [], "release_sources": {}}


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


def _pin(repositories: Any) -> str | None:
    """The team the test repository is pinned to, or `None`."""
    row = repositories.github.get_repository(WORKSPACE, REPOSITORY_ID)
    assert row is not None
    return row.team_id


def test_a_pinned_repository_reads_on_an_unlinked_team(client: TestClient, repositories: Any, installed: str) -> None:
    """A pin is a link of its own, so a team with no issue sync still shows what it releases from."""
    repositories.github.set_repository_team(WORKSPACE, REPOSITORY_ID, TEAM)
    secret = mint_for(repositories, MEMBER, ("teams:read",))

    read = answer(tool(client, secret, "get_team_github_sync", {"team_id": TEAM}))

    assert read == {
        "team_id": TEAM,
        "linked": False,
        "pinned_repositories": [REPOSITORY_FULL_NAME],
        "release_sources": {
            REPOSITORY_FULL_NAME: {"kind": "deployments", "tag_pattern": None, "status_id": None, "move_issues": True}
        },
    }


def test_an_admin_pins_and_unpins_without_starting_a_sync(
    client: TestClient, repositories: Any, installed: str
) -> None:
    """Pinning sets the repository's team and leaves issue sync alone; pinned false clears it."""
    secret = mint_for(repositories, ADMIN, ("teams:write",))

    pinned = answer(tool(client, secret, "pin_team_repository", {"team_id": "ABC", "repository": REPOSITORY_FULL_NAME}))
    stored = _pin(repositories)
    unpinned = answer(
        tool(client, secret, "pin_team_repository", {"team_id": TEAM, "repository": REPOSITORY_ID, "pinned": False})
    )

    assert pinned["pinned_repositories"] == [REPOSITORY_FULL_NAME]
    assert pinned["linked"] is False
    assert stored == TEAM
    assert repositories.github.get_team_sync(WORKSPACE, TEAM) is None
    assert unpinned["pinned_repositories"] == []
    assert _pin(repositories) is None


def test_a_repository_pinned_elsewhere_is_not_taken_over(client: TestClient, repositories: Any, installed: str) -> None:
    """Another team's pin is refused, and unpinning from the wrong team changes nothing."""
    repositories.github.set_repository_team(WORKSPACE, REPOSITORY_ID, OTHER_TEAM)
    secret = mint_for(repositories, ADMIN, ("teams:write",))

    text = refusal(tool(client, secret, "pin_team_repository", {"team_id": TEAM, "repository": REPOSITORY_ID}))
    answer(tool(client, secret, "pin_team_repository", {"team_id": TEAM, "repository": REPOSITORY_ID, "pinned": False}))

    assert "pinned to another team" in text
    assert _pin(repositories) == OTHER_TEAM


def test_a_member_may_not_pin(client: TestClient, repositories: Any, installed: str) -> None:
    """Pinning needs workspace admin, as the repositories route does."""
    secret = mint_for(repositories, MEMBER, ("teams:write",))

    refusal(tool(client, secret, "pin_team_repository", {"team_id": TEAM, "repository": REPOSITORY_ID}))

    assert _pin(repositories) is None


def test_a_pin_chooses_the_release_source_and_keeps_what_it_does_not_name(
    client: TestClient, repositories: Any, installed: str
) -> None:
    """Tags with a pattern and a status by name are stored, a later call changes one part, and bad input is refused."""
    secret = mint_for(repositories, ADMIN, ("teams:write",))
    started = next(row for row in repositories.team_config.list_statuses(WORKSPACE, TEAM) if row.category == "started")

    pinned = answer(
        tool(
            client,
            secret,
            "pin_team_repository",
            {
                "team_id": TEAM,
                "repository": REPOSITORY_ID,
                "release_source": "tags",
                "tag_pattern": "python-v*",
                "release_status": started.name,
            },
        )
    )
    moved = answer(
        tool(
            client, secret, "pin_team_repository", {"team_id": TEAM, "repository": REPOSITORY_ID, "move_issues": False}
        )
    )
    unknown = refusal(
        tool(
            client,
            secret,
            "pin_team_repository",
            {"team_id": TEAM, "repository": REPOSITORY_ID, "release_status": "Nowhere"},
        )
    )

    assert pinned["release_sources"][REPOSITORY_FULL_NAME] == {
        "kind": "tags",
        "tag_pattern": "python-v*",
        "status_id": started.status_id,
        "move_issues": True,
    }
    assert moved["release_sources"][REPOSITORY_FULL_NAME]["move_issues"] is False
    assert moved["release_sources"][REPOSITORY_FULL_NAME]["tag_pattern"] == "python-v*"
    assert "Nowhere" in unknown
    stored = repositories.github.get_repository(WORKSPACE, REPOSITORY_ID)
    assert stored.release_source.kind == "tags"
