"""Isolation arguments for the team channel MCP tools."""

from __future__ import annotations

from typing import Any

ANSWERS_AT_HOME: frozenset[str] = frozenset()

SLACK_URL = "https://hooks.slack.com/services/T000/B000/isolation"


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """No extra rows: naming the other workspace's team is refused before any channel is read."""
    return {}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's team, one set per tool."""
    team = foreign["team_id"]
    channel = "01HZZZZZZZZZZZZZZZZZZZZZZZ"
    return {
        "list_channels": {"team_id": team},
        "create_channel": {"team_id": team, "url": SLACK_URL, "events": ["issue_created"]},
        "update_channel": {"team_id": team, "channel_id": channel, "label": "x"},
        "delete_channel": {"team_id": team, "channel_id": channel},
        "test_channel": {"team_id": team, "channel_id": channel},
    }
