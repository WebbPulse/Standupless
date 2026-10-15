"""Isolation arguments for the favorites MCP tools.

Favorites are keyed by the credential's own user in the key's own workspace, so
listing answers from home, and removing a foreign target answers removed=false
from the caller's own row rather than a refusal. Starring or reordering a foreign
row refuses, because its target never resolves.
"""

from __future__ import annotations

from typing import Any

ANSWERS_AT_HOME: frozenset[str] = frozenset({"list_favorites", "remove_favorite"})


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """No extra rows: the foreign issue, team and project are enough."""
    return {}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's rows, one set per tool."""
    return {
        "list_favorites": {},
        "add_favorite": {"kind": "issue", "target": foreign["issue_id"]},
        "remove_favorite": {"kind": "team", "target": foreign["team_id"]},
        "reorder_favorites": {"order": [{"kind": "project", "target": foreign["project_id"]}]},
    }
