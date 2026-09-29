"""The GitHub transition MCP tools, and status names accepted where a status id is."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.issues import Issue
from app.domains.integrations.mcp.tools import TOOLS_BY_NAME
from tests.domains.helpers import ADMIN, MEMBER
from tests.domains.integrations.conftest import TEAM, WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

PRESET = [
    {"trigger": "pr_opened", "status": "In Progress"},
    {"trigger": "pr_ready_for_review", "status": "In Progress"},
    {"trigger": "pr_merged", "branch": "staging", "status": "Todo"},
    {"trigger": "pr_merged", "branch": "main", "status": "done"},
]


def status_id_named(repositories: Any, name: str) -> str:
    """The seeded team's status id with this name."""
    return next(row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, TEAM) if row.name == name)


def test_the_tools_need_the_team_scopes() -> None:
    """Reading is `teams:read`, replacing is `teams:write`."""
    assert TOOLS_BY_NAME["list_github_transitions"].scopes == ("teams:read",)
    assert TOOLS_BY_NAME["set_github_transitions"].scopes == ("teams:write",)


def test_a_team_on_the_defaults_lists_them(client: TestClient, repositories: Any, workspace: str) -> None:
    """With nothing stored the design defaults are listed and marked."""
    secret = mint_for(repositories, MEMBER, ("teams:read",))

    listed = answer(tool(client, secret, "list_github_transitions", {"team_id": "ABC"}))

    assert listed["uses_defaults"] is True
    assert {row["trigger"] for row in listed["rules"]} == {"pr_opened", "pr_merged"}


def test_an_admin_sets_the_preset_by_status_name(client: TestClient, repositories: Any, workspace: str) -> None:
    """Statuses resolve by name, case-insensitively, and the set reads back as stored."""
    secret = mint_for(repositories, ADMIN, ("teams:write", "teams:read"))

    saved = answer(tool(client, secret, "set_github_transitions", {"team_id": TEAM, "rules": PRESET}))
    listed = answer(tool(client, secret, "list_github_transitions", {"team_id": TEAM}))

    assert saved == listed
    assert saved["uses_defaults"] is False
    by_branch = {(row["trigger"], row["branch"]): row for row in saved["rules"]}
    assert by_branch[("pr_merged", "main")]["status_id"] == status_id_named(repositories, "Done")
    assert by_branch[("pr_merged", "main")]["status"] == "Done"
    assert by_branch[("pr_merged", "staging")]["status"] == "Todo"
    assert by_branch[("pr_opened", None)]["status"] == "In Progress"


def test_an_empty_set_restores_the_defaults(client: TestClient, repositories: Any, workspace: str) -> None:
    """Clearing the rules goes back to the design section 4 behaviour."""
    secret = mint_for(repositories, ADMIN, ("teams:write",))
    answer(tool(client, secret, "set_github_transitions", {"team_id": TEAM, "rules": PRESET}))

    restored = answer(tool(client, secret, "set_github_transitions", {"team_id": TEAM, "rules": []}))

    assert restored["uses_defaults"] is True
    assert repositories.team_config.list_transitions(WORKSPACE, TEAM) == []


def test_a_member_may_not_set_the_rules(client: TestClient, repositories: Any, workspace: str) -> None:
    """Replacing the set is team admin, as the route is."""
    secret = mint_for(repositories, MEMBER, ("teams:write",))

    refusal(tool(client, secret, "set_github_transitions", {"team_id": TEAM, "rules": []}))

    assert repositories.team_config.list_transitions(WORKSPACE, TEAM) == []


def test_an_unknown_status_or_a_bad_branch_writes_nothing(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A status the team lacks and a branch no git ref could be are refused before any write."""
    secret = mint_for(repositories, ADMIN, ("teams:write",))

    unknown = refusal(
        tool(
            client,
            secret,
            "set_github_transitions",
            {"team_id": TEAM, "rules": [{"trigger": "pr_merged", "status": "Shipped"}]},
        )
    )
    bad = refusal(
        tool(
            client,
            secret,
            "set_github_transitions",
            {"team_id": TEAM, "rules": [{"trigger": "pr_merged", "branch": "a b", "status": "Done"}]},
        )
    )

    assert "Shipped" in unknown
    assert "branch" in bad.lower()
    assert repositories.team_config.list_transitions(WORKSPACE, TEAM) == []


def test_update_issue_takes_a_status_name(client: TestClient, repositories: Any, issue: Issue) -> None:
    """`status_id` accepts the status's name as well as its id."""
    secret = mint_for(repositories, MEMBER, ("issues:write",))

    moved = answer(tool(client, secret, "update_issue", {"issue_id": "ABC-1", "status_id": "in progress"}))

    assert moved["status_id"] == status_id_named(repositories, "In Progress")


def test_create_issue_takes_a_status_name(client: TestClient, repositories: Any, workspace: str) -> None:
    """A new issue can start in a status named rather than by id."""
    secret = mint_for(repositories, MEMBER, ("issues:write",))

    created = answer(
        tool(client, secret, "create_issue", {"team_id": TEAM, "title": "Named status", "status_id": "Todo"})
    )

    assert created["status_id"] == status_id_named(repositories, "Todo")
