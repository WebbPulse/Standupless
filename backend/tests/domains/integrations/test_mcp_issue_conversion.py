"""The duplicate_issue and convert_issue_to_project MCP tools.

Each runs the same `app.common` path as its REST route, so these tests hold the
MCP end: the scopes each declares, a copy under a new key, a conversion that moves
sub-issues and closes the original, and the refusal a guest outside the team gets.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.domains.integrations.mcp.tools import TOOLS_BY_NAME
from tests.domains.helpers import GUEST, MEMBER, OWNER
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM, WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

WRITE = ("issues:read", "issues:write")

CONVERT = ("issues:read", "issues:write", "projects:write")


def _file(client: TestClient, secret: str, team_id: str = TEAM, **arguments: Any) -> dict[str, Any]:
    """File one issue through the create tool, answering it."""
    return answer(tool(client, secret, "create_issue", {"team_id": team_id, "title": "Ship it", **arguments}))


def test_the_tools_declare_their_routes_scopes() -> None:
    """Duplicating needs issue writes, and converting needs project writes as well."""
    assert TOOLS_BY_NAME["duplicate_issue"].scopes == ("issues:write",)
    assert TOOLS_BY_NAME["convert_issue_to_project"].scopes == ("issues:write", "projects:write")


def test_duplicate_issue_files_a_copy_under_a_new_key(client: TestClient, repositories: Any, workspace: str) -> None:
    """The copy takes the suffixed title, body and priority, by the original's key."""
    secret = mint_for(repositories, MEMBER, WRITE)
    original = _file(client, secret, body="Details", priority="high")

    copy = answer(tool(client, secret, "duplicate_issue", {"issue_id": original["issue_key"]}))

    assert copy["issue_id"] != original["issue_id"]
    assert copy["issue_key"] != original["issue_key"]
    assert copy["title"] == "Ship it (copy)"
    assert copy["body"] == "Details"
    assert copy["priority"] == "high"


def test_convert_issue_to_project_moves_sub_issues_and_closes_the_issue(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """The project is named after the issue, the child joins it and the issue lands in a completed status."""
    secret = mint_for(repositories, MEMBER, CONVERT)
    parent = _file(client, secret, title="Onboarding")
    child = _file(client, secret, title="Copy", parent_id=parent["issue_id"])

    converted = answer(tool(client, secret, "convert_issue_to_project", {"issue_id": parent["issue_key"]}))

    project_id = converted["project"]["project_id"]
    assert converted["project"]["name"] == "Onboarding"
    assert converted["issue"]["project_id"] == project_id
    statuses = repositories.team_config.list_statuses(WORKSPACE, TEAM)
    completed = {row.status_id for row in statuses if row.category == "completed"}
    assert converted["issue"]["status_id"] in completed
    assert [row["issue_id"] for row in converted["moved_issues"]] == [child["issue_id"]]
    assert converted["moved_issues"][0]["parent_id"] is None
    assert converted["moved_issues"][0]["project_id"] == project_id


def test_the_tools_refuse_a_guest_outside_the_team(client: TestClient, repositories: Any, workspace: str) -> None:
    """A guest cannot copy or convert an issue in a team they are not in, and no project is made."""
    hidden = _file(client, mint_for(repositories, OWNER, CONVERT), team_id=OTHER_TEAM)
    secret = mint_for(repositories, GUEST, CONVERT)

    assert refusal(tool(client, secret, "duplicate_issue", {"issue_id": hidden["issue_id"]}))
    assert refusal(tool(client, secret, "convert_issue_to_project", {"issue_id": hidden["issue_id"]}))
    assert repositories.planning.list_projects(WORKSPACE) == []
