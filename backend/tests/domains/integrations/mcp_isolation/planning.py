"""Isolation arguments for the planning MCP tools added beyond the original set."""

from __future__ import annotations

from typing import Any

from app.common.db.dynamo.planning import ProjectUpdateRow, project_update_key
from tests.domains.helpers import OWNER

ANSWERS_AT_HOME: frozenset[str] = frozenset()


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """A status update on the other workspace's project, so an update id can be named."""
    project = repositories.planning.list_projects(workspace_id)[0]
    update = ProjectUpdateRow(
        workspace_id=workspace_id,
        planning_key="",
        project_id=project.project_id,
        body="Foreign update",
        health="on_track",
        author_id=OWNER,
    )
    update.planning_key = project_update_key(project.project_id, update.update_id)
    repositories.planning.create_project_update(update)
    return {"update_id": update.update_id}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's rows, one set per tool."""
    team = foreign["team_id"]
    cycle = foreign["cycle_id"]
    project = foreign["project_id"]
    milestone = foreign["milestone_id"]
    issues = [foreign["issue_id"]]
    return {
        "create_cycle": {
            "team_id": team,
            "name": "Should not land",
            "start_date": "2026-01-01",
            "end_date": "2026-01-14",
        },
        "update_cycle": {"team_id": team, "cycle_id": cycle, "name": "Should not land"},
        "delete_cycle": {"team_id": team, "cycle_id": cycle},
        "add_issues_to_cycle": {"team_id": team, "cycle_id": cycle, "issue_ids": issues},
        "remove_issues_from_cycle": {"team_id": team, "cycle_id": cycle, "issue_ids": issues},
        "create_milestone": {"project_id": project, "name": "Should not land"},
        "update_milestone": {"project_id": project, "milestone_id": milestone, "name": "Should not land"},
        "delete_milestone": {"project_id": project, "milestone_id": milestone},
        "delete_project": {"project_id": project},
        "update_project_update": {"project_id": project, "update_id": foreign["update_id"], "body": "Should not land"},
        "delete_project_update": {"project_id": project, "update_id": foreign["update_id"]},
    }
