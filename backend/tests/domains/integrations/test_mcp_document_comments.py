"""`add_comment` and `list_comments` on a document.

An agent names `document_id` instead of `issue_id` and reaches the same thread
the document page shows, with the same rights, and a read of it also needs the
scope that reads documents.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import MEMBER
from tests.domains.integrations.conftest import TEAM
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

SCOPES = ("teams:read", "teams:write", "projects:read", "projects:write", "issues:read", "comments:write")


def _document(client: TestClient, secret: str) -> str:
    """One team document written through the tools."""
    return answer(tool(client, secret, "create_document", {"team_id": TEAM, "title": "Runbook"}))["document_id"]


def test_an_agent_comments_on_a_document_and_reads_the_thread(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A root and a reply come back in order, naming the document and no issue."""
    secret = mint_for(repositories, MEMBER, SCOPES)
    document_id = _document(client, secret)

    root = answer(tool(client, secret, "add_comment", {"document_id": document_id, "body": "Is this current?"}))
    reply = answer(
        tool(
            client,
            secret,
            "add_comment",
            {"document_id": document_id, "body": "Yes", "parent_comment_id": root["comment_id"]},
        )
    )
    listed = answer(tool(client, secret, "list_comments", {"document_id": document_id}))

    assert (root["document_id"], root["issue_id"]) == (document_id, None)
    assert [row["comment_id"] for row in listed["comments"]] == [root["comment_id"], reply["comment_id"]]
    assert listed["comments"][1]["parent_comment_id"] == root["comment_id"]
    followers = {row.user_id for row in repositories.subscriptions.list_for_issue(workspace, document_id)}
    assert followers == {MEMBER}


def test_a_comment_names_one_target(client: TestClient, workspace: str, repositories: Any) -> None:
    """Naming both an issue and a document, or neither, is refused."""
    secret = mint_for(repositories, MEMBER, SCOPES)
    document_id = _document(client, secret)

    both = {"document_id": document_id, "issue_id": "ABC-1", "body": "Hm"}
    assert "only one" in refusal(tool(client, secret, "add_comment", both))
    assert "issue_id" in refusal(tool(client, secret, "add_comment", {"body": "Hm"}))


def test_issue_only_arguments_are_refused_on_a_document(client: TestClient, workspace: str, repositories: Any) -> None:
    """A document has no GitHub thread to sync."""
    secret = mint_for(repositories, MEMBER, SCOPES)
    document_id = _document(client, secret)

    arguments = {"document_id": document_id, "body": "Hm", "sync_to_github": True}
    assert "issue comments only" in refusal(tool(client, secret, "add_comment", arguments))


def test_an_agent_pins_a_document_thread_to_a_quote(client: TestClient, workspace: str, repositories: Any) -> None:
    """A quote the body shows becomes the anchor with its context, and one it does not show is refused."""
    secret = mint_for(repositories, MEMBER, SCOPES)
    created = tool(
        client,
        secret,
        "create_document",
        {"team_id": TEAM, "title": "Runbook", "body": "Restart the **worker** before the deploy."},
    )
    document_id = answer(created)["document_id"]

    pinned = answer(
        tool(client, secret, "add_comment", {"document_id": document_id, "body": "Why?", "quote": "worker"})
    )
    missing = {"document_id": document_id, "body": "Hm", "quote": "scheduler"}
    on_reply = {"document_id": document_id, "body": "Hm", "quote": "worker", "parent_comment_id": pinned["comment_id"]}

    assert pinned["anchor"] == {"quote": "worker", "prefix": "Restart the ", "suffix": " before the deploy."}
    assert "the document shows" in refusal(tool(client, secret, "add_comment", missing))
    assert "reply" in refusal(tool(client, secret, "add_comment", on_reply))


def test_reading_a_documents_thread_needs_projects_read(client: TestClient, workspace: str, repositories: Any) -> None:
    """A key that reads issues but not documents cannot read a document's comments."""
    writer = mint_for(repositories, MEMBER, SCOPES)
    document_id = _document(client, writer)
    reader = mint_for(repositories, MEMBER, ("issues:read",))

    assert "projects:read" in refusal(tool(client, reader, "list_comments", {"document_id": document_id}))


def test_an_unknown_document_is_refused(client: TestClient, workspace: str, repositories: Any) -> None:
    """A made up id answers a refusal rather than an empty thread."""
    secret = mint_for(repositories, MEMBER, SCOPES)

    refusal(tool(client, secret, "list_comments", {"document_id": "01JB0000000000000000NODOC1"}))
    refusal(tool(client, secret, "add_comment", {"document_id": "01JB0000000000000000NODOC1", "body": "Hi"}))
