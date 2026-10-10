"""Isolation arguments for the GitHub issue sync and repository pin MCP tools."""

from __future__ import annotations

from typing import Any

ANSWERS_AT_HOME: frozenset[str] = frozenset()


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """No extra rows: the tools name only the other workspace's team."""
    return {}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's team, one set per tool."""
    team = foreign["team_id"]
    return {
        "get_team_github_sync": {"team_id": team},
        "update_team_github_sync": {"team_id": team, "allow_public_two_way": True},
        "pin_team_repository": {"team_id": team, "repository": "1"},
    }
