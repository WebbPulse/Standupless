"""The project template MCP tools: `kind` on the template tools and `template_id` on create_project.

An agent saves a project template the way the settings page does, finds it by
name, and creates a project from it that starts with the template's milestones
and issues, with `me` resolved to the agent's person throughout.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import MEMBER
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM, WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

SCOPES = ("teams:read", "teams:write", "projects:read", "projects:write", "issues:read", "issues:write")

PROJECT: dict[str, Any] = {
    "lead_id": "me",
    "status": "planned",
    "target_offset_days": 14,
    "milestones": [{"key": "build", "name": "Build"}],
    "issues": [
        {"key": "epic", "title": "Build it", "milestone_key": "build", "assignee_id": "me"},
        {"title": "Test it", "parent_key": "epic"},
    ],
}


def _save(client: TestClient, secret: str) -> dict[str, Any]:
    """Save the project template on the team through the tool and answer it."""
    arguments = {"team_id": TEAM, "kind": "project", "name": "Launch", "project": PROJECT}
    return answer(tool(client, secret, "create_template", arguments))


def test_a_project_template_is_saved_and_listed_by_kind(client: TestClient, workspace: str, repositories: Any) -> None:
    """kind project saves a project template, with `me` resolved, and only the project list carries it."""
    secret = mint_for(repositories, MEMBER, SCOPES)

    saved = _save(client, secret)
    issue_list = answer(tool(client, secret, "list_templates", {"team_id": TEAM}))
    project_list = answer(tool(client, secret, "list_templates", {"team_id": TEAM, "kind": "project"}))

    assert saved["kind"] == "project"
    assert saved["project"]["lead_id"] == MEMBER
    assert saved["project"]["issues"][0]["assignee_id"] == MEMBER
    assert [row["name"] for row in issue_list["templates"]] == []
    assert [row["name"] for row in project_list["templates"]] == ["Launch"]


def test_a_project_template_is_updated_and_deleted_by_name(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """The write tools find a project template by its name as they do an issue template."""
    secret = mint_for(repositories, MEMBER, SCOPES)
    _save(client, secret)

    updated = answer(
        tool(client, secret, "update_template", {"team_id": TEAM, "template": "launch", "project": {"milestones": []}})
    )
    deleted = answer(tool(client, secret, "delete_template", {"team_id": TEAM, "template": "Launch"}))

    assert updated["project"]["milestones"] == []
    assert deleted["deleted"] is True


def test_create_project_from_a_template_by_name(client: TestClient, workspace: str, repositories: Any) -> None:
    """create_project takes the template's name, fills the project and adds its milestones and issues."""
    secret = mint_for(repositories, MEMBER, SCOPES)
    _save(client, secret)

    arguments = {"name": "Q4", "team_ids": [TEAM], "template_id": "Launch"}
    project = answer(tool(client, secret, "create_project", arguments))

    assert project["lead_id"] == MEMBER
    assert project["status"] == "planned"
    assert project["target_date"] is not None
    milestones = repositories.planning.list_milestones(WORKSPACE, project["project_id"])
    issues = {row.title: row for row in repositories.issues.iter_for_project(WORKSPACE, TEAM, project["project_id"])}
    assert [row.name for row in milestones] == ["Build"]
    assert issues["Build it"].project_milestone_id == milestones[0].milestone_id
    assert issues["Test it"].parent_id == issues["Build it"].issue_id


def test_create_project_refuses_a_template_its_teams_do_not_offer(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A project template of another team is not visible to a project on a different team."""
    secret = mint_for(repositories, MEMBER, SCOPES)
    _save(client, secret)

    refused = refusal(
        tool(client, secret, "create_project", {"name": "Q4", "team_ids": [OTHER_TEAM], "template_id": "Launch"})
    )

    assert refused
