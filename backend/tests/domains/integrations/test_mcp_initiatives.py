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

from app.common.readable_ids import readable_id
from app.domains.integrations.mcp.toolkit import NOT_VISIBLE
from app.domains.integrations.mcp.tools import TOOLS_BY_NAME
from tests.domains.helpers import ADMIN, GUEST, MEMBER, add_team_member
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
    assert rolled["web_url"].endswith("/w/acme/initiatives/" + readable_id(created["initiative_id"], rolled["name"]))
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
    """Posting sets the health and the author edits it; an admin deletes and the last health stays."""
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
    left = repositories.planning.get_initiative(WORKSPACE, initiative_id)
    assert left.health == "off_track"
    assert left.last_update_at is None


def test_a_guest_is_refused_initiatives(client: TestClient, repositories: Any, workspace: str) -> None:
    """A guest neither lists, creates nor finds an initiative by name."""
    answer(tool(client, mint_for(repositories, MEMBER, PROJECTS), "create_initiative", {"name": "Grow"}))
    guest = mint_for(repositories, GUEST, PROJECTS)

    assert refusal(tool(client, guest, "list_initiatives", {}))
    assert refusal(tool(client, guest, "create_initiative", {"name": "Mine"}))
    assert refusal(tool(client, guest, "get_initiative", {"initiative_id": "Grow"})) == NOT_VISIBLE


def test_sub_initiatives_are_nested_by_name_and_roll_up(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """A parent named by name nests the initiative, the parent rolls up its projects and null detaches it."""
    secret = mint_for(repositories, MEMBER, PROJECTS)
    root = answer(tool(client, secret, "create_initiative", {"name": "Company goals"}))
    child = answer(tool(client, secret, "create_initiative", {"name": "Grow", "parent_initiative_id": "company goals"}))
    answer(tool(client, secret, "add_project_to_initiative", {"initiative_id": "Grow", "project_id": "Home project"}))

    rolled = answer(tool(client, secret, "get_initiative", {"initiative_id": "Company goals"}))
    progress = answer(tool(client, secret, "get_initiative_progress", {"initiative_id": "Company goals"}))
    cycle = refusal(
        tool(client, secret, "update_initiative", {"initiative_id": "Company goals", "parent_initiative_id": "Grow"})
    )
    detached = answer(
        tool(client, secret, "update_initiative", {"initiative_id": "Grow", "parent_initiative_id": None})
    )

    assert child["parent_initiative_id"] == root["initiative_id"]
    assert child["ancestors"] == [{"initiative_id": root["initiative_id"], "name": "Company goals"}]
    assert rolled["sub_initiative_ids"] == [child["initiative_id"]]
    assert rolled["project_ids"] == []
    assert rolled["rollup_project_ids"] == [planning["project_id"]]
    assert progress["initiative_id"] == root["initiative_id"]
    assert progress["days"]
    assert "sub-initiatives" in cycle
    assert detached["parent_initiative_id"] is None


def test_an_initiative_target_round_trips_its_resolution(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """The initiative tools take a resolution beside the date and answer it with a readable label."""
    secret = mint_for(repositories, MEMBER, PROJECTS)

    created = answer(
        tool(
            client,
            secret,
            "create_initiative",
            {"name": "Scale", "target_date": "2027-08-01", "target_date_resolution": "quarter"},
        )
    )
    plain = answer(tool(client, secret, "create_initiative", {"name": "Plain", "target_date": "2027-08-01"}))
    updated = answer(
        tool(
            client,
            secret,
            "update_initiative",
            {"initiative_id": created["initiative_id"], "target_date_resolution": "year"},
        )
    )

    assert (created["target_date"], created["target_date_resolution"]) == ("2027-09-30", "quarter")
    assert created["target_date_label"] == "Q3 2027"
    assert (plain["target_date_resolution"], plain["target_date_label"]) == ("day", "2027-08-01")
    assert (updated["target_date"], updated["target_date_label"]) == ("2027-12-31", "2027")


def test_an_initiative_start_date_is_set_labelled_refused_after_the_target_and_cleared(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """The initiative tools take a start date with its resolution, refuse one after the target and clear it on null."""
    secret = mint_for(repositories, MEMBER, PROJECTS)

    created = answer(
        tool(
            client,
            secret,
            "create_initiative",
            {
                "name": "Launch",
                "start_date": "2027-05-20",
                "start_date_resolution": "month",
                "target_date": "2027-12-01",
            },
        )
    )
    late = refusal(tool(client, secret, "update_initiative", {"initiative_id": "Launch", "start_date": "2028-01-01"}))
    cleared = answer(tool(client, secret, "update_initiative", {"initiative_id": "Launch", "start_date": None}))

    assert (created["start_date"], created["start_date_resolution"]) == ("2027-05-01", "month")
    assert created["start_date_label"] == "May 2027"
    assert "start_date" in late
    assert (cleared["start_date"], cleared["start_date_resolution"], cleared["start_date_label"]) == (None, None, None)


def test_a_lead_team_is_named_by_key_filtered_on_and_cleared(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """An agent sets the lead team by key prefix, lists by it or by no team, and clears it with null."""
    secret = mint_for(repositories, MEMBER, PROJECTS)
    led = answer(tool(client, secret, "create_initiative", {"name": "Led", "team_id": "ABC"}))
    answer(tool(client, secret, "create_initiative", {"name": "Open"}))
    assert led["team_id"] == TEAM

    by_team = answer(tool(client, secret, "list_initiatives", {"team_id": "ABC"}))
    assert [row["name"] for row in by_team["initiatives"]] == ["Led"]
    no_team = answer(tool(client, secret, "list_initiatives", {"no_team": True}))
    assert [row["name"] for row in no_team["initiatives"]] == ["Open"]

    cleared = answer(tool(client, secret, "update_initiative", {"initiative_id": "Led", "team_id": None}))
    assert cleared["team_id"] is None


def test_a_private_lead_team_hides_the_initiative_from_an_outside_agent(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """An initiative led by a private team the key's person is outside is not found by id or name."""
    owner_key = mint_for(repositories, MEMBER, PROJECTS)
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "member")
    led = answer(tool(client, owner_key, "create_initiative", {"name": "Secret", "team_id": TEAM}))
    repositories.memberships.set_team_private(WORKSPACE, TEAM, True)

    outside = mint_for(repositories, ADMIN, PROJECTS)
    assert refusal(tool(client, outside, "get_initiative", {"initiative_id": led["initiative_id"]})) == NOT_VISIBLE
    assert refusal(tool(client, outside, "get_initiative", {"initiative_id": "Secret"})) == NOT_VISIBLE
    assert answer(tool(client, outside, "list_initiatives", {}))["initiatives"] == []
