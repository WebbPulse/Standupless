"""The MCP tools for replies and reactions on project and initiative updates.

They run the planning routes' own paths, so an agent replies and reacts wherever
its person may read the project or initiative, needs the route's scope, and is
refused another person's update thread only where the person would be. A call
names exactly one of a project and an initiative.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.planning import Initiative, InitiativeUpdateRow, initiative_key, initiative_update_key
from app.domains.integrations.mcp.tools import TOOLS_BY_NAME
from tests.domains.helpers import ADMIN, MEMBER
from tests.domains.integrations.conftest import TEAM, WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_planning import post_update
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal, seed_planning

THREADS = ("projects:read", "comments:write")

INITIATIVE_ID = "01JB000000000000000000INIM"

INITIATIVE_UPDATE_ID = "01JB00000000000000000UPDM1"


@pytest.fixture
def planning(repositories: Any, workspace: str) -> dict[str, str]:
    """The home workspace's planning rows on the team every role can see."""
    return seed_planning(repositories, workspace, TEAM, "Home")


@pytest.mark.parametrize(
    ("name", "scopes"),
    [
        ("list_project_update_comments", ("projects:read",)),
        ("add_project_update_comment", ("comments:write",)),
        ("react_to_project_update", ("comments:write",)),
    ],
)
def test_each_tool_takes_its_scope(name: str, scopes: tuple[str, ...]) -> None:
    """Reading a thread needs project read, and writing one needs comment write as an issue comment does."""
    assert TOOLS_BY_NAME[name].scopes == scopes


def test_an_agent_replies_lists_and_reacts(client: TestClient, repositories: Any, planning: dict[str, str]) -> None:
    """A member's key replies on an admin's update by project name, reacts, and takes the reaction back."""
    update_id = post_update(repositories, planning["project_id"], ADMIN)
    secret = mint_for(repositories, MEMBER, THREADS)

    reply = answer(
        tool(
            client,
            secret,
            "add_project_update_comment",
            {"project_id": "Home project", "update_id": update_id, "body": "Thanks"},
        )
    )
    assert reply["author_id"] == MEMBER
    assert reply["source"] == "mcp"

    group = answer(
        tool(
            client,
            secret,
            "react_to_project_update",
            {"project_id": planning["project_id"], "update_id": update_id, "emoji": "👍"},
        )
    )
    assert group["count"] == 1
    assert group["reacted"] is True
    answer(
        tool(
            client,
            secret,
            "react_to_project_update",
            {
                "project_id": planning["project_id"],
                "update_id": update_id,
                "emoji": "🎉",
                "comment_id": reply["comment_id"],
            },
        )
    )

    listed = answer(
        tool(
            client,
            secret,
            "list_project_update_comments",
            {"project_id": planning["project_id"], "update_id": update_id},
        )
    )
    assert [row["body"] for row in listed["comments"]] == ["Thanks"]
    assert [row["emoji"] for row in listed["comments"][0]["reactions"]] == ["🎉"]

    removed = answer(
        tool(
            client,
            secret,
            "react_to_project_update",
            {"project_id": planning["project_id"], "update_id": update_id, "emoji": "👍", "remove": True},
        )
    )
    assert removed["removed"] is True
    thread = repositories.planning.update_threads.read(WORKSPACE, planning["project_id"], update_id)
    assert [row.emoji for row in thread.reactions] == ["🎉"]


def _seed_initiative(repositories: Any) -> None:
    """One workspace-wide initiative named Grow, owned by the admin, with one update the admin wrote."""
    repositories.planning.create_initiative(
        Initiative(
            workspace_id=WORKSPACE,
            planning_key=initiative_key(INITIATIVE_ID),
            initiative_id=INITIATIVE_ID,
            name="Grow",
            owner_id=ADMIN,
            created_by=ADMIN,
        )
    )
    repositories.planning.create_initiative_update(
        InitiativeUpdateRow(
            workspace_id=WORKSPACE,
            planning_key=initiative_update_key(INITIATIVE_ID, INITIATIVE_UPDATE_ID),
            update_id=INITIATIVE_UPDATE_ID,
            initiative_id=INITIATIVE_ID,
            body="On track",
            health="on_track",
            author_id=ADMIN,
        )
    )


def test_an_agent_replies_and_reacts_on_an_initiative_update(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A member's key names the initiative by name, and the thread lands in the initiative's own store."""
    _seed_initiative(repositories)
    secret = mint_for(repositories, MEMBER, THREADS)
    base = {"initiative_id": "Grow", "update_id": INITIATIVE_UPDATE_ID}

    reply = answer(tool(client, secret, "add_project_update_comment", {**base, "body": "Thanks"}))
    assert reply["initiative_id"] == INITIATIVE_ID
    assert reply["project_id"] is None
    assert reply["source"] == "mcp"

    group = answer(tool(client, secret, "react_to_project_update", {**base, "emoji": "👍"}))
    assert group["count"] == 1
    listed = answer(tool(client, secret, "list_project_update_comments", base))
    assert [row["body"] for row in listed["comments"]] == ["Thanks"]

    answer(tool(client, secret, "react_to_project_update", {**base, "emoji": "👍", "remove": True}))
    thread = repositories.planning.initiative_update_threads.read(WORKSPACE, INITIATIVE_ID, INITIATIVE_UPDATE_ID)
    assert len(thread.comments) == 1
    assert thread.reactions == []


@pytest.mark.parametrize("parents", [{}, {"project_id": "Home project", "initiative_id": "Grow"}])
def test_a_call_names_exactly_one_parent(
    client: TestClient, repositories: Any, planning: dict[str, str], parents: dict[str, str]
) -> None:
    """Naming neither a project nor an initiative, or both, is refused before anything is read."""
    _seed_initiative(repositories)
    secret = mint_for(repositories, MEMBER, THREADS)

    text = refusal(tool(client, secret, "list_project_update_comments", {**parents, "update_id": INITIATIVE_UPDATE_ID}))
    assert "exactly one of project_id and initiative_id" in text
