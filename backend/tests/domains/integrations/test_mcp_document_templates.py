"""The document template MCP tools: kind document on the template tools, and template_id on the create tools.

An agent saves a document template the way the settings page does, lists it
by kind, and starts a document or a project update from it by name.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import MEMBER
from tests.domains.integrations.conftest import TEAM
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

SCOPES = ("teams:read", "teams:write", "projects:read", "projects:write")

BODY = "## Goal\n\n## Plan\n"


def _save(client: TestClient, secret: str) -> dict[str, Any]:
    """Save a document template on the team through the tool and answer it."""
    arguments = {"team_id": TEAM, "kind": "document", "name": "Spec", "title": "Spec", "body": BODY}
    return answer(tool(client, secret, "create_template", arguments))


def _project(client: TestClient, secret: str) -> str:
    """One project on the team, made through the tool, returning its id."""
    return answer(tool(client, secret, "create_project", {"name": "Launch", "team_ids": [TEAM]}))["project_id"]


def test_a_document_template_is_saved_and_listed_by_kind(client: TestClient, workspace: str, repositories: Any) -> None:
    """kind document saves a document template, and only the document list carries it."""
    secret = mint_for(repositories, MEMBER, SCOPES)

    saved = _save(client, secret)
    issue_list = answer(tool(client, secret, "list_templates", {"team_id": TEAM}))
    document_list = answer(tool(client, secret, "list_templates", {"team_id": TEAM, "kind": "document"}))

    assert saved["kind"] == "document"
    assert issue_list["templates"] == []
    assert [row["name"] for row in document_list["templates"]] == ["Spec"]


def test_a_document_template_refuses_issue_fields(client: TestClient, workspace: str, repositories: Any) -> None:
    """A document template holds a title and a body only."""
    secret = mint_for(repositories, MEMBER, SCOPES)

    arguments = {"team_id": TEAM, "kind": "document", "name": "Bad", "priority": "high"}
    text = refusal(tool(client, secret, "create_template", arguments))

    assert "title and body only" in text


def test_create_document_from_a_template_by_name(client: TestClient, workspace: str, repositories: Any) -> None:
    """create_document takes the template's name and fills the title and body it left out."""
    secret = mint_for(repositories, MEMBER, SCOPES)
    _save(client, secret)
    project_id = _project(client, secret)

    document = answer(tool(client, secret, "create_document", {"project_id": project_id, "template_id": "spec"}))

    assert document["title"] == "Spec"
    assert document["body"] == BODY


def test_create_project_update_from_a_template(client: TestClient, workspace: str, repositories: Any) -> None:
    """create_project_update posts the template's body when no body is given, and refuses neither."""
    secret = mint_for(repositories, MEMBER, SCOPES)
    saved = _save(client, secret)
    project_id = _project(client, secret)

    update = answer(
        tool(
            client,
            secret,
            "create_project_update",
            {"project_id": project_id, "health": "on_track", "template_id": saved["id"]},
        )
    )
    text = refusal(tool(client, secret, "create_project_update", {"project_id": project_id, "health": "on_track"}))

    assert update["body"] == BODY
    assert "body must not be blank" in text
