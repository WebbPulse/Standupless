"""The project label MCP tools and labels on projects through the project tools.

They run the routes' `project_labels` functions and capability checks, so these
hold that an admin manages the set, a member cannot touch the workspace's, a
team admin keeps their team's own, a project takes labels by name, the project
list filters by them and a project is found by its short id.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, MEMBER, add_team_member
from tests.domains.integrations.conftest import TEAM, WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal


def test_an_admin_manages_project_labels(client: TestClient, repositories: Any, workspace: str) -> None:
    """Create, rename by name, list and delete the workspace's project labels."""
    secret = mint_for(repositories, ADMIN, ("labels:write", "projects:read", "admin"))

    created = answer(tool(client, secret, "create_project_label", {"name": "Q3", "color": "#5E6AD2"}))
    renamed = answer(tool(client, secret, "update_project_label", {"label": "q3", "name": "Q4"}))
    listed = answer(tool(client, secret, "list_project_labels", {}))
    duplicate = refusal(tool(client, secret, "create_project_label", {"name": "q4", "color": "#000000"}))
    deleted = answer(tool(client, secret, "delete_project_label", {"label": "Q4"}))

    assert (created["name"], created["color"]) == ("Q3", "#5e6ad2")
    assert renamed["name"] == "Q4"
    assert [row["label_id"] for row in listed["labels"]] == [created["label_id"]]
    assert duplicate
    assert deleted["deleted"] is True
    assert repositories.planning.list_project_labels(WORKSPACE) == []


def test_a_member_cannot_write_project_labels(client: TestClient, repositories: Any, workspace: str) -> None:
    """A workspace project label needs a workspace admin, and a team's one an admin of that team."""
    member = mint_for(repositories, MEMBER, ("labels:write",))

    workspace_wide = refusal(tool(client, member, "create_project_label", {"name": "Q3", "color": "#5e6ad2"}))
    team_owned = refusal(
        tool(client, member, "create_project_label", {"name": "Q3", "color": "#5e6ad2", "team_id": TEAM})
    )

    assert workspace_wide
    assert team_owned
    assert repositories.planning.list_project_labels(WORKSPACE) == []


def test_a_team_admin_keeps_their_teams_project_labels(client: TestClient, repositories: Any, workspace: str) -> None:
    """A team admin creates a label for their team, and lists it beside the workspace's."""
    admin = mint_for(repositories, ADMIN, ("labels:write", "projects:read", "admin"))
    shared = answer(tool(client, admin, "create_project_label", {"name": "Shared", "color": "#5e6ad2"}))
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "admin")
    lead = mint_for(repositories, MEMBER, ("labels:write", "projects:read"))

    own = answer(tool(client, lead, "create_project_label", {"name": "Mobile", "color": "#5e6ad2", "team_id": "ABC"}))
    renamed = answer(tool(client, lead, "update_project_label", {"label": "mobile", "name": "iOS"}))
    listed = answer(tool(client, lead, "list_project_labels", {"team_id": TEAM}))
    refused = refusal(tool(client, lead, "update_project_label", {"label": "Shared", "name": "X"}))

    assert own["team_id"] == TEAM
    assert renamed["name"] == "iOS"
    assert {row["label_id"] for row in listed["labels"]} == {shared["label_id"], own["label_id"]}
    assert refused


def test_projects_take_labels_and_answer_a_short_id(client: TestClient, repositories: Any, workspace: str) -> None:
    """Labels set by name, the list filtered by them, and the short id resolving the project."""
    admin = mint_for(repositories, ADMIN, ("labels:write", "projects:read", "admin"))
    label = answer(tool(client, admin, "create_project_label", {"name": "Growth", "color": "#5e6ad2"}))
    writer = mint_for(repositories, MEMBER, ("projects:write", "projects:read"))

    tagged_body = {"name": "Tagged", "team_ids": [TEAM], "label_ids": ["growth"]}
    tagged = answer(tool(client, writer, "create_project", tagged_body))
    plain = answer(tool(client, writer, "create_project", {"name": "Plain", "team_ids": [TEAM]}))
    unknown = refusal(tool(client, writer, "create_project", {"name": "X", "team_ids": [TEAM], "label_ids": ["nope"]}))
    filtered = answer(tool(client, writer, "list_projects", {"label_id": "Growth"}))
    unlabelled = answer(tool(client, writer, "list_projects", {"label_id": "none"}))
    by_slug = answer(tool(client, writer, "get_project", {"project_id": tagged["slug_id"]}))
    cleared = answer(tool(client, writer, "update_project", {"project_id": tagged["project_id"], "label_ids": []}))

    assert tagged["label_ids"] == [label["label_id"]]
    assert unknown
    assert [row["project_id"] for row in filtered["projects"]] == [tagged["project_id"]]
    assert [row["project_id"] for row in unlabelled["projects"]] == [plain["project_id"]]
    assert by_slug["project_id"] == tagged["project_id"]
    assert cleared["label_ids"] == []
