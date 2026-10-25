"""Isolation arguments for the planning MCP tools added beyond the original set."""

from __future__ import annotations

from typing import Any

from app.common.db.dynamo.planning import ProjectLabel, ProjectLink, ProjectUpdateRow, project_update_key
from tests.domains.helpers import OWNER

ANSWERS_AT_HOME: frozenset[str] = frozenset({"list_project_labels", "create_project_label"})


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """A status update, a Resources link and a project label in the other workspace, so their ids can be named."""
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
    label = ProjectLabel(workspace_id=workspace_id, name="Foreign label", color="#5e6ad2", created_by=OWNER)
    repositories.planning.put_project_label(label, create=True)
    link = ProjectLink(
        workspace_id=workspace_id,
        project_id=project.project_id,
        url="https://example.com/foreign",
        title="Foreign link",
        sort_order="V",
        created_by=OWNER,
    )
    repositories.planning.put_project_link(link, create=True)
    return {"update_id": update.update_id, "project_label_id": label.label_id, "link_id": link.link_id}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's rows, one set per tool."""
    team = foreign["team_id"]
    cycle = foreign["cycle_id"]
    project = foreign["project_id"]
    milestone = foreign["milestone_id"]
    issues = [foreign["issue_id"]]
    return {
        "list_project_labels": {},
        "create_project_label": {"name": "Home only", "color": "#5e6ad2"},
        "update_project_label": {"label": foreign["project_label_id"], "name": "Should not land"},
        "delete_project_label": {"label": foreign["project_label_id"]},
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
        "archive_project": {"project_id": project},
        "unarchive_project": {"project_id": project},
        "create_project_link": {"project_id": project, "url": "https://example.com/should-not-land"},
        "update_project_link": {"project_id": project, "link_id": foreign["link_id"], "title": "Should not land"},
        "delete_project_link": {"project_id": project, "link_id": foreign["link_id"]},
        "update_project_update": {"project_id": project, "update_id": foreign["update_id"], "body": "Should not land"},
        "delete_project_update": {"project_id": project, "update_id": foreign["update_id"]},
        "list_project_update_comments": {"project_id": project, "update_id": foreign["update_id"]},
        "add_project_update_comment": {
            "project_id": project,
            "update_id": foreign["update_id"],
            "body": "Should not land",
        },
        "react_to_project_update": {"project_id": project, "update_id": foreign["update_id"], "emoji": "👍"},
    }
