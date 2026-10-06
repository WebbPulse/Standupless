"""Isolation arguments for the workspace status and label tools and the team overrides of them."""

from __future__ import annotations

from typing import Any

from app.common import team_workflow
from app.common.api.schemas.teams import LabelCreate, StatusCreate

ANSWERS_AT_HOME: frozenset[str] = frozenset(
    {"list_workspace_statuses", "create_workspace_status", "list_workspace_labels", "create_workspace_label"}
)


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """A workspace status and label in the other workspace, by id."""
    status = team_workflow.create_workspace_status(
        repositories, workspace_id, StatusCreate(name="Foreign review", category="started")
    )
    label = team_workflow.create_workspace_label(
        repositories, workspace_id, LabelCreate(name="Foreign", color="#5e6ad2")
    )
    return {"workspace_status_id": status.status_id, "workspace_label_id": label.label_id}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's rows, one set per tool."""
    team = foreign["team_id"]
    status = foreign["workspace_status_id"]
    label = foreign["workspace_label_id"]
    return {
        "list_workspace_statuses": {},
        "create_workspace_status": {"name": "Home only", "category": "started"},
        "update_workspace_status": {"status": status, "name": "Should not land"},
        "delete_workspace_status": {"status": status},
        "list_workspace_labels": {},
        "create_workspace_label": {"name": "Home only", "color": "#5e6ad2"},
        "update_workspace_label": {"label": label, "name": "Should not land"},
        "delete_workspace_label": {"label": label},
        "override_team_status": {"team_id": team, "status": status, "hidden": True},
        "reset_team_status_override": {"team_id": team, "status": status},
        "override_team_label": {"team_id": team, "label": label, "hidden": True},
        "reset_team_label_override": {"team_id": team, "label": label},
    }
