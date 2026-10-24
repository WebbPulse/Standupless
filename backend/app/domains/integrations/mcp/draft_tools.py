"""The MCP tools for comment drafts, so an agent can stage a comment for a person to post.

Every tool runs the drafts routes' own `app.common.comment_drafts` path, which
keys each draft by the credential's own user, so no argument can reach another
member's drafts. A draft saved here is restored in that member's composer the
next time they open the issue or the reply thread, ready to edit and post, and
saving one never notifies anyone.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status

from app.common.api.dependencies.authz import Capability, check_capability
from app.common.api.schemas.drafts import DraftRead, DraftWrite
from app.common.comment_drafts import delete_draft, get_draft, list_drafts, save_draft
from app.domains.integrations.mcp.toolkit import Tool, ToolCall, issue_ref, object_schema, string
from app.domains.integrations.mcp.transport import ToolError

ISSUE = "The issue's id, or its key such as ABC-123"

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
            "Discard your draft on an issue, or on a reply thread with parent_comment_id. A no-op when there is "
            "none."
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
)
