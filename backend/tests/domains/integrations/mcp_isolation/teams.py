"""Isolation arguments for the teams MCP tools added beyond the original set."""

from __future__ import annotations

from typing import Any

ANSWERS_AT_HOME: frozenset[str] = frozenset({"create_team"})


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """Extra rows in the other workspace this area's tools name, by id."""
    statuses = repositories.team_config.list_statuses(workspace_id, team_id)
    return {"team_status_id": statuses[0].status_id}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's rows, one set per tool."""
    team = foreign["team_id"]
    status = foreign["team_status_id"]
    label = foreign["label_id"]
    return {
        "create_team": {"name": "Should not land", "key_prefix": "SNL"},
        "update_team": {"team_id": team, "name": "Should not land"},
        "delete_team": {"team_id": team},
        "update_team_cycle_settings": {"team_id": team, "enabled": True},
        "update_team_archive_settings": {"team_id": team, "period_months": 1},
        "list_team_members": {"team_id": team},
        "add_team_member": {"team_id": team, "user": "me", "role": "admin"},
        "update_team_member_role": {"team_id": team, "user": "me", "role": "member"},
        "remove_team_member": {"team_id": team, "user": "me"},
        "join_team": {"team_id": "OTH"},
        "leave_team": {"team_id": team},
        "create_status": {"team_id": team, "name": "Should not land", "category": "started"},
        "update_status": {"team_id": team, "status": status, "name": "Should not land"},
        "delete_status": {"team_id": team, "status": status},
        "update_label": {"team_id": team, "label": label, "name": "Should not land"},
        "delete_label": {"team_id": team, "label": label},
    }
