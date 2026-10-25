"""The MCP tools for comment and new issue drafts, so an agent can stage work for a person to finish.

Every tool runs the drafts routes' own `app.common.comment_drafts` or
`app.common.issue_drafts` path, which keys each draft by the credential's own
user, so no argument can reach another member's drafts. A comment draft saved
here is restored in that member's composer the next time they open the issue or
the reply thread, a new issue draft is listed under Drafts in their create
dialog, and saving either never notifies anyone.
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import HTTPException, status
from pydantic import ValidationError

from app.common.api.dependencies.authz import Capability, check_capability
from app.common.api.schemas.drafts import DraftRead, DraftWrite
from app.common.api.schemas.issue_drafts import DRAFT_ID_PATTERN, IssueDraftRead, IssueDraftWrite
from app.common.comment_drafts import delete_draft, get_draft, list_drafts, save_draft
from app.common.db.dynamo.views import ISSUE_DRAFTS_MAX
from app.common.issue_drafts import delete_issue_draft, get_issue_draft, list_issue_drafts, save_issue_draft
from app.common.issue_keys import current
from app.domains.integrations.mcp.toolkit import (
    Tool,
    ToolCall,
    enum,
    issue_ref,
    object_schema,
    string,
    string_list,
    team_id_ref,
    validation_message,
)
from app.domains.integrations.mcp.transport import ToolError

ISSUE = "The issue's id, or its key such as ABC-123"

DRAFT_ID = "The new issue draft's id, as list_issue_drafts or save_issue_draft answered it"

PRIORITIES = ("none", "urgent", "high", "medium", "low")

PARENT = "A top level comment on the same issue whose reply thread the draft belongs to; omit for the issue itself"


def _workspace_member(call: ToolCall) -> None:
    """Hold the capability every drafts route declares."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_READ)


def _parent(call: ToolCall) -> str | None:
    """The reply thread argument, with a blank one read as the issue's own thread."""
    value = call.optional("parent_comment_id")
    text = str(value).strip() if value is not None else ""
    return text or None


def _draft_json(draft: DraftRead) -> dict[str, Any]:
    """One draft as the drafts routes answer it."""
    return draft.model_dump(mode="json")


def _set_comment_draft(call: ToolCall) -> Any:
    """Save the caller's draft on an issue or a reply thread, replacing the one there."""
    _workspace_member(call)
    issue = issue_ref(call, call.require("issue_id"))
    try:
        payload = DraftWrite.model_validate({"body": str(call.require("body"))})
    except ValueError as exc:
        raise ToolError("body must be non-blank Markdown of at most 65536 bytes") from exc
    saved = save_draft(call.repositories, call.context, issue.issue_id, payload.body, parent_comment_id=_parent(call))
    return _draft_json(saved)


def _get_comment_draft(call: ToolCall) -> Any:
    """The caller's draft on an issue or a reply thread, or null when there is none."""
    _workspace_member(call)
    issue = issue_ref(call, call.require("issue_id"))
    try:
        found = get_draft(call.repositories, call.context, issue.issue_id, parent_comment_id=_parent(call))
    except HTTPException as exc:
        if exc.status_code == status.HTTP_404_NOT_FOUND:
            return {"draft": None}
        raise
    return {"draft": _draft_json(found)}


def _list_comment_drafts(call: ToolCall) -> Any:
    """The caller's drafts, newest saved first, across the workspace or on one issue."""
    _workspace_member(call)
    reference = call.optional("issue_id")
    issue_id = issue_ref(call, reference).issue_id if reference else None
    drafts = list_drafts(call.repositories, call.context, issue_id=issue_id)
    return {"drafts": [_draft_json(row) for row in drafts]}


def _delete_comment_draft(call: ToolCall) -> Any:
    """Discard the caller's draft in one thread, a no-op when there is none."""
    _workspace_member(call)
    issue = issue_ref(call, call.require("issue_id"))
    parent = _parent(call)
    delete_draft(call.repositories, call.context, issue.issue_id, parent_comment_id=parent)
    return {"deleted": True, "issue_id": issue.issue_id, "parent_comment_id": parent}


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


DRAFT_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="set_comment_draft",
        description=(
            "Stage a comment as your draft on an issue, or on a reply thread with parent_comment_id, for a person "
            "to review and post. It is restored in the comment box when the issue is opened. One draft per issue "
            "and per reply thread: saving again replaces it. Drafts are private and never notify anyone; posting "
            "the comment clears it."
        ),
        scopes=("comments:write",),
        schema=object_schema(
            {
                "issue_id": string(ISSUE),
                "body": string("The draft body, in Markdown"),
                "parent_comment_id": string(PARENT),
            },
            required=("issue_id", "body"),
        ),
        handler=_set_comment_draft,
        idempotent=True,
    ),
    Tool(
        name="get_comment_draft",
        description=(
            "Your draft on an issue, or on a reply thread with parent_comment_id. Answers draft=null when there "
            "is none."
        ),
        scopes=("issues:read",),
        schema=object_schema(
            {"issue_id": string(ISSUE), "parent_comment_id": string(PARENT)},
            required=("issue_id",),
        ),
        handler=_get_comment_draft,
    ),
    Tool(
        name="list_comment_drafts",
        description=(
            "Your unposted comment drafts, newest saved first, each with its issue key and title. Pass issue_id "
            "to list only one issue's drafts. Drafts on issues you can no longer see are left out."
        ),
        scopes=("issues:read",),
        schema=object_schema({"issue_id": string(ISSUE)}),
        handler=_list_comment_drafts,
    ),
    Tool(
        name="delete_comment_draft",
        description=(
            "Discard your draft on an issue, or on a reply thread with parent_comment_id. A no-op when there is none."
        ),
        scopes=("comments:write",),
        schema=object_schema(
            {"issue_id": string(ISSUE), "parent_comment_id": string(PARENT)},
            required=("issue_id",),
        ),
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
)
