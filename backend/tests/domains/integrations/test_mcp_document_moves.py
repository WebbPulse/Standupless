"""The document MCP tools on teams, icons and moves.

An agent files a document under a team, gives it an icon, and moves it to a
project with update_document, the way the document page does.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import MEMBER
from tests.domains.integrations.conftest import TEAM
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

SCOPES = ("teams:read", "teams:write", "projects:read", "projects:write")


def test_update_document_moves_and_restyles(client: TestClient, workspace: str, repositories: Any) -> None:
    """A team document takes an icon, moves to a project, and clears the icon with an empty string."""
    secret = mint_for(repositories, MEMBER, SCOPES)
    created = answer(tool(client, secret, "create_document", {"team_id": TEAM, "title": "Runbook", "icon": "book"}))
    project_id = answer(tool(client, secret, "create_project", {"name": "Launch", "team_ids": [TEAM]}))["project_id"]

    moved = answer(
        tool(client, secret, "update_document", {"document_id": created["document_id"], "project_id": project_id})
    )
    cleared = answer(tool(client, secret, "update_document", {"document_id": created["document_id"], "icon": ""}))
    listed = answer(tool(client, secret, "list_documents", {"project_id": project_id}))

    assert (created["parent_kind"], created["icon"]) == ("team", "book")
    assert (moved["parent_kind"], moved["parent_id"]) == ("project", project_id)
    assert cleared["icon"] is None
    assert [row["document_id"] for row in listed["documents"]] == [created["document_id"]]
    assert answer(tool(client, secret, "list_documents", {"team_id": TEAM}))["documents"] == []


def test_update_document_takes_one_destination(client: TestClient, workspace: str, repositories: Any) -> None:
    """Naming two parents is refused."""
    secret = mint_for(repositories, MEMBER, SCOPES)
    created = answer(tool(client, secret, "create_document", {"team_id": TEAM, "title": "Runbook"}))
    project_id = answer(tool(client, secret, "create_project", {"name": "Launch", "team_ids": [TEAM]}))["project_id"]

    arguments = {"document_id": created["document_id"], "project_id": project_id, "team_id": TEAM}
    assert "exactly one" in refusal(tool(client, secret, "update_document", arguments))
