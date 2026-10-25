"""The status update draft MCP tools: staging a project or initiative update for a person to post.

Each tool runs the drafts routes' own `app.common.update_drafts` path, so the
rules asserted here are the routes': a draft is the credential's user's own,
one per project and per initiative, held to the rights posting needs, and
posting the update through the create tools clears the draft it came from.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.planning import Initiative, initiative_key
from app.domains.integrations.mcp.tools import TOOLS_BY_NAME
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM, WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal, seed_planning

DRAFTS = ("projects:read", "projects:write")

INITIATIVE_ID = "01JB000000000000000000INID"


@pytest.fixture
def planning(repositories: Any, workspace: str) -> dict[str, str]:
    """A project on the team every role can see, one on the team the guest is outside, and an initiative."""
    home = seed_planning(repositories, workspace, TEAM, "Home")
    away = seed_planning(repositories, workspace, OTHER_TEAM, "Away")
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
    return {"project_id": home["project_id"], "away_project_id": away["project_id"], "initiative_id": INITIATIVE_ID}


@pytest.mark.parametrize(
    ("name", "scopes"),
    [
        ("set_update_draft", ("projects:write",)),
        ("get_update_draft", ("projects:read",)),
        ("delete_update_draft", ("projects:write",)),
    ],
)
def test_each_tool_takes_its_scope(name: str, scopes: tuple[str, ...]) -> None:
    """Saving and discarding need what posting an update needs, and reading needs project read."""
    assert TOOLS_BY_NAME[name].scopes == scopes


def test_the_tools_declare_their_hints() -> None:
    """Saving replaces, reading is read only, and discarding is destructive but repeatable."""
    assert TOOLS_BY_NAME["set_update_draft"].idempotent is True
    assert TOOLS_BY_NAME["delete_update_draft"].destructive is True
    assert TOOLS_BY_NAME["delete_update_draft"].idempotent is True


def test_a_project_draft_is_staged_by_name_and_read(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """Saving by project name resolves the project, keeps the health, and saving again keeps created_at."""
    secret = mint_for(repositories, MEMBER, DRAFTS)

    saved = answer(
        tool(
            client, secret, "set_update_draft", {"project_id": "Home project", "body": "Shipping", "health": "at_risk"}
        )
    )
    again = answer(tool(client, secret, "set_update_draft", {"project_id": planning["project_id"], "body": "Shipped"}))
    read = answer(tool(client, secret, "get_update_draft", {"project_id": planning["project_id"]}))

    assert (saved["target_kind"], saved["project_id"], saved["target_name"]) == (
        "project",
        planning["project_id"],
        "Home project",
    )
    assert saved["health"] == "at_risk"
    assert again["created_at"] == saved["created_at"]
    assert again["health"] is None
    assert read["draft"]["body"] == "Shipped"


def test_an_initiative_draft_is_staged_and_discarded(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """An initiative holds its own draft, apart from any project's, until it is discarded."""
    secret = mint_for(repositories, MEMBER, DRAFTS)

    saved = answer(
        tool(client, secret, "set_update_draft", {"initiative_id": "Grow", "body": "Growing", "health": "on_track"})
    )
    project = answer(tool(client, secret, "get_update_draft", {"project_id": planning["project_id"]}))
    deleted = answer(tool(client, secret, "delete_update_draft", {"initiative_id": INITIATIVE_ID}))
    read = answer(tool(client, secret, "get_update_draft", {"initiative_id": INITIATIVE_ID}))

    assert (saved["target_kind"], saved["initiative_id"]) == ("initiative", INITIATIVE_ID)
    assert project == {"draft": None}
    assert deleted == {"deleted": True, "initiative_id": INITIATIVE_ID}
    assert read == {"draft": None}


def test_exactly_one_target_is_named(client: TestClient, repositories: Any, planning: dict[str, str]) -> None:
    """Naming both a project and an initiative, or neither, is refused."""
    secret = mint_for(repositories, MEMBER, DRAFTS)

    both = refusal(
        tool(
            client,
            secret,
            "set_update_draft",
            {"project_id": planning["project_id"], "initiative_id": INITIATIVE_ID, "body": "Both"},
        )
    )
    neither = refusal(tool(client, secret, "get_update_draft", {}))

    assert "exactly one" in both
    assert "exactly one" in neither


def test_a_blank_draft_or_unknown_health_is_refused(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """A blank body is a discard, and a health no update takes is refused."""
    secret = mint_for(repositories, MEMBER, DRAFTS)

    blank = refusal(tool(client, secret, "set_update_draft", {"project_id": planning["project_id"], "body": " "}))
    health = refusal(
        tool(
            client,
            secret,
            "set_update_draft",
            {"project_id": planning["project_id"], "body": "Fine", "health": "great"},
        )
    )

    assert blank
    assert health


def test_drafts_are_the_callers_own(client: TestClient, repositories: Any, planning: dict[str, str]) -> None:
    """Another member's credential reads and discards nothing of the first one's."""
    mine = mint_for(repositories, MEMBER, DRAFTS)
    theirs = mint_for(repositories, OWNER, DRAFTS)
    answer(tool(client, mine, "set_update_draft", {"project_id": planning["project_id"], "body": "Mine"}))

    read = answer(tool(client, theirs, "get_update_draft", {"project_id": planning["project_id"]}))
    answer(tool(client, theirs, "delete_update_draft", {"project_id": planning["project_id"]}))

    assert read == {"draft": None}
    assert repositories.views.get_update_draft(WORKSPACE, MEMBER, "project", planning["project_id"]) is not None


def test_a_guest_cannot_draft_where_they_cannot_post(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """A project on a team the guest is outside, and any initiative, refuse a guest's draft."""
    secret = mint_for(repositories, GUEST, DRAFTS)

    hidden = refusal(
        tool(client, secret, "set_update_draft", {"project_id": planning["away_project_id"], "body": "Sneaky"})
    )
    initiative = refusal(tool(client, secret, "set_update_draft", {"initiative_id": INITIATIVE_ID, "body": "Sneaky"}))

    assert hidden
    assert initiative
    assert repositories.views.get_update_draft(WORKSPACE, GUEST, "project", planning["away_project_id"]) is None
    assert repositories.views.get_update_draft(WORKSPACE, GUEST, "initiative", INITIATIVE_ID) is None


def test_posting_a_project_update_clears_the_draft(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """create_project_update clears the poster's draft on that project."""
    secret = mint_for(repositories, MEMBER, DRAFTS)
    answer(tool(client, secret, "set_update_draft", {"project_id": planning["project_id"], "body": "Staged"}))

    answer(
        tool(
            client,
            secret,
            "create_project_update",
            {"project_id": planning["project_id"], "body": "Posted", "health": "on_track"},
        )
    )

    assert repositories.views.get_update_draft(WORKSPACE, MEMBER, "project", planning["project_id"]) is None


def test_posting_an_initiative_update_clears_the_draft(
    client: TestClient, repositories: Any, planning: dict[str, str]
) -> None:
    """create_initiative_update clears the poster's draft on that initiative and no one else's."""
    secret = mint_for(repositories, MEMBER, DRAFTS)
    other = mint_for(repositories, OWNER, DRAFTS)
    answer(tool(client, secret, "set_update_draft", {"initiative_id": INITIATIVE_ID, "body": "Staged"}))
    answer(tool(client, other, "set_update_draft", {"initiative_id": INITIATIVE_ID, "body": "Theirs"}))

    answer(
        tool(
            client,
            secret,
            "create_initiative_update",
            {"initiative_id": INITIATIVE_ID, "body": "Posted", "health": "on_track"},
        )
    )

    assert repositories.views.get_update_draft(WORKSPACE, MEMBER, "initiative", INITIATIVE_ID) is None
    assert repositories.views.get_update_draft(WORKSPACE, OWNER, "initiative", INITIATIVE_ID) is not None
