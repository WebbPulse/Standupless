"""`add_comment` with `quote`: an agent pinning a new thread to a passage of the description."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.issues import Issue
from tests.domains.helpers import MEMBER
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

SCOPES = ("comments:write", "issues:read")


def describe(repositories: Any, issue: Issue, body: str) -> None:
    """Give the seeded issue a description to quote from."""
    row = repositories.issues.get(issue.workspace_id, issue.issue_id)
    repositories.issues.replace(row.model_copy(update={"body": body}))


def test_a_quote_pins_the_new_thread(client: TestClient, repositories: Any, issue: Issue) -> None:
    """The tool finds the passage in the description and stores its context too."""
    describe(repositories, issue, "We should cache the **board** query before launch.")
    secret = mint_for(repositories, MEMBER, SCOPES)

    created = answer(
        tool(client, secret, "add_comment", {"issue_id": "ABC-1", "body": "Which one?", "quote": "the board query"})
    )
    listed = answer(tool(client, secret, "list_comments", {"issue_id": "ABC-1"}))

    assert created["anchor"] == {"quote": "the board query", "prefix": "We should cache ", "suffix": " before launch."}
    assert listed["comments"][0]["anchor"]["quote"] == "the board query"


def test_a_quote_the_description_lacks_is_refused(client: TestClient, repositories: Any, issue: Issue) -> None:
    """An agent cannot pin a thread to words that are not there."""
    describe(repositories, issue, "A short description.")
    secret = mint_for(repositories, MEMBER, SCOPES)

    refused = refusal(tool(client, secret, "add_comment", {"issue_id": "ABC-1", "body": "Hm", "quote": "missing"}))

    assert "quote" in refused


def test_a_quote_on_a_reply_is_refused(client: TestClient, repositories: Any, issue: Issue) -> None:
    """A reply sits under its root's passage, so it takes no quote of its own."""
    describe(repositories, issue, "A short description.")
    secret = mint_for(repositories, MEMBER, SCOPES)
    root = answer(tool(client, secret, "add_comment", {"issue_id": "ABC-1", "body": "Root"}))

    refused = refusal(
        tool(
            client,
            secret,
            "add_comment",
            {"issue_id": "ABC-1", "body": "Reply", "parent_comment_id": root["comment_id"], "quote": "short"},
        )
    )

    assert "quote" in refused
