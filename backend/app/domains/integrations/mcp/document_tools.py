"""The MCP tools for documents: Markdown pages under a project or an initiative.

Every tool runs the same `app.common.documents` path the document routes do, so
the rights, the version history and the issue mentions match HTTP exactly. A
document is listed and created through its parent, named by id or by a unique
name, and reached afterwards by its own id.
"""

from __future__ import annotations

from typing import Any

from app.common.api.schemas.documents import DocumentCreate, DocumentPatch, DocumentRead, DocumentSummaryRead
from app.common.documents import (
    create_document,
    delete_document,
    get_document,
    list_documents,
    update_document,
)
from app.domains.integrations.mcp.toolkit import (
    Tool,
    ToolCall,
    initiative_id_ref,
    object_schema,
    project_id_ref,
    string,
)
from app.domains.integrations.mcp.transport import ToolError

PARENT_PROPERTIES: dict[str, Any] = {
    "project_id": string("The parent project: id or name. Give this or initiative_id"),
    "initiative_id": string("The parent initiative: id or name. Give this or project_id"),
}


def _summary_json(document: DocumentSummaryRead) -> dict[str, Any]:
    """One document without its body, as the list tool answers it."""
    return {
        "document_id": document.document_id,
        "parent_kind": document.parent_kind,
        "parent_id": document.parent_id,
        "parent_name": document.parent_name,
        "title": document.title,
        "author_id": document.author_id,
        "updated_by": document.updated_by,
        "created_at": document.created_at.isoformat(),
        "updated_at": document.updated_at.isoformat(),
        "can_edit": document.can_edit,
        "can_delete": document.can_delete,
    }


def _document_json(document: DocumentRead) -> dict[str, Any]:
    """One document with its Markdown and the issues it mentions."""
    return {
        **_summary_json(document),
        "body": document.body,
        "mentions": [mention.model_dump() for mention in document.mentions],
    }


def _parent(call: ToolCall) -> tuple[str, str]:
    """The parent kind and id a list or create call names, exactly one of the two."""
    project = call.optional("project_id")
    initiative = call.optional("initiative_id")
    if bool(project) == bool(initiative):
        raise ToolError("give exactly one of project_id or initiative_id")
    if project:
        return "project", project_id_ref(call, project)
    return "initiative", initiative_id_ref(call, initiative)


def _list_documents(call: ToolCall) -> Any:
    """A project's or an initiative's documents, most recently edited first."""
    kind, parent_id = _parent(call)
    rows = list_documents(call.repositories, call.context, kind, parent_id)
    return {"documents": [_summary_json(row) for row in rows]}


def _get_document(call: ToolCall) -> Any:
    """One document with its body."""
    return _document_json(get_document(call.repositories, call.context, str(call.require("document_id"))))


def _create_document(call: ToolCall) -> Any:
    """Write a new document under a project or an initiative."""
    kind, parent_id = _parent(call)
    payload = DocumentCreate.model_validate({"title": call.require("title"), "body": call.optional("body") or ""})
    return _document_json(create_document(call.repositories, call.context, kind, parent_id, payload))


def _update_document(call: ToolCall) -> Any:
    """Rename or rewrite a document."""
    fields: dict[str, Any] = {}
    for name in ("title", "body"):
        if call.optional(name) is not None:
            fields[name] = call.arguments[name]
    payload = DocumentPatch.model_validate(fields)
    document_id = str(call.require("document_id"))
    return _document_json(update_document(call.repositories, call.context, document_id, payload))


def _delete_document(call: ToolCall) -> Any:
    """Delete a document with its version history."""
    document_id = str(call.require("document_id"))
    delete_document(call.repositories, call.context, document_id)
    return {"deleted": True, "document_id": document_id}


DOCUMENT_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_documents",
        description="The documents of one project or initiative, most recently edited first, without their bodies.",
        scopes=("projects:read",),
        schema=object_schema(PARENT_PROPERTIES),
        handler=_list_documents,
    ),
    Tool(
        name="get_document",
        description="One document with its Markdown body and the issues it mentions.",
        scopes=("projects:read",),
        schema=object_schema({"document_id": string("The document id")}, required=("document_id",)),
        handler=_get_document,
    ),
    Tool(
        name="create_document",
        description=(
            "Write a Markdown document under a project or an initiative. Issue keys such as ABC-12 in the body "
            "link to those issues and show on their pages."
        ),
        scopes=("projects:write",),
        schema=object_schema(
            {
                **PARENT_PROPERTIES,
                "title": string("The document title"),
                "body": string("The document, in Markdown"),
            },
            required=("title",),
        ),
        handler=_create_document,
    ),
    Tool(
        name="update_document",
        description=(
            "Rename or rewrite a document. Only the fields named are written; the earlier text is kept in its "
            "version history."
        ),
        scopes=("projects:write",),
        schema=object_schema(
            {
                "document_id": string("The document id"),
                "title": string("The new title"),
                "body": string("The new body, in Markdown"),
            },
            required=("document_id",),
        ),
        handler=_update_document,
    ),
    Tool(
        name="delete_document",
        description="Permanently delete a document and its version history, as its author or an admin.",
        scopes=("projects:write",),
        schema=object_schema({"document_id": string("The document id")}, required=("document_id",)),
        handler=_delete_document,
        destructive=True,
    ),
)
