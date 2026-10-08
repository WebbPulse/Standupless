"""Isolation arguments for the initiative MCP tools."""

from __future__ import annotations

from typing import Any

from app.common.db.dynamo.planning import Initiative, InitiativeUpdateRow, initiative_key, initiative_update_key
from tests.domains.helpers import OWNER

ANSWERS_AT_HOME: frozenset[str] = frozenset({"list_initiatives", "create_initiative"})


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """An initiative holding the other workspace's project, with one update, so their ids can be named."""
    initiative = Initiative(workspace_id=workspace_id, planning_key="", name="Classified initiative", created_by=OWNER)
    initiative.planning_key = initiative_key(initiative.initiative_id)
    repositories.planning.create_initiative(initiative)
    project = repositories.planning.list_projects(workspace_id)[0]
    repositories.planning.set_project_initiative(workspace_id, project.project_id, initiative.initiative_id)
    update = InitiativeUpdateRow(
        workspace_id=workspace_id,
        planning_key="",
        initiative_id=initiative.initiative_id,
        body="Classified update",
        health="on_track",
        author_id=OWNER,
    )
    update.planning_key = initiative_update_key(initiative.initiative_id, update.update_id)
    repositories.planning.create_initiative_update(update)
    return {"initiative_id": initiative.initiative_id, "initiative_update_id": update.update_id}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's rows, one set per tool."""
    initiative = foreign["initiative_id"]
    project = foreign["project_id"]
    update = foreign["initiative_update_id"]
    return {
        "list_initiatives": {},
        "get_initiative": {"initiative_id": initiative},
        "create_initiative": {"name": "Lands at home"},
        "update_initiative": {"initiative_id": initiative, "name": "Should not land"},
        "delete_initiative": {"initiative_id": initiative},
        "add_project_to_initiative": {"initiative_id": initiative, "project_id": project},
        "remove_project_from_initiative": {"initiative_id": initiative, "project_id": project},
        "list_initiative_updates": {"initiative_id": initiative},
        "create_initiative_update": {"initiative_id": initiative, "body": "Should not land", "health": "off_track"},
        "update_initiative_update": {"initiative_id": initiative, "update_id": update, "body": "Should not land"},
        "delete_initiative_update": {"initiative_id": initiative, "update_id": update},
    }
