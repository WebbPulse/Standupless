"""Isolation arguments for the GitHub transition MCP tools."""

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
        "list_github_transitions": {"team_id": team},
        "set_github_transitions": {"team_id": team, "rules": [{"trigger": "pr_merged", "branch": "main"}]},
    }
