"""The MCP tools that edit and delete comments and react to them.

Each runs the same `app.common` path the comment and reaction routes run, so an
agent meets the rule a person meets in the UI: only the author edits a comment,
the author or a team admin deletes one, and a reaction is the caller's own. The
rows written are the ones the UI writes, so the notify consumer, the webhooks and
the activity feed treat an agent's edit or reaction exactly like a person's.

A comment on a document is addressed by `document_id` instead of the issue, and
meets the document's own rule: anyone who may delete the document may delete a
comment on it.
"""

from __future__ import annotations

from typing import Any

from app.common.comment_writes import delete_comment, update_comment
from app.common.discussion_reads import check_emoji
from app.common.document_comments import delete_document_comment, edit_document_comment
from app.common.reaction_writes import add_reaction, remove_reaction
from app.domains.integrations.mcp.issue_tools import ISSUE_REF, _comment_json, _document_target
from app.domains.integrations.mcp.toolkit import Tool, ToolCall, issue_ref, object_schema, string
from app.domains.integrations.mcp.transport import ToolError

EMOJI_HELP = (
    "One emoji, such as 👍, a built-in shortcode such as :tada:, or a custom workspace emoji shortcode such as "
    ":team-logo:"
)

TARGET_PROPERTIES: dict[str, Any] = {
    "issue_id": string(ISSUE_REF),
    "document_id": string("The document the comment is on, instead of an issue"),
}


def _emoji(call: ToolCall) -> str:
    """The `emoji` argument normalised the way the reaction route's schema normalises it."""
    try:
        return check_emoji(str(call.require("emoji")))
    except ValueError as exc:
        raise ToolError(str(exc)) from exc


def _update_comment(call: ToolCall) -> Any:
    """Rewrite one's own comment on an issue or a document through the route's path."""
    comment_id = str(call.require("comment_id"))
    body = str(call.require("body"))
    if _document_target(call):
        updated = edit_document_comment(
            call.repositories, call.context, str(call.require("document_id")), comment_id, body
        )
    else:
        issue = issue_ref(call, call.require("issue_id"))
        updated = update_comment(call.repositories, call.context, issue.issue_id, comment_id, body)
    return _comment_json(updated)


def _delete_comment(call: ToolCall) -> Any:
    """Remove one comment on an issue or a document through the route's path."""
    comment_id = str(call.require("comment_id"))
    if _document_target(call):
        document_id = str(call.require("document_id"))
        delete_document_comment(call.repositories, call.context, document_id, comment_id)
        return {"deleted": True, "comment_id": comment_id, "issue_id": None, "document_id": document_id}
    issue = issue_ref(call, call.require("issue_id"))
    delete_comment(call.repositories, call.context, issue.issue_id, comment_id)
    return {"deleted": True, "comment_id": comment_id, "issue_id": issue.issue_id, "document_id": None}


def _reaction_target(call: ToolCall) -> tuple[str | None, str | None]:
    """The issue id or the document id a comment reaction names, exactly one of them."""
    if _document_target(call):
        return None, str(call.require("document_id"))
    return issue_ref(call, call.require("issue_id")).issue_id, None


def _add_comment_reaction(call: ToolCall) -> Any:
    """React to one comment through the reaction route's path, answering that emoji's group."""
    comment_id = str(call.require("comment_id"))
    emoji = _emoji(call)
    issue_id, document_id = _reaction_target(call)
    group = add_reaction(
        call.repositories,
        call.context,
        comment_id,
        "comment",
        emoji,
        issue_id=issue_id,
        document_id=document_id,
    )
    return {"comment_id": comment_id, **group.model_dump(mode="json")}


def _remove_comment_reaction(call: ToolCall) -> Any:
    """Take back the caller's own reaction on one comment through the reaction route's path."""
    comment_id = str(call.require("comment_id"))
    emoji = _emoji(call)
    issue_id, document_id = _reaction_target(call)
    remove_reaction(
        call.repositories,
        call.context,
        comment_id,
        "comment",
        emoji,
        issue_id=issue_id,
        document_id=document_id,
    )
    return {"removed": True, "comment_id": comment_id, "emoji": emoji}


COMMENT_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="update_comment",
        description=(
            "Rewrite a comment on an issue or a document, in Markdown. Only the comment's author may edit it, "
            "team admins included; the edit stamps edited_at and notifies only people it newly @mentions."
        ),
        scopes=("comments:write",),
        schema=object_schema(
            {
                **TARGET_PROPERTIES,
                "comment_id": string("The comment to rewrite"),
                "body": string("The new comment body, in Markdown; @mentions notify"),
            },
            required=("comment_id", "body"),
        ),
        handler=_update_comment,
        idempotent=True,
    ),
    Tool(
        name="delete_comment",
        description=(
            "Delete a comment on an issue or a document. The author or an admin of the issue's team may delete "
            "one; on a document, the author or anyone who may delete the document. Replies stay, moved up to "
            "the top level, and the comment's reactions go with it."
        ),
        scopes=("comments:write",),
        schema=object_schema(
            {**TARGET_PROPERTIES, "comment_id": string("The comment to delete")},
            required=("comment_id",),
        ),
        handler=_delete_comment,
        destructive=True,
    ),
    Tool(
        name="add_comment_reaction",
        description=(
            "Add the caller's emoji reaction to a comment on an issue or a document. Any member of the issue's "
            "team, or anyone who may comment on the document, may react. Answers that emoji's count and who "
            "reacted. Idempotent."
        ),
        scopes=("comments:write",),
        schema=object_schema(
            {
                **TARGET_PROPERTIES,
                "comment_id": string("The comment to react to"),
                "emoji": string(EMOJI_HELP),
            },
            required=("comment_id", "emoji"),
        ),
        handler=_add_comment_reaction,
        idempotent=True,
    ),
    Tool(
        name="remove_comment_reaction",
        description=(
            "Take back the caller's own emoji reaction on a comment. Nobody may remove another person's "
            "reaction. Idempotent: removing a reaction that is not there succeeds."
        ),
        scopes=("comments:write",),
        schema=object_schema(
            {
                **TARGET_PROPERTIES,
                "comment_id": string("The comment the reaction is on"),
                "emoji": string(EMOJI_HELP),
            },
            required=("comment_id", "emoji"),
        ),
        handler=_remove_comment_reaction,
        idempotent=True,
    ),
)
