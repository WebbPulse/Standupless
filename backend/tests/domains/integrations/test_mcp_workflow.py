"""The workspace status and label MCP tools and the team override tools.

They run the routes' `team_workflow` functions and capability checks, so these
hold that a workspace admin manages the shared set, a member cannot, and a team
admin hides or renames an inherited record in one team only.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.domains.integrations.mcp.transport import INSUFFICIENT_SCOPE
from tests.domains.helpers import ADMIN, MEMBER
from tests.domains.integrations.conftest import WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal


def test_a_workspace_admin_manages_the_shared_statuses(client: TestClient, repositories: Any, workspace: str) -> None:
    """Create, rename by name and list the workspace set; every team then carries it."""
    secret = mint_for(repositories, ADMIN, ("statuses:write", "statuses:read", "admin"))

    created = answer(tool(client, secret, "create_workspace_status", {"name": "Review", "category": "started"}))
    renamed = answer(tool(client, secret, "update_workspace_status", {"status": "review", "name": "QA"}))
    listed = answer(tool(client, secret, "list_workspace_statuses", {}))
    team_rows = answer(tool(client, secret, "list_statuses", {"team_id": "ABC"}))["statuses"]

    assert created["scope"] == "workspace"
    assert renamed["name"] == "QA"
    assert [row["status_id"] for row in listed["statuses"]] == [created["status_id"]]
    assert created["status_id"] in {row["status_id"] for row in team_rows}


def test_a_member_cannot_write_the_shared_set(client: TestClient, repositories: Any, workspace: str) -> None:
    """Workspace writes hold the route's admin capability, and need `admin` beside the write scope."""
    member = mint_for(repositories, MEMBER, ("labels:write", "labels:read"))
    admin = mint_for(repositories, ADMIN, ("labels:write",))
    body = {"name": "Bug", "color": "#eb5757"}

    assert tool(client, member, "create_workspace_label", body).json()["error"]["code"] == INSUFFICIENT_SCOPE
    assert tool(client, admin, "create_workspace_label", body).json()["error"]["code"] == INSUFFICIENT_SCOPE
    assert repositories.team_config.list_workspace_labels(WORKSPACE) == []


def test_a_team_admin_overrides_an_inherited_label(client: TestClient, repositories: Any, workspace: str) -> None:
    """Rename, hide and reset in one team, leaving the other team's view alone."""
    owner = mint_for(repositories, ADMIN, ("labels:write", "labels:read", "admin"))
    label = answer(tool(client, owner, "create_workspace_label", {"name": "Bug", "color": "#eb5757"}))

    renamed = answer(tool(client, owner, "override_team_label", {"team_id": "ABC", "label": "Bug", "name": "Defect"}))
    hidden = answer(tool(client, owner, "override_team_label", {"team_id": "ABC", "label": "Defect", "hidden": True}))
    listed = answer(tool(client, owner, "list_labels", {"team_id": "ABC"}))["labels"]
    reset = answer(tool(client, owner, "reset_team_label_override", {"team_id": "ABC", "label": label["label_id"]}))

    assert (renamed["name"], renamed["inherited_name"]) == ("Defect", "Bug")
    assert hidden["hidden"] is True
    assert label["label_id"] not in {row["label_id"] for row in listed}
    assert (reset["name"], reset["hidden"]) == ("Bug", False)


def test_a_team_status_takes_no_override(client: TestClient, repositories: Any, workspace: str) -> None:
    """Only inherited records can be hidden or renamed."""
    secret = mint_for(repositories, ADMIN, ("statuses:write",))
    message = refusal(
        tool(client, secret, "override_team_status", {"team_id": "ABC", "status": "Done", "hidden": True})
    )
    assert "inherited" in message
