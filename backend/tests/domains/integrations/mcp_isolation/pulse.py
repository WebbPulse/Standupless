"""Isolation arguments for the Pulse MCP tools.

The feed and its read marker are the credential's own in the key's own
workspace, so listing and marking read answer from home. Following or
unfollowing a foreign project or initiative refuses, because its id never
resolves.
"""

from __future__ import annotations

from typing import Any

ANSWERS_AT_HOME: frozenset[str] = frozenset({"list_pulse", "mark_pulse_read"})


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """No extra rows: the foreign project and the initiatives area's initiative are enough."""
    return {}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's rows, one set per tool."""
    return {
        "list_pulse": {},
        "mark_pulse_read": {},
        "follow_project": {"project_id": foreign["project_id"]},
        "unfollow_project": {"project_id": foreign["project_id"]},
        "follow_initiative": {"initiative_id": foreign["initiative_id"]},
        "unfollow_initiative": {"initiative_id": foreign["initiative_id"]},
    }
