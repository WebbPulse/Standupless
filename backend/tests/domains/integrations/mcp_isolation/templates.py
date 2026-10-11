"""Isolation arguments for the issue template tools."""

from __future__ import annotations

from typing import Any

from app.common.db.dynamo.team_templates import IssueTemplate, template_key

ANSWERS_AT_HOME: frozenset[str] = frozenset()

FOREIGN_TEAM_TEMPLATE = "01JB0000000000000000000TP1"

FOREIGN_WORKSPACE_TEMPLATE = "01JB0000000000000000000TP2"


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """A team template and a workspace template in the other workspace, by id."""
    for template_id, owner in ((FOREIGN_TEAM_TEMPLATE, team_id), (FOREIGN_WORKSPACE_TEMPLATE, None)):
        repositories.team_config.create_template(
            IssueTemplate(
                workspace_id=workspace_id,
                config_key=template_key(owner, template_id),
                template_id=template_id,
                team_id=owner,
                name="Foreign template",
            )
        )
    return {"team_template_id": FOREIGN_TEAM_TEMPLATE, "workspace_template_id": FOREIGN_WORKSPACE_TEMPLATE}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's rows, one set per tool."""
    team = foreign["team_id"]
    team_template = foreign["team_template_id"]
    workspace_template = foreign["workspace_template_id"]
    return {
        "list_templates": {"team_id": team},
        "create_template": {"team_id": team, "name": "Should not land"},
        "update_template": {"template": workspace_template, "name": "Should not land"},
        "delete_template": {"team_id": team, "template": team_template},
    }
