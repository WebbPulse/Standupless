"""The project status MCP tool and project statuses through the project tools.

They hold that the list answers the seeded defaults, that a project takes a
status by id, by name or by category, that the legacy enum values still resolve
to their category's default, that the project list filters by a status or a
whole category, and that a team admin creates their team's own status.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.schemas.project_statuses import ProjectStatusCreate
from app.common.project_statuses import create_project_status
from tests.domains.helpers import ADMIN, MEMBER, add_team_member
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM, WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal


def _custom_status(repositories: Any, workspace: str) -> str:
    """Add an `In review` status to the in progress category as an admin and answer its id."""
    context = AuthzContext(workspace_id=workspace, user_id=ADMIN, role="admin")
    created = create_project_status(
        repositories, context, ProjectStatusCreate(name="In review", category="in_progress")
    )
    return created.id


def test_the_list_answers_the_seeded_defaults(client: TestClient, repositories: Any, workspace: str) -> None:
    """Six statuses, one per category, each its category's default."""
    reader = mint_for(repositories, ADMIN, ("projects:read",))

    listed = answer(tool(client, reader, "list_project_statuses", {}))["statuses"]

    assert [row["category"] for row in listed] == [
        "backlog",
        "planned",
        "in_progress",
        "paused",
        "completed",
        "canceled",
    ]
    assert [row["status_id"] for row in listed] == [row["category"] for row in listed]
    assert all(row["is_default"] for row in listed)


def test_a_project_takes_a_status_by_name_id_or_category(client: TestClient, repositories: Any, workspace: str) -> None:
    """A name or id sets that status, a category its default, and each answer names both."""
    review = _custom_status(repositories, workspace)
    writer = mint_for(repositories, ADMIN, ("projects:write", "projects:read"))

    named = answer(tool(client, writer, "create_project", {"name": "Named", "team_ids": [TEAM], "status": "in review"}))
    plain = answer(tool(client, writer, "create_project", {"name": "Plain", "team_ids": [TEAM], "status": "planned"}))
    by_id = answer(tool(client, writer, "update_project", {"project_id": plain["project_id"], "status_id": review}))
    unknown = refusal(tool(client, writer, "update_project", {"project_id": plain["project_id"], "status": "nope"}))

    assert (named["status"], named["status_id"], named["status_name"]) == ("in_progress", review, "In review")
    assert (plain["status"], plain["status_id"], plain["status_name"]) == ("planned", "planned", "Planned")
    assert (by_id["status"], by_id["status_id"]) == ("in_progress", review)
    assert unknown


def test_legacy_status_values_resolve_to_the_category_default(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """`done` and `started` land on the completed and in progress defaults."""
    writer = mint_for(repositories, ADMIN, ("projects:write", "projects:read"))

    done = answer(tool(client, writer, "create_project", {"name": "Done", "team_ids": [TEAM], "status": "done"}))
    started = answer(tool(client, writer, "update_project", {"project_id": done["project_id"], "status": "started"}))

    assert (done["status"], done["status_id"]) == ("completed", "completed")
    assert (started["status"], started["status_id"]) == ("in_progress", "in_progress")


def test_the_project_list_filters_by_status_or_category(client: TestClient, repositories: Any, workspace: str) -> None:
    """A status name keeps its projects, a category keeps every status in it."""
    review = _custom_status(repositories, workspace)
    writer = mint_for(repositories, ADMIN, ("projects:write", "projects:read"))
    reviewing = answer(
        tool(client, writer, "create_project", {"name": "Reviewing", "team_ids": [TEAM], "status_id": review})
    )
    building = answer(
        tool(client, writer, "create_project", {"name": "Building", "team_ids": [TEAM], "status": "in_progress"})
    )

    by_name = answer(tool(client, writer, "list_projects", {"status": "In review"}))
    by_category = answer(tool(client, writer, "list_projects", {"status": "in_progress"}))

    assert [row["project_id"] for row in by_name["projects"]] == [reviewing["project_id"]]
    assert {row["project_id"] for row in by_category["projects"]} == {
        reviewing["project_id"],
        building["project_id"],
    }


def test_a_team_admin_creates_their_teams_project_status(client: TestClient, repositories: Any, workspace: str) -> None:
    """The status lands on the team, lists beside the defaults and is offered to that team's projects alone."""
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "admin")
    lead = mint_for(repositories, MEMBER, ("statuses:write", "projects:write", "projects:read"))

    created = answer(
        tool(client, lead, "create_project_status", {"name": "QA", "category": "in_progress", "team_id": "ABC"})
    )
    listed = answer(tool(client, lead, "list_project_statuses", {"team_id": TEAM}))["statuses"]
    workspace_wide = refusal(tool(client, lead, "create_project_status", {"name": "X", "category": "planned"}))
    project = answer(tool(client, lead, "create_project", {"name": "Q", "team_ids": [TEAM], "status": "QA"}))

    assert (created["team_id"], created["category"], created["is_default"]) == (TEAM, "in_progress", False)
    assert created["status_id"] in {row["status_id"] for row in listed}
    assert workspace_wide
    assert project["status_id"] == created["status_id"]


def test_a_team_status_is_refused_for_another_teams_project(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A project on another team cannot take a team's own status by id."""
    admin = mint_for(repositories, ADMIN, ("statuses:write", "projects:write", "projects:read", "admin"))
    created = answer(
        tool(client, admin, "create_project_status", {"name": "QA", "category": "in_progress", "team_id": TEAM})
    )

    refused = refusal(
        tool(
            client,
            admin,
            "create_project",
            {"name": "Elsewhere", "team_ids": [OTHER_TEAM], "status_id": created["status_id"]},
        )
    )

    assert refused
