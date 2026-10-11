"""Isolation arguments for the Reviews list MCP tool."""

from __future__ import annotations

from typing import Any

ANSWERS_AT_HOME: frozenset[str] = frozenset({"list_my_reviews"})


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """No extra foreign rows: the tool takes no id, so it can only answer from the key's workspace."""
    return {}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """The tool takes no arguments, so there is nothing foreign to name."""
    return {"list_my_reviews": {}}
