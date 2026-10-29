"""The MCP list_document_versions and restore_document_version tools.

An agent lists a document's kept versions newest first and restores one,
which lands as an edit that keeps the replaced body as a version, and a restore
chosen against an older body is refused with the current one, as a stale
update_document is.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.body_versions import BODY_CHANGED, body_version
from app.domains.integrations.mcp.toolkit import NOT_VISIBLE
from tests.domains.helpers import ADMIN, MEMBER
from tests.domains.integrations.conftest import TEAM
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

DOCUMENT_SCOPES = ("teams:read", "teams:write", "projects:read", "projects:write")


def _rewritten(client: TestClient, repositories: Any) -> "tuple[str, str]":
    """A document the member wrote and the admin rewrote, answering its id and the admin's key."""
    mine = mint_for(repositories, MEMBER, DOCUMENT_SCOPES)
    created = answer(tool(client, mine, "create_document", {"team_id": TEAM, "title": "Runbook", "body": "First"}))
    theirs = mint_for(repositories, ADMIN, DOCUMENT_SCOPES)
    answer(tool(client, theirs, "update_document", {"document_id": created["document_id"], "body": "Second"}))
    return created["document_id"], theirs


def test_list_document_versions_answers_the_kept_versions_newest_first(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """The text before each edit session comes back with its author, newest first."""
    document_id, secret = _rewritten(client, repositories)
    answer(
        tool(
            client,
            mint_for(repositories, MEMBER, DOCUMENT_SCOPES),
            "update_document",
            {"document_id": document_id, "body": "Third"},
        )
    )

    listed = answer(tool(client, secret, "list_document_versions", {"document_id": document_id}))

    assert [(row["body"], row["edited_by"]) for row in listed["versions"]] == [("Second", ADMIN), ("First", MEMBER)]


def test_restore_document_version_puts_the_body_back_and_keeps_the_replaced_one(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A restore lands with a fresh body version and the replaced body becomes the newest version."""
    document_id, secret = _rewritten(client, repositories)
    version_id = answer(tool(client, secret, "list_document_versions", {"document_id": document_id}))["versions"][0][
        "version_id"
    ]

    restored = answer(
        tool(
            client,
            secret,
            "restore_document_version",
            {"document_id": document_id, "version_id": version_id, "base_body_version": body_version("Second")},
        )
    )

    assert (restored["body"], restored["body_version"]) == ("First", body_version("First"))
    listed = answer(tool(client, secret, "list_document_versions", {"document_id": document_id}))
    assert [row["body"] for row in listed["versions"]] == ["Second", "First"]


def test_restore_document_version_refuses_a_stale_body(client: TestClient, workspace: str, repositories: Any) -> None:
    """A restore chosen against a body a teammate has since replaced is refused with that body."""
    document_id, secret = _rewritten(client, repositories)
    version_id = answer(tool(client, secret, "list_document_versions", {"document_id": document_id}))["versions"][0][
        "version_id"
    ]
    member = mint_for(repositories, MEMBER, DOCUMENT_SCOPES)
    answer(tool(client, member, "update_document", {"document_id": document_id, "body": "Theirs"}))

    text = refusal(
        tool(
            client,
            secret,
            "restore_document_version",
            {"document_id": document_id, "version_id": version_id, "base_body_version": body_version("Second")},
        )
    )

    assert BODY_CHANGED in text and "Theirs" in text
    current = answer(tool(client, secret, "get_document", {"document_id": document_id}))
    assert current["body"] == "Theirs"


def test_restore_document_version_refuses_an_unknown_version(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A version id the document does not keep is refused and the body stays."""
    document_id, secret = _rewritten(client, repositories)

    text = refusal(
        tool(
            client,
            secret,
            "restore_document_version",
            {"document_id": document_id, "version_id": "01M0000000000000000000000"},
        )
    )

    assert text == NOT_VISIBLE
