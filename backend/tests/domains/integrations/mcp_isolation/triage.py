"""Isolation arguments for the triage MCP tools."""

from __future__ import annotations

from typing import Any

ANSWERS_AT_HOME: frozenset[str] = frozenset({"get_triage_summary"})


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """No extra foreign rows: the triage tools name the foreign team and issue."""
    return {}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's rows, one set per tool."""
    issue = foreign["issue_id"]
    return {
        "list_triage_issues": {"team_id": foreign["team_id"]},
        "get_triage_summary": {},
        "triage_issue": {"issue_id": issue, "action": "accept"},
        "update_team_triage_settings": {"team_id": foreign["team_id"], "enabled": True},
    }
