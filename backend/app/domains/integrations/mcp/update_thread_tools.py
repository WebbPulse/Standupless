"""The MCP tools for replies and reactions on project and initiative updates.

Each runs the same `app.common` path the planning routes run, so an agent may
reply and react wherever the signed-in person may read the project or
initiative, and a reply it posts notifies the same people as one posted in the
app. A call names exactly one of `project_id` and `initiative_id`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from app.common import initiative_update_threads, project_update_threads
from app.common.api.schemas.update_threads import ProjectUpdateCommentCreate, ProjectUpdateReactionWrite
from app.domains.integrations.mcp.toolkit import (
    Tool,
    ToolCall,
    initiative_id_ref,
    object_schema,
    project_id_ref,
    string,
)
from app.domains.integrations.mcp.transport import ToolError

PROJECT_HELP = "The project: id, short id or name. Give this or initiative_id"

INITIATIVE_HELP = "The initiative: id or name. Give this or project_id"

UPDATE_HELP = "The project or initiative update"


@dataclass(frozen=True)
class _Subject:
    """The resolved parent of an update and the thread functions that serve it."""

    parent_id: str
    list_comments: Callable[..., Any]
    create_comment: Callable[..., Any]
    add_reaction: Callable[..., Any]
    remove_reaction: Callable[..., Any]


def _subject(call: ToolCall) -> _Subject:
    """The project or initiative a call names, refusing a call that names both or neither."""
    project = call.optional("project_id")
    initiative = call.optional("initiative_id")
    if bool(project) == bool(initiative):
        raise ToolError("Give exactly one of project_id and initiative_id")
    if initiative:
        return _Subject(
            parent_id=initiative_id_ref(call, initiative),
            list_comments=initiative_update_threads.list_initiative_update_comments,
            create_comment=initiative_update_threads.create_initiative_update_comment,
            add_reaction=initiative_update_threads.add_initiative_update_reaction,
            remove_reaction=initiative_update_threads.remove_initiative_update_reaction,
        )
    return _Subject(
        parent_id=project_id_ref(call, project),
        list_comments=project_update_threads.list_update_comments,
        create_comment=project_update_threads.create_update_comment,
        add_reaction=project_update_threads.add_update_reaction,
        remove_reaction=project_update_threads.remove_update_reaction,
    )


def _list_project_update_comments(call: ToolCall) -> Any:
    """Every reply on one update of a visible project or initiative, oldest first."""
    subject = _subject(call)
    rows = subject.list_comments(call.repositories, call.context, subject.parent_id, str(call.require("update_id")))
    return {"comments": [row.model_dump(mode="json") for row in rows]}


def _add_project_update_comment(call: ToolCall) -> Any:
    """Reply on one update of a visible project or initiative."""
    subject = _subject(call)
    created = subject.create_comment(
        call.repositories,
        call.context,
        subject.parent_id,
        str(call.require("update_id")),
        ProjectUpdateCommentCreate.model_validate({"body": call.require("body")}),
    )
    return created.model_dump(mode="json")


def _react_to_project_update(call: ToolCall) -> Any:
    """Add or take back the caller's emoji reaction on an update or one of its replies.

    The emoji is validated on both paths, so a shortcode is stored and removed in
    the same form, and a custom one must exist in the workspace to be added.
    """
    subject = _subject(call)
    update_id = str(call.require("update_id"))
    comment_id = call.optional("comment_id")
    payload = ProjectUpdateReactionWrite.model_validate({"emoji": call.require("emoji"), "comment_id": comment_id})
    if call.optional("remove", False):
        subject.remove_reaction(
            call.repositories, call.context, subject.parent_id, update_id, payload.emoji, comment_id
        )
        return {"removed": True, "update_id": update_id, "comment_id": comment_id}
    group = subject.add_reaction(call.repositories, call.context, subject.parent_id, update_id, payload)
    return group.model_dump(mode="json")


UPDATE_THREAD_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_project_update_comments",
        description=(
            "Every reply on one project or initiative update, oldest first, each with its author and reactions. "
            "Give project_id for a project update or initiative_id for an initiative update."
        ),
        scopes=("projects:read",),
        schema=object_schema(
            {
                "project_id": string(PROJECT_HELP),
                "initiative_id": string(INITIATIVE_HELP),
                "update_id": string(UPDATE_HELP),
            },
            required=("update_id",),
        ),
        handler=_list_project_update_comments,
    ),
    Tool(
        name="add_project_update_comment",
        description=(
            "Reply on a project or initiative update, in Markdown. Anyone who can read the project or "
            "initiative may reply. The reply notifies the update's author, earlier repliers and anyone it "
            "@mentions, and on an initiative update its owner too."
        ),
        scopes=("comments:write",),
        schema=object_schema(
            {
                "project_id": string(PROJECT_HELP),
                "initiative_id": string(INITIATIVE_HELP),
                "update_id": string(UPDATE_HELP),
                "body": string("The reply, in Markdown"),
            },
            required=("update_id", "body"),
        ),
        handler=_add_project_update_comment,
    ),
    Tool(
        name="react_to_project_update",
        description=(
            "Add an emoji reaction to a project or initiative update, or to one of its replies when comment_id "
            "is given. Pass remove true to take the caller's reaction back."
        ),
        scopes=("comments:write",),
        schema=object_schema(
            {
                "project_id": string(PROJECT_HELP),
                "initiative_id": string(INITIATIVE_HELP),
                "update_id": string(UPDATE_HELP),
                "emoji": string(
                    "One emoji, such as 👍, a built-in shortcode such as :tada:, "
                    "or a custom workspace emoji shortcode such as :team-logo:"
                ),
                "comment_id": string("A reply on the update to react to instead of the update itself"),
                "remove": {"type": "boolean", "description": "Take the reaction back rather than add it"},
            },
            required=("update_id", "emoji"),
        ),
        handler=_react_to_project_update,
    ),
)
