"""Isolation arguments for the document MCP tools."""

from __future__ import annotations

from typing import Any

from app.common.db.dynamo.documents import Document, DocumentBody
from tests.domains.helpers import OWNER

ANSWERS_AT_HOME: frozenset[str] = frozenset()


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """A document under the other workspace's project, so its id can be named."""
    project = repositories.planning.list_projects(workspace_id)[0]
    document = Document(
        workspace_id=workspace_id,
        parent_kind="project",
        parent_id=project.project_id,
        title="Classified document",
        author_id=OWNER,
        updated_by=OWNER,
    )
    body = DocumentBody(
        workspace_id=workspace_id,
        document_id=document.document_id,
        parent_kind="project",
        parent_id=project.project_id,
        body="Classified body",
    )
    repositories.documents.create(document, body)
    return {"document_id": document.document_id}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's rows, one set per tool."""
    document = foreign["document_id"]
    project = foreign["project_id"]
    return {
        "list_documents": {"project_id": project},
        "get_document": {"document_id": document},
        "create_document": {"project_id": project, "title": "Should not land"},
        "update_document": {"document_id": document, "title": "Should not land"},
        "delete_document": {"document_id": document},
    }
