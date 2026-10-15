"""The favorites MCP tools: starring by the names a person writes, ordering, and isolation.

Each tool runs the favorites routes' own `app.common.favorites` path, so the rules
asserted here are the routes': a favorite is the caller's own, a target they cannot
read is refused, and a reorder never loses a favorite it left out.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.issues import Issue
from tests.domains.helpers import GUEST, MEMBER, OWNER
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal, seed_planning

FAVORITES = ("views:read", "views:write")


@pytest.fixture
def planning(repositories: Any, workspace: str) -> dict[str, str]:
    """The home workspace's planning rows, on the team every role can see."""
    return seed_planning(repositories, workspace, TEAM, "Home")


def test_favorites_are_starred_by_key_and_name_and_listed_in_order(
    client: TestClient, repositories: Any, issue: Issue, planning: dict[str, str]
) -> None:
    """An issue by its key, a team by its prefix and a project by its name all resolve."""
    secret = mint_for(repositories, MEMBER, FAVORITES)

    starred = answer(tool(client, secret, "add_favorite", {"kind": "issue", "target": "ABC-1"}))
    answer(tool(client, secret, "add_favorite", {"kind": "team", "target": "ABC"}))
    answer(tool(client, secret, "add_favorite", {"kind": "project", "target": "Home project"}))
    listed = answer(tool(client, secret, "list_favorites", {}))

    assert (starred["kind"], starred["target_id"], starred["issue_key"]) == ("issue", issue.issue_id, "ABC-1")
    assert [(row["kind"], row["target_id"]) for row in listed["favorites"]] == [
        ("issue", issue.issue_id),
        ("team", TEAM),
        ("project", planning["project_id"]),
    ]


def test_a_cycle_favorite_needs_its_team(client: TestClient, repositories: Any, planning: dict[str, str]) -> None:
    """Without the team the cycle cannot be found again, so the tool asks for it."""
    secret = mint_for(repositories, MEMBER, FAVORITES)

    refused = refusal(tool(client, secret, "add_favorite", {"kind": "cycle", "target": planning["cycle_id"]}))
    starred = answer(
        tool(client, secret, "add_favorite", {"kind": "cycle", "target": planning["cycle_id"], "team_id": "ABC"})
    )

    assert "team_id" in refused
    assert (starred["kind"], starred["team_id"]) == ("cycle", TEAM)


def test_a_guest_cannot_star_a_team_they_are_outside(client: TestClient, repositories: Any, workspace: str) -> None:
    """The guest's membership bounds a favorite exactly as it bounds the route."""
    secret = mint_for(repositories, GUEST, FAVORITES)

    refused = refusal(tool(client, secret, "add_favorite", {"kind": "team", "target": OTHER_TEAM}))

    assert refused
    assert repositories.views.favorite_items(workspace, GUEST) == []


def test_remove_and_reorder(client: TestClient, repositories: Any, issue: Issue, planning: dict[str, str]) -> None:
    """Reorder puts the named first and keeps the rest; remove answers whether it was starred."""
    secret = mint_for(repositories, MEMBER, FAVORITES)
    for kind, target in (("team", "ABC"), ("issue", "ABC-1"), ("view", "Home view")):
        answer(tool(client, secret, "add_favorite", {"kind": kind, "target": target}))

    reordered = answer(
        tool(client, secret, "reorder_favorites", {"order": [{"kind": "view", "target": planning["view_id"]}]})
    )
    removed = answer(tool(client, secret, "remove_favorite", {"kind": "issue", "target": "ABC-1"}))
    again = answer(tool(client, secret, "remove_favorite", {"kind": "issue", "target": issue.issue_id}))

    assert [row["kind"] for row in reordered["favorites"]] == ["view", "team", "issue"]
    assert (removed["removed"], again["removed"]) == (True, False)
    stored = repositories.views.favorite_items(issue.workspace_id, MEMBER)
    assert [row.kind for row in stored] == ["view", "team"]


def test_favorites_are_the_callers_own(client: TestClient, repositories: Any, issue: Issue) -> None:
    """Another member's credential lists nothing the first one starred."""
    mine = mint_for(repositories, MEMBER, FAVORITES)
    theirs = mint_for(repositories, OWNER, FAVORITES)
    answer(tool(client, mine, "add_favorite", {"kind": "issue", "target": "ABC-1"}))

    listed = answer(tool(client, theirs, "list_favorites", {}))

    assert listed["favorites"] == []
