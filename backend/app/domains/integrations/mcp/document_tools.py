"""The MCP tools for documents: Markdown pages under a project, an initiative or a team.

Every tool runs the same `app.common.documents` path the document routes do, so
the rights, the version history and the issue mentions match HTTP exactly. A
document is listed and created through its parent, named by id or by a unique
name, and reached afterwards by its own id. `update_document` also moves one to
another parent.
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
    team_id_ref,
)
from app.domains.integrations.mcp.transport import ToolError

PARENT_PROPERTIES: dict[str, Any] = {
    "project_id": string("The parent project: id or name. Give exactly one of project_id, initiative_id or team_id"),
    "initiative_id": string(
        "The parent initiative: id or name. Give exactly one of project_id, initiative_id or team_id"
    ),
    "team_id": string(
        "The parent team: id, key prefix or name. Give exactly one of project_id, initiative_id or team_id"
    ),
}

MOVE_PROPERTIES: dict[str, Any] = {
    "project_id": string("Move the document under this project: id or name"),
    "initiative_id": string("Move the document under this initiative: id or name"),
    "team_id": string("Move the document under this team: id, key prefix or name"),
}

ICON_PROPERTY = string(
    "The document's icon: an emoji, or a glyph name such as book, rocket or target. An empty string clears it"
)


def _summary_json(document: DocumentSummaryRead) -> dict[str, Any]:
    """One document without its body, as the list tool answers it."""
    return {
        "document_id": document.document_id,
        "parent_kind": document.parent_kind,
        "parent_id": document.parent_id,
        "parent_name": document.parent_name,
        "title": document.title,
        "icon": document.icon,
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
        "body_version": document.body_version,
        "mentions": [mention.model_dump() for mention in document.mentions],
    }


def _named_parent(call: ToolCall) -> tuple[str, str] | None:
    """The parent kind and id a call names, `None` when it names none, or an error when it names several."""
    named = {name: call.optional(name) for name in ("project_id", "initiative_id", "team_id")}
    given = [name for name, value in named.items() if value]
    if not given:
        return None
    if len(given) > 1:
        raise ToolError("give exactly one of project_id, initiative_id or team_id")
    name = given[0]
    if name == "project_id":
        return "project", project_id_ref(call, named[name])
    if name == "initiative_id":
        return "initiative", initiative_id_ref(call, named[name])
    return "team", team_id_ref(call, named[name])


def _parent(call: ToolCall) -> tuple[str, str]:
    """The parent kind and id a list or create call names, exactly one of the three."""
    parent = _named_parent(call)
    if parent is None:
        raise ToolError("give exactly one of project_id, initiative_id or team_id")
    return parent


def _list_documents(call: ToolCall) -> Any:
    """A project's, an initiative's or a team's documents, most recently edited first."""
    kind, parent_id = _parent(call)
    rows = list_documents(call.repositories, call.context, kind, parent_id)
    return {"documents": [_summary_json(row) for row in rows]}


def _get_document(call: ToolCall) -> Any:
    """One document with its body."""
    return _document_json(get_document(call.repositories, call.context, str(call.require("document_id"))))


def _create_document(call: ToolCall) -> Any:
    """Write a new document under a project, an initiative or a team, from a document template when one is named."""
    kind, parent_id = _parent(call)
    fields = {name: call.optional(name) for name in ("title", "body", "icon", "template_id")}
    payload = DocumentCreate.model_validate({name: value for name, value in fields.items() if value is not None})
    return _document_json(create_document(call.repositories, call.context, kind, parent_id, payload))


def _update_document(call: ToolCall) -> Any:
    """Rename, rewrite, restyle or move a document.

    `base_body_version` guards a new body against overwriting a body someone
    else changed since it was read.
    """
    fields: dict[str, Any] = {}
    for name in ("title", "body", "base_body_version"):
        if call.optional(name) is not None:
            fields[name] = call.arguments[name]
    if call.present("icon"):
        fields["icon"] = call.arguments["icon"]
    parent = _named_parent(call)
    if parent is not None:
        fields["parent_kind"], fields["parent_id"] = parent
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
        description="The documents of one project, initiative or team, newest edit first, without their bodies.",
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
            "Write a Markdown document under a project, an initiative or a team. Issue keys such as ABC-12 in the body "
            "link to those issues and show on their pages. Give template_id to start from a document template; "
            "list_templates with kind document lists them."
        ),
        scopes=("projects:write",),
        schema=object_schema(
            {
                **PARENT_PROPERTIES,
                "title": string("The document title. Required unless template_id is given, which fills it"),
                "body": string("The document, in Markdown. Left out, a template's body is used"),
                "icon": ICON_PROPERTY,
                "template_id": string(
                    "A document template to start from: id or name. Offered are the templates of the project's "
                    "or team's teams and the workspace's, or the workspace's alone for an initiative"
                ),
            },
        ),
        handler=_create_document,
    ),
    Tool(
        name="update_document",
        description=(
            "Rename, rewrite, restyle or move a document. Only the fields named are written; the earlier text is "
            "kept in its version history. Give one of project_id, initiative_id or team_id to move the document "
            "there, which needs the right to write documents under both parents."
        ),
        scopes=("projects:write",),
        schema=object_schema(
            {
                "document_id": string("The document id"),
                "title": string("The new title"),
                "body": string("The new body, in Markdown"),
                "base_body_version": string(
                    "The body_version the new body was written against; when the body changed since, the update "
                    "is refused with the current body and version instead of overwriting it"
                ),
                "icon": ICON_PROPERTY,
                **MOVE_PROPERTIES,
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
