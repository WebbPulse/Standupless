"""The initiative MCP tools: create, roll up, membership and the update feed.

Each tool runs the initiative route's own path, so these tests hold that an
agent's key does what the signed-in person could over HTTP and no more: a guest is
refused, initiatives and projects are named the way a person would name them, and
the destructive tools say so in their annotations.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.domains.integrations.mcp.toolkit import NOT_VISIBLE
from app.domains.integrations.mcp.tools import TOOLS_BY_NAME
from tests.domains.helpers import ADMIN, GUEST, MEMBER
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM, WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal, seed_planning

PROJECTS = ("projects:read", "projects:write")


@pytest.fixture
def planning(repositories: Any, workspace: str) -> dict[str, str]:
    """The home workspace's planning rows on the team every role can see."""
    return seed_planning(repositories, workspace, TEAM, "Home")


@pytest.mark.parametrize("name", ["delete_initiative", "remove_project_from_initiative", "delete_initiative_update"])
def test_destructive_tools_say_so(name: str) -> None:
    """Every initiative tool that loses data carries the destructive hint."""
    assert TOOLS_BY_NAME[name].descriptor()["annotations"]["destructiveHint"] is True


def test_an_initiative_is_created_and_rolls_up_projects_named_by_name(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """A project added by name shows in the rollup, and the project tools see the initiative."""
    secret = mint_for(repositories, MEMBER, PROJECTS)
    other = seed_planning(repositories, WORKSPACE, OTHER_TEAM, "Away")

    created = answer(
        tool(client, secret, "create_initiative", {"name": "Grow", "owner_id": "me", "target_date": "2026-12-01"})
    )
    assert created["status"] == "planned"
    assert created["owner_id"] == MEMBER

    added = answer(
        tool(client, secret, "add_project_to_initiative", {"initiative_id": "grow", "project_id": "Home project"})
    )
    answer(
        tool(
            client,
            secret,
            "update_project",
            {"project_id": other["project_id"], "initiative_id": created["initiative_id"]},
        )
    )
    rolled = answer(tool(client, secret, "get_initiative", {"initiative_id": created["initiative_id"]}))
    listed = answer(tool(client, secret, "list_projects", {"initiative_id": "Grow"}))

    assert added == {"project_id": planning["project_id"], "initiative_id": created["initiative_id"]}
    assert sorted(rolled["project_ids"]) == sorted([planning["project_id"], other["project_id"]])
    assert rolled["project_health"]["none"] == 2
    assert {row["initiative_id"] for row in listed["projects"]} == {created["initiative_id"]}


def test_update_and_list_initiatives_by_status(client: TestClient, repositories: Any, workspace: str) -> None:
    """A patch names only what changes, and the list filters by status."""
    secret = mint_for(repositories, MEMBER, PROJECTS)
    first = answer(tool(client, secret, "create_initiative", {"name": "One", "description": "Keep"}))
    answer(tool(client, secret, "create_initiative", {"name": "Two"}))

    patched = answer(tool(client, secret, "update_initiative", {"initiative_id": "One", "status": "active"}))
    active = answer(tool(client, secret, "list_initiatives", {"status": "active"}))

    assert patched["status"] == "active"
    assert patched["description"] == "Keep"
    assert [row["initiative_id"] for row in active["initiatives"]] == [first["initiative_id"]]


def test_removing_a_project_and_deleting_the_initiative(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """Removal clears the project's initiative, and deleting the initiative keeps the project."""
    secret = mint_for(repositories, MEMBER, PROJECTS)
    initiative_id = answer(tool(client, secret, "create_initiative", {"name": "Grow"}))["initiative_id"]
    membership = {"initiative_id": initiative_id, "project_id": planning["project_id"]}
    answer(tool(client, secret, "add_project_to_initiative", membership))

    removed = answer(tool(client, secret, "remove_project_from_initiative", membership))
    again = refusal(tool(client, secret, "remove_project_from_initiative", membership))
    answer(tool(client, secret, "add_project_to_initiative", membership))
    deleted = answer(tool(client, secret, "delete_initiative", {"initiative_id": "Grow"}))

    assert removed["initiative_id"] is None
    assert again
    assert deleted == {"deleted": True, "initiative_id": initiative_id}
    assert repositories.planning.get_project(WORKSPACE, planning["project_id"]).initiative_id is None


def test_the_update_feed_moves_the_initiatives_health(client: TestClient, repositories: Any, workspace: str) -> None:
    """Posting sets the health; the author edits; another member is refused; an admin deletes."""
    writer = mint_for(repositories, MEMBER, PROJECTS)
    initiative_id = answer(tool(client, writer, "create_initiative", {"name": "Grow"}))["initiative_id"]

    posted = answer(
        tool(client, writer, "create_initiative_update", {"initiative_id": "Grow", "body": "Late", "health": "at_risk"})
    )
    assert repositories.planning.get_initiative(WORKSPACE, initiative_id).health == "at_risk"

    ref = {"initiative_id": initiative_id, "update_id": posted["update_id"]}
    edited = answer(tool(client, writer, "update_initiative_update", {**ref, "health": "off_track"}))
    listed = answer(tool(client, writer, "list_initiative_updates", {"initiative_id": initiative_id}))
    deleted = answer(tool(client, mint_for(repositories, ADMIN, PROJECTS), "delete_initiative_update", ref))

    assert edited["edited_at"] is not None
    assert [row["update_id"] for row in listed["updates"]] == [posted["update_id"]]
    assert deleted == {"deleted": True, **ref}
    assert repositories.planning.get_initiative(WORKSPACE, initiative_id).health is None


def test_a_guest_is_refused_initiatives(client: TestClient, repositories: Any, workspace: str) -> None:
    """A guest neither lists, creates nor finds an initiative by name."""
    answer(tool(client, mint_for(repositories, MEMBER, PROJECTS), "create_initiative", {"name": "Grow"}))
    guest = mint_for(repositories, GUEST, PROJECTS)

    assert refusal(tool(client, guest, "list_initiatives", {}))
    assert refusal(tool(client, guest, "create_initiative", {"name": "Mine"}))
    assert refusal(tool(client, guest, "get_initiative", {"initiative_id": "Grow"})) == NOT_VISIBLE
