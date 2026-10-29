"""The MCP tools for comment, new issue and status update drafts, so an agent can stage work for a person to finish.

Every tool runs the drafts routes' own `app.common.comment_drafts`,
`app.common.issue_drafts` or `app.common.update_drafts` path, which keys each
draft by the credential's own user, so no argument can reach another member's
drafts. A comment draft saved here is restored in that member's composer the
next time they open the issue, the document, the update thread or the reply thread, a new issue draft is listed
under Drafts in their create dialog, a status update draft is restored in the
update composer of its project or initiative, and saving any of them never
notifies anyone.
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import HTTPException, status
from pydantic import ValidationError

from app.common.api.dependencies.authz import Capability, check_capability
from app.common.api.schemas.drafts import DraftRead, DraftWrite, UpdateDraftRead, UpdateDraftWrite
from app.common.api.schemas.issue_drafts import DRAFT_ID_PATTERN, IssueDraftRead, IssueDraftWrite
from app.common.comment_drafts import (
    DraftParent,
    UpdateThreadRef,
    delete_draft,
    get_draft,
    list_drafts,
    save_draft,
)
from app.common.db.dynamo.views import ISSUE_DRAFTS_MAX, UpdateDraftTarget
from app.common.issue_drafts import delete_issue_draft, get_issue_draft, list_issue_drafts, save_issue_draft
from app.common.issue_keys import current
from app.common.update_drafts import delete_update_draft, find_update_draft, save_update_draft
from app.domains.integrations.mcp.toolkit import (
    Tool,
    ToolCall,
    enum,
    initiative_id_ref,
    issue_ref,
    object_schema,
    project_id_ref,
    string,
    string_list,
    team_id_ref,
    validation_message,
)
from app.domains.integrations.mcp.transport import ToolError

ISSUE = "The issue's id, or its key such as ABC-123"

DRAFT_ID = "The new issue draft's id, as list_issue_drafts or save_issue_draft answered it"

PRIORITIES = ("none", "urgent", "high", "medium", "low")

PROJECT = "The project's id or name; give this or initiative_id, not both"

INITIATIVE = "The initiative's id or name; give this or project_id, not both"

HEALTHS = ("on_track", "at_risk", "off_track")

PARENT = (
    "A top level comment on the same issue or document whose reply thread the draft belongs to; omit for the "
    "issue or document itself"
)

COMMENT_ISSUE = "The issue's id, or its key such as ABC-123; give exactly one of issue_id, document_id and update_id"

COMMENT_DOCUMENT = "The document whose comment thread the draft sits on"

COMMENT_UPDATE = (
    "A project or initiative update whose reply thread the draft sits on; give project_id or initiative_id with it"
)

UPDATE_PROJECT = "With update_id: the project the update is on, by id or name"

UPDATE_INITIATIVE = "With update_id: the initiative the update is on, by id or name"


def _workspace_member(call: ToolCall) -> None:
    """Hold the capability every drafts route declares."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_READ)


def _parent(call: ToolCall) -> str | None:
    """The reply thread argument, with a blank one read as the parent's own thread."""
    value = call.optional("parent_comment_id")
    text = str(value).strip() if value is not None else ""
    return text or None


def _draft_json(draft: DraftRead) -> dict[str, Any]:
    """One draft as the drafts routes answer it."""
    return draft.model_dump(mode="json")


def _text_argument(call: ToolCall, name: str) -> str | None:
    """An optional id argument, with a blank one read as absent."""
    value = call.optional(name)
    text = str(value).strip() if value is not None else ""
    return text or None


def _comment_parent(call: ToolCall) -> DraftParent:
    """The issue, document or update thread a comment draft call names, refusing none or several."""
    issue = _text_argument(call, "issue_id")
    document = _text_argument(call, "document_id")
    update = _text_argument(call, "update_id")
    if sum(1 for value in (issue, document, update) if value) != 1:
        raise ToolError("Give exactly one of issue_id, document_id and update_id")
    if issue:
        return DraftParent(issue_id=issue_ref(call, issue).issue_id)
    if document:
        return DraftParent(document_id=document)
    target_kind, target_id = _update_target(call)
    return DraftParent(update=UpdateThreadRef(target_kind, target_id, update or ""))


def _parent_json(parent: DraftParent, reply_to: str | None) -> dict[str, Any]:
    """The parent a discarded draft sat on, as the delete answers it."""
    if parent.update is not None:
        return {"update_id": parent.update.update_id}
    if parent.document_id:
        return {"document_id": parent.document_id, "parent_comment_id": reply_to}
    return {"issue_id": parent.issue_id, "parent_comment_id": reply_to}


def _set_comment_draft(call: ToolCall) -> Any:
    """Save the caller's draft on an issue, document or update thread, replacing the one there."""
    _workspace_member(call)
    parent = _comment_parent(call)
    try:
        payload = DraftWrite.model_validate({"body": str(call.require("body"))})
    except ValueError as exc:
        raise ToolError("body must be non-blank Markdown of at most 65536 bytes") from exc
    saved = save_draft(
        call.repositories, call.context, None, payload.body, parent_comment_id=_parent(call), parent=parent
    )
    return _draft_json(saved)


def _get_comment_draft(call: ToolCall) -> Any:
    """The caller's draft on an issue, document or update thread, or null when there is none."""
    _workspace_member(call)
    parent = _comment_parent(call)
    try:
        found = get_draft(call.repositories, call.context, None, parent_comment_id=_parent(call), parent=parent)
    except HTTPException as exc:
        if exc.status_code == status.HTTP_404_NOT_FOUND:
            return {"draft": None}
        raise
    return {"draft": _draft_json(found)}


def _list_comment_drafts(call: ToolCall) -> Any:
    """The caller's drafts, newest saved first, across the workspace or on one issue, document or update."""
    _workspace_member(call)
    reference = _text_argument(call, "issue_id")
    issue_id = issue_ref(call, reference).issue_id if reference else None
    drafts = list_drafts(
        call.repositories,
        call.context,
        issue_id=issue_id,
        document_id=_text_argument(call, "document_id"),
        update_id=_text_argument(call, "update_id"),
    )
    return {"drafts": [_draft_json(row) for row in drafts]}


def _delete_comment_draft(call: ToolCall) -> Any:
    """Discard the caller's draft in one thread, a no-op when there is none."""
    _workspace_member(call)
    parent = _comment_parent(call)
    reply_to = _parent(call)
    delete_draft(call.repositories, call.context, None, parent_comment_id=reply_to, parent=parent)
    return {"deleted": True, **_parent_json(parent, reply_to)}


def _checked_draft_id(value: Any) -> str:
    """A draft id, refused when it is not one a draft may carry."""
    text = str(value).strip()
    if not re.fullmatch(DRAFT_ID_PATTERN, text):
        raise ToolError("draft_id must be 1 to 64 letters, digits, hyphens or underscores")
    return text


def _optional_draft_id(call: ToolCall) -> str | None:
    """The draft id argument when one was given, with a blank one read as a new draft."""
    value = call.optional("draft_id")
    if value is None or not str(value).strip():
        return None
    return _checked_draft_id(value)


def _issue_draft_json(draft: IssueDraftRead) -> dict[str, Any]:
    """One new issue draft as the drafts routes answer it."""
    return draft.model_dump(mode="json")


FIELDS = (
    "title",
    "body",
    "template_id",
    "status_id",
    "priority",
    "assignee_id",
    "label_ids",
    "estimate",
    "project_id",
    "project_milestone_id",
    "cycle_id",
    "start_date",
    "due_date",
    "sub_issues",
)


def _save_issue_draft(call: ToolCall) -> Any:
    """Save one of the caller's new issue drafts, creating it when draft_id is new or omitted."""
    _workspace_member(call)
    draft_id = _optional_draft_id(call)
    fields: dict[str, Any] = {name: call.arguments[name] for name in FIELDS if call.arguments.get(name) is not None}
    fields["team_id"] = team_id_ref(call, call.require("team_id"))
    reference = call.optional("parent_id")
    if reference:
        parent = current(call.repositories.teams, issue_ref(call, reference))
        fields["parent_id"] = parent.issue_id
        fields["parent_key"] = parent.key
        fields["parent_title"] = parent.title[:1000]
    try:
        payload = IssueDraftWrite.model_validate(fields)
    except ValidationError as exc:
        raise ToolError(validation_message(exc)) from exc
    saved = save_issue_draft(call.repositories, call.context, payload, draft_id=draft_id)
    return _issue_draft_json(saved)


def _get_issue_draft(call: ToolCall) -> Any:
    """One of the caller's new issue drafts, or null when there is none."""
    _workspace_member(call)
    draft_id = _checked_draft_id(call.require("draft_id"))
    try:
        found = get_issue_draft(call.repositories, call.context, draft_id)
    except HTTPException as exc:
        if exc.status_code == status.HTTP_404_NOT_FOUND:
            return {"draft": None}
        raise
    return {"draft": _issue_draft_json(found)}


def _list_issue_drafts(call: ToolCall) -> Any:
    """The caller's new issue drafts, newest saved first."""
    _workspace_member(call)
    drafts = list_issue_drafts(call.repositories, call.context)
    return {"drafts": [_issue_draft_json(row) for row in drafts], "limit": ISSUE_DRAFTS_MAX}


def _delete_issue_draft(call: ToolCall) -> Any:
    """Discard one of the caller's new issue drafts, a no-op when there is none."""
    _workspace_member(call)
    draft_id = _checked_draft_id(call.require("draft_id"))
    delete_issue_draft(call.repositories, call.context, draft_id)
    return {"deleted": True, "draft_id": draft_id}


def _update_target(call: ToolCall) -> tuple[UpdateDraftTarget, str]:
    """The project or initiative a status update draft call names, refusing both or neither."""
    project = call.optional("project_id")
    initiative = call.optional("initiative_id")
    if bool(project) == bool(initiative):
        raise ToolError("Give exactly one of project_id and initiative_id")
    if initiative:
        return "initiative", initiative_id_ref(call, initiative)
    return "project", project_id_ref(call, project)


def _update_draft_json(draft: UpdateDraftRead) -> dict[str, Any]:
    """One status update draft as the drafts routes answer it."""
    return draft.model_dump(mode="json")


def _set_update_draft(call: ToolCall) -> Any:
    """Save the caller's status update draft on a project or initiative, replacing the one there."""
    _workspace_member(call)
    target_kind, target_id = _update_target(call)
    try:
        payload = UpdateDraftWrite.model_validate(
            {"body": str(call.require("body")), "health": call.optional("health")}
        )
    except ValidationError as exc:
        raise ToolError(validation_message(exc)) from exc
    saved = save_update_draft(call.repositories, call.context, target_kind, target_id, payload)
    return _update_draft_json(saved)


def _get_update_draft(call: ToolCall) -> Any:
    """The caller's status update draft on a project or initiative, or null when there is none."""
    _workspace_member(call)
    target_kind, target_id = _update_target(call)
    found = find_update_draft(call.repositories, call.context, target_kind, target_id)
    return {"draft": _update_draft_json(found) if found is not None else None}


def _delete_update_draft(call: ToolCall) -> Any:
    """Discard the caller's status update draft on a project or initiative, a no-op when there is none."""
    _workspace_member(call)
    target_kind, target_id = _update_target(call)
    delete_update_draft(call.repositories, call.context, target_kind, target_id)
    key = "project_id" if target_kind == "project" else "initiative_id"
    return {"deleted": True, key: target_id}


THREAD_ARGUMENTS: dict[str, Any] = {
    "issue_id": string(COMMENT_ISSUE),
    "document_id": string(COMMENT_DOCUMENT),
    "update_id": string(COMMENT_UPDATE),
    "project_id": string(UPDATE_PROJECT),
    "initiative_id": string(UPDATE_INITIATIVE),
    "parent_comment_id": string(PARENT),
}
"""The arguments naming one comment draft thread, shared by the comment draft tools that address one."""


DRAFT_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="set_comment_draft",
        description=(
            "Stage a comment as your draft on an issue, a document or a project or initiative update's reply "
            "thread, for a person to review and post. Give exactly one of issue_id, document_id and update_id, and "
            "parent_comment_id for a reply thread of an issue or document. It is restored in the comment box when "
            "the thread is opened. One draft per thread: saving again replaces it. Drafts are private and never "
            "notify anyone; posting the comment clears it."
        ),
        scopes=("comments:write",),
        schema=object_schema(
            {
                **THREAD_ARGUMENTS,
                "body": string("The draft body, in Markdown"),
            },
            required=("body",),
        ),
        handler=_set_comment_draft,
        idempotent=True,
    ),
    Tool(
        name="get_comment_draft",
        description=(
            "Your draft on an issue, a document or an update thread, or on a reply thread with parent_comment_id. "
            "Give exactly one of issue_id, document_id and update_id. Answers draft=null when there is none."
        ),
        scopes=("issues:read",),
        schema=object_schema(THREAD_ARGUMENTS),
        handler=_get_comment_draft,
    ),
    Tool(
        name="list_comment_drafts",
        description=(
            "Your unposted comment drafts, newest saved first, each with its parent_kind and its issue key and "
            "title or document title. Pass one of issue_id, document_id and update_id to list only that parent's "
            "drafts. Drafts on parents you can no longer see are left out."
        ),
        scopes=("issues:read",),
        schema=object_schema(
            {
                "issue_id": string(ISSUE),
                "document_id": string(COMMENT_DOCUMENT),
                "update_id": string("A project or initiative update"),
            }
        ),
        handler=_list_comment_drafts,
    ),
    Tool(
        name="delete_comment_draft",
        description=(
            "Discard your draft on an issue, a document or an update thread, or on a reply thread with "
            "parent_comment_id. Give exactly one of issue_id, document_id and update_id. A no-op when there is none."
        ),
        scopes=("comments:write",),
        schema=object_schema(THREAD_ARGUMENTS),
        handler=_delete_comment_draft,
        destructive=True,
        idempotent=True,
    ),
    Tool(
        name="save_issue_draft",
        description=(
            "Save a new issue as your draft, for a person to review and file from the Drafts list in the create "
            "issue dialog. Omit draft_id to start a new draft, or pass one to replace that draft's fields. A draft "
            f"needs a title, a description or a sub-issue. You may keep {ISSUE_DRAFTS_MAX} drafts per workspace. "
            "Drafts are private and never notify anyone."
        ),
        scopes=("issues:write",),
        schema=object_schema(
            {
                "draft_id": string(DRAFT_ID + "; omit to start a new draft"),
                "team_id": string("The team the issue would be filed in: its id, key prefix such as ENG, or name"),
                "title": string("The issue title"),
                "body": string("The issue description, in Markdown"),
                "template_id": string("The template the draft was started from"),
                "status_id": string("The status id the issue would start in"),
                "priority": enum(PRIORITIES, "The issue priority"),
                "assignee_id": string("The user id the issue would be assigned to"),
                "label_ids": string_list("The label ids the issue would carry"),
                "estimate": string("The estimate, such as M"),
                "project_id": string("The project id the issue would join"),
                "project_milestone_id": string("The project milestone id the issue would sit in"),
                "cycle_id": string("The cycle id the issue would join"),
                "start_date": string("The start date, as YYYY-MM-DD"),
                "due_date": string("The due date, as YYYY-MM-DD"),
                "parent_id": string("The parent issue's id or key, such as ABC-123"),
                "sub_issues": string_list("Titles of sub-issues to file under the new issue"),
            },
            required=("team_id",),
        ),
        handler=_save_issue_draft,
        idempotent=True,
    ),
    Tool(
        name="get_issue_draft",
        description="One of your new issue drafts with every field it holds. Answers draft=null when there is none.",
        scopes=("issues:read",),
        schema=object_schema({"draft_id": string(DRAFT_ID)}, required=("draft_id",)),
        handler=_get_issue_draft,
    ),
    Tool(
        name="list_issue_drafts",
        description=(
            "Your unfiled new issue drafts, newest saved first, with the most you may keep. Drafts on teams you "
            "can no longer see are left out."
        ),
        scopes=("issues:read",),
        schema=object_schema({}),
        handler=_list_issue_drafts,
    ),
    Tool(
        name="delete_issue_draft",
        description="Discard one of your new issue drafts. A no-op when there is none.",
        scopes=("issues:write",),
        schema=object_schema({"draft_id": string(DRAFT_ID)}, required=("draft_id",)),
        handler=_delete_issue_draft,
        destructive=True,
        idempotent=True,
    ),
    Tool(
        name="set_update_draft",
        description=(
            "Stage a status update as your draft on a project or an initiative, for a person to review and post. "
            "Give exactly one of project_id and initiative_id. It is restored in the update composer when the "
            "project or initiative is opened. One draft per project and per initiative: saving again replaces it. "
            "Drafts are private and never notify anyone; posting the update clears it."
        ),
        scopes=("projects:write",),
        schema=object_schema(
            {
                "project_id": string(PROJECT),
                "initiative_id": string(INITIATIVE),
                "body": string("The draft body, in Markdown"),
                "health": enum(HEALTHS, "The health the update would report; omit while undecided"),
            },
            required=("body",),
        ),
        handler=_set_update_draft,
        idempotent=True,
    ),
    Tool(
        name="get_update_draft",
        description=(
            "Your status update draft on a project or an initiative. Give exactly one of project_id and "
            "initiative_id. Answers draft=null when there is none."
        ),
        scopes=("projects:read",),
        schema=object_schema({"project_id": string(PROJECT), "initiative_id": string(INITIATIVE)}),
        handler=_get_update_draft,
    ),
    Tool(
        name="delete_update_draft",
        description=(
            "Discard your status update draft on a project or an initiative. Give exactly one of project_id and "
            "initiative_id. A no-op when there is none."
        ),
        scopes=("projects:write",),
        schema=object_schema({"project_id": string(PROJECT), "initiative_id": string(INITIATIVE)}),
        handler=_delete_update_draft,
        destructive=True,
        idempotent=True,
    ),
)
