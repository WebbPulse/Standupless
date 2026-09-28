"""Isolation arguments for the planning MCP tools added beyond the original set."""

from __future__ import annotations

from typing import Any

ANSWERS_AT_HOME: frozenset[str] = frozenset()


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """Extra rows in the other workspace this area's tools name, by id."""
    return {}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's rows, one set per tool."""
    return {}
