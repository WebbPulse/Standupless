"""The project status MCP tool and project statuses through the project tools.

They hold that the list answers the seeded defaults, that a project takes a
status by id, by name or by category, that the legacy enum values still resolve
to their category's default, and that the project list filters by a status or a
whole category.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, sign_in
from tests.domains.integrations.conftest import TEAM
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal


def _custom_status(client: TestClient, workspace: str) -> str:
    """Add an `In review` status to the in progress category through the route and answer its id."""
    sign_in(client, ADMIN)
    created = client.post(
        f"/api/workspaces/{workspace}/project-statuses", json={"name": "In review", "category": "in_progress"}
    )
    assert created.status_code == 201, created.text
    return created.json()["id"]


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
    review = _custom_status(client, workspace)
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
    review = _custom_status(client, workspace)
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
