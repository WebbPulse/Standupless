"""The MCP update_issue and update_document tools on stale body saves.

An agent reads `body_version` with the text, sends it back as
`base_body_version`, and a save made after a teammate's edit is refused with
the current body and version instead of overwriting it. Leaving the version out
writes as before, so older clients keep working.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.body_versions import BODY_CHANGED, body_version
from app.common.db.dynamo.issues import Issue
from tests.domains.helpers import MEMBER
from tests.domains.integrations.conftest import TEAM, WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

DOCUMENT_SCOPES = ("teams:read", "teams:write", "projects:read", "projects:write")


def test_update_issue_refuses_a_stale_body_and_answers_the_current_one(
    client: TestClient, repositories: Any, issue: Issue
) -> None:
    """A body sent against the version read before a teammate's edit is refused with that edit."""
    secret = mint_for(repositories, MEMBER, ("issues:read", "issues:write"))
    first = answer(tool(client, secret, "update_issue", {"issue_id": issue.issue_id, "body": "First"}))
    assert first["body_version"] == body_version("First")
    theirs = answer(
        tool(
            client,
            secret,
            "update_issue",
            {"issue_id": issue.issue_id, "body": "Theirs", "base_body_version": first["body_version"]},
        )
    )

    text = refusal(
        tool(
            client,
            secret,
            "update_issue",
            {"issue_id": issue.issue_id, "body": "Mine", "base_body_version": first["body_version"]},
        )
    )

    assert BODY_CHANGED in text
    assert theirs["body_version"] in text and "Theirs" in text
    stored = repositories.issues.get(WORKSPACE, issue.issue_id)
    assert stored is not None and stored.body == "Theirs"


def test_update_issue_without_a_version_writes_as_before(client: TestClient, repositories: Any, issue: Issue) -> None:
    """An agent that sends no version still writes the body."""
    secret = mint_for(repositories, MEMBER, ("issues:read", "issues:write"))
    answer(tool(client, secret, "update_issue", {"issue_id": issue.issue_id, "body": "Theirs"}))

    mine = answer(tool(client, secret, "update_issue", {"issue_id": issue.issue_id, "body": "Mine"}))

    assert mine["body"] == "Mine"


def test_update_document_refuses_a_stale_body_and_answers_the_current_one(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A document body sent against an older version is refused, and one without a version lands."""
    secret = mint_for(repositories, MEMBER, DOCUMENT_SCOPES)
    created = answer(tool(client, secret, "create_document", {"team_id": TEAM, "title": "Runbook", "body": "First"}))
    assert created["body_version"] == body_version("First")
    document_id = created["document_id"]
    answer(
        tool(
            client,
            secret,
            "update_document",
            {"document_id": document_id, "body": "Theirs", "base_body_version": created["body_version"]},
        )
    )

    text = refusal(
        tool(
            client,
            secret,
            "update_document",
            {"document_id": document_id, "body": "Mine", "base_body_version": created["body_version"]},
        )
    )
    blind = answer(tool(client, secret, "update_document", {"document_id": document_id, "body": "Mine"}))

    assert BODY_CHANGED in text
    assert body_version("Theirs") in text and "Theirs" in text
    assert blind["body"] == "Mine"
