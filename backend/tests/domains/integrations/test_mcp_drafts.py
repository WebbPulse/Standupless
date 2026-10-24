"""The comment draft MCP tools: staging a comment for a person to post.

Each tool runs the drafts routes' own `app.common.comment_drafts` path, so the
rules asserted here are the routes': a draft is the credential's user's own, one
per issue and per reply thread, and posting the comment through `add_comment`
clears the draft it came from.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.issues import Issue
from app.domains.integrations.mcp.tools import TOOLS_BY_NAME
from tests.domains.helpers import GUEST, MEMBER, OWNER
from tests.domains.integrations.test_mcp import call, tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

DRAFTS = ("comments:write", "issues:read")


def test_a_draft_is_staged_by_key_read_and_listed(client: TestClient, repositories: Any, issue: Issue) -> None:
    """Saving by key resolves the issue, and the draft answers its key and title."""
    secret = mint_for(repositories, MEMBER, DRAFTS)

    saved = answer(tool(client, secret, "set_comment_draft", {"issue_id": "ABC-1", "body": "Staged for you"}))
    again = answer(tool(client, secret, "set_comment_draft", {"issue_id": "ABC-1", "body": "Staged, edited"}))
    read = answer(tool(client, secret, "get_comment_draft", {"issue_id": issue.issue_id}))
    listed = answer(tool(client, secret, "list_comment_drafts", {"issue_id": "ABC-1"}))

    assert (saved["issue_id"], saved["issue_key"]) == (issue.issue_id, "ABC-1")
    assert again["created_at"] == saved["created_at"]
    assert read["draft"]["body"] == "Staged, edited"
    assert [row["body"] for row in listed["drafts"]] == ["Staged, edited"]


def test_no_draft_reads_as_null(client: TestClient, repositories: Any, issue: Issue) -> None:
    """An agent asking for a draft that is not there gets null rather than an error."""
    secret = mint_for(repositories, MEMBER, DRAFTS)

    read = answer(tool(client, secret, "get_comment_draft", {"issue_id": "ABC-1"}))

    assert read == {"draft": None}


def test_a_blank_draft_is_refused(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A blank body is a discard, which is the delete tool's job."""
    secret = mint_for(repositories, MEMBER, DRAFTS)

    refused = refusal(tool(client, secret, "set_comment_draft", {"issue_id": "ABC-1", "body": "  "}))

    assert "body" in refused


def test_drafts_are_the_callers_own(client: TestClient, repositories: Any, issue: Issue) -> None:
    """Another member's credential reads, lists and discards nothing of the first one's."""
    mine = mint_for(repositories, MEMBER, DRAFTS)
    theirs = mint_for(repositories, OWNER, DRAFTS)
    answer(tool(client, mine, "set_comment_draft", {"issue_id": "ABC-1", "body": "Mine"}))

    read = answer(tool(client, theirs, "get_comment_draft", {"issue_id": "ABC-1"}))
    listed = answer(tool(client, theirs, "list_comment_drafts", {}))
    answer(tool(client, theirs, "delete_comment_draft", {"issue_id": "ABC-1"}))

    assert read == {"draft": None}
    assert listed["drafts"] == []
    assert repositories.views.get_draft(issue.workspace_id, MEMBER, issue.issue_id) is not None


def test_a_guest_cannot_draft_on_a_hidden_issue(client: TestClient, repositories: Any, hidden_issue: Issue) -> None:
    """The guest's team membership bounds a draft exactly as it bounds a comment."""
    secret = mint_for(repositories, GUEST, DRAFTS)

    refused = refusal(tool(client, secret, "set_comment_draft", {"issue_id": "XYZ-1", "body": "Sneaky"}))

    assert refused
    assert repositories.views.get_draft(hidden_issue.workspace_id, GUEST, hidden_issue.issue_id) is None


def test_reply_threads_hold_their_own_draft(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A reply draft sits beside the issue's draft and is discarded on its own."""
    secret = mint_for(repositories, MEMBER, DRAFTS)
    root = answer(tool(client, secret, "add_comment", {"issue_id": "ABC-1", "body": "Root"}))
    answer(tool(client, secret, "set_comment_draft", {"issue_id": "ABC-1", "body": "On the issue"}))
    answer(
        tool(
            client,
            secret,
            "set_comment_draft",
            {"issue_id": "ABC-1", "body": "On the reply", "parent_comment_id": root["comment_id"]},
        )
    )

    deleted = answer(
        tool(client, secret, "delete_comment_draft", {"issue_id": "ABC-1", "parent_comment_id": root["comment_id"]})
    )
    listed = answer(tool(client, secret, "list_comment_drafts", {}))

    assert deleted == {"deleted": True, "issue_id": issue.issue_id, "parent_comment_id": root["comment_id"]}
    assert [row["body"] for row in listed["drafts"]] == ["On the issue"]


def test_posting_through_add_comment_clears_the_draft(client: TestClient, repositories: Any, issue: Issue) -> None:
    """An agent that stages and then posts leaves no stale draft behind."""
    secret = mint_for(repositories, MEMBER, DRAFTS)
    answer(tool(client, secret, "set_comment_draft", {"issue_id": "ABC-1", "body": "Ready"}))

    answer(tool(client, secret, "add_comment", {"issue_id": "ABC-1", "body": "Ready"}))

    assert repositories.views.get_draft(issue.workspace_id, MEMBER, issue.issue_id) is None


def test_the_tools_declare_their_hints(client: TestClient, repositories: Any, issue: Issue) -> None:
    """Discarding is flagged destructive so a client asks first; saving and discarding are idempotent."""
    secret = mint_for(repositories, MEMBER, DRAFTS)

    advertised = {row["name"]: row for row in call(client, secret, "tools/list").json()["result"]["tools"]}

    assert TOOLS_BY_NAME["delete_comment_draft"].destructive is True
    assert TOOLS_BY_NAME["set_comment_draft"].destructive is False
    assert advertised["delete_comment_draft"]["annotations"]["destructiveHint"] is True
    assert advertised["set_comment_draft"]["annotations"]["idempotentHint"] is True
