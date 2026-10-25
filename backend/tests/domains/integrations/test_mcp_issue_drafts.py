"""The new issue draft MCP tools: staging an issue for a person to file.

Each tool runs the drafts routes' own `app.common.issue_drafts` path, so the
rules asserted here are the routes': a draft is the credential's user's own,
saving under an id replaces it, and a hidden team is refused.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.issues import Issue
from app.domains.integrations.mcp.tools import TOOLS_BY_NAME
from tests.domains.helpers import GUEST, MEMBER, OWNER
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM
from tests.domains.integrations.test_mcp import call, tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

DRAFTS = ("issues:write", "issues:read")


def test_a_draft_is_staged_by_team_key_read_and_listed(client: TestClient, repositories: Any, issue: Issue) -> None:
    """Saving by team key and parent key resolves both, and saving again under the id replaces it."""
    secret = mint_for(repositories, MEMBER, DRAFTS)

    saved = answer(
        tool(
            client,
            secret,
            "save_issue_draft",
            {"team_id": "ABC", "title": "Staged", "priority": "high", "parent_id": "ABC-1", "sub_issues": ["One"]},
        )
    )
    again = answer(
        tool(client, secret, "save_issue_draft", {"draft_id": saved["draft_id"], "team_id": TEAM, "title": "Edited"})
    )
    read = answer(tool(client, secret, "get_issue_draft", {"draft_id": saved["draft_id"]}))
    listed = answer(tool(client, secret, "list_issue_drafts", {}))

    assert (saved["team_id"], saved["parent_id"], saved["parent_key"]) == (TEAM, issue.issue_id, "ABC-1")
    assert saved["priority"] == "high"
    assert saved["sub_issues"] == ["One"]
    assert again["created_at"] == saved["created_at"]
    assert read["draft"]["title"] == "Edited"
    assert [row["title"] for row in listed["drafts"]] == ["Edited"]
    assert listed["limit"] == 200


def test_no_draft_reads_as_null(client: TestClient, repositories: Any, issue: Issue) -> None:
    """An agent asking for a draft that is not there gets null rather than an error."""
    secret = mint_for(repositories, MEMBER, DRAFTS)

    read = answer(tool(client, secret, "get_issue_draft", {"draft_id": "01JBNOTHERE000000000000001"}))

    assert read == {"draft": None}


def test_an_empty_draft_is_refused(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A draft with nothing typed is refused with a message naming why."""
    secret = mint_for(repositories, MEMBER, DRAFTS)

    refused = refusal(tool(client, secret, "save_issue_draft", {"team_id": TEAM, "title": "  "}))

    assert "draft needs" in refused


def test_a_bad_draft_id_is_refused(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A draft id carries only letters, digits, hyphens and underscores."""
    secret = mint_for(repositories, MEMBER, DRAFTS)

    refused = refusal(tool(client, secret, "get_issue_draft", {"draft_id": "../other"}))

    assert "draft_id" in refused


def test_drafts_are_the_callers_own(client: TestClient, repositories: Any, issue: Issue) -> None:
    """Another member's credential reads, lists and discards nothing of the first one's."""
    mine = mint_for(repositories, MEMBER, DRAFTS)
    theirs = mint_for(repositories, OWNER, DRAFTS)
    saved = answer(tool(client, mine, "save_issue_draft", {"team_id": TEAM, "title": "Mine"}))

    read = answer(tool(client, theirs, "get_issue_draft", {"draft_id": saved["draft_id"]}))
    listed = answer(tool(client, theirs, "list_issue_drafts", {}))
    answer(tool(client, theirs, "delete_issue_draft", {"draft_id": saved["draft_id"]}))

    assert read == {"draft": None}
    assert listed["drafts"] == []
    assert repositories.views.get_issue_draft(issue.workspace_id, MEMBER, saved["draft_id"]) is not None


def test_a_guest_cannot_draft_on_a_hidden_team(client: TestClient, repositories: Any, issue: Issue) -> None:
    """The guest's team membership bounds a draft exactly as it bounds an issue."""
    secret = mint_for(repositories, GUEST, DRAFTS)

    refused = refusal(tool(client, secret, "save_issue_draft", {"team_id": OTHER_TEAM, "title": "Sneaky"}))

    assert refused
    assert repositories.views.list_issue_drafts(issue.workspace_id, GUEST) == []


def test_deleting_discards_the_draft(client: TestClient, repositories: Any, issue: Issue) -> None:
    """Discarding answers the id, and a repeat is a no-op."""
    secret = mint_for(repositories, MEMBER, DRAFTS)
    saved = answer(tool(client, secret, "save_issue_draft", {"team_id": TEAM, "body": "Only a body"}))

    first = answer(tool(client, secret, "delete_issue_draft", {"draft_id": saved["draft_id"]}))
    second = answer(tool(client, secret, "delete_issue_draft", {"draft_id": saved["draft_id"]}))

    assert first == second == {"deleted": True, "draft_id": saved["draft_id"]}
    assert answer(tool(client, secret, "list_issue_drafts", {}))["drafts"] == []


def test_the_tools_declare_their_hints(client: TestClient, repositories: Any, issue: Issue) -> None:
    """Discarding is flagged destructive so a client asks first; saving is idempotent."""
    secret = mint_for(repositories, MEMBER, DRAFTS)

    advertised = {row["name"]: row for row in call(client, secret, "tools/list").json()["result"]["tools"]}

    assert TOOLS_BY_NAME["delete_issue_draft"].destructive is True
    assert TOOLS_BY_NAME["save_issue_draft"].destructive is False
    assert advertised["delete_issue_draft"]["annotations"]["destructiveHint"] is True
    assert advertised["save_issue_draft"]["annotations"]["idempotentHint"] is True
