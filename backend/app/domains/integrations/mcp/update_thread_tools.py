"""The MCP tools for replies and reactions on project updates.

Each runs the same `app.common` path the planning routes run, so an agent may
reply and react wherever the signed-in person may read the project, and a reply
it posts notifies the update's author and anyone it mentions exactly as one
posted in the app.
"""

from __future__ import annotations

from typing import Any

from app.common.api.schemas.update_threads import ProjectUpdateCommentCreate, ProjectUpdateReactionWrite
from app.common.project_update_threads import (
    add_update_reaction,
    create_update_comment,
    list_update_comments,
    remove_update_reaction,
)
from app.domains.integrations.mcp.toolkit import Tool, ToolCall, object_schema, project_id_ref, string

PROJECT_HELP = "The project: id, short id or name"

UPDATE_HELP = "The project update"


def _list_project_update_comments(call: ToolCall) -> Any:
    """Every reply on one update of a visible project, oldest first."""
    rows = list_update_comments(
        call.repositories,
        call.context,
        project_id_ref(call, call.require("project_id")),
        str(call.require("update_id")),
    )
    return {"comments": [row.model_dump(mode="json") for row in rows]}


def _add_project_update_comment(call: ToolCall) -> Any:
    """Reply on one update of a visible project."""
    created = create_update_comment(
        call.repositories,
        call.context,
        project_id_ref(call, call.require("project_id")),
        str(call.require("update_id")),
        ProjectUpdateCommentCreate.model_validate({"body": call.require("body")}),
    )
    return created.model_dump(mode="json")


def _react_to_project_update(call: ToolCall) -> Any:
    """Add or take back the caller's emoji reaction on an update or one of its replies.

    The emoji is validated on both paths, so a shortcode is stored and removed in
    the same form, and a custom one must exist in the workspace to be added.
    """
    project_id = project_id_ref(call, call.require("project_id"))
    update_id = str(call.require("update_id"))
    comment_id = call.optional("comment_id")
    payload = ProjectUpdateReactionWrite.model_validate({"emoji": call.require("emoji"), "comment_id": comment_id})
    if call.optional("remove", False):
        remove_update_reaction(call.repositories, call.context, project_id, update_id, payload.emoji, comment_id)
        return {"removed": True, "update_id": update_id, "comment_id": comment_id}
    group = add_update_reaction(call.repositories, call.context, project_id, update_id, payload)
    return group.model_dump(mode="json")


UPDATE_THREAD_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_project_update_comments",
        description="Every reply on one project update, oldest first, each with its author and reactions.",
        scopes=("projects:read",),
        schema=object_schema(
            {"project_id": string(PROJECT_HELP), "update_id": string(UPDATE_HELP)},
            required=("project_id", "update_id"),
        ),
        handler=_list_project_update_comments,
    ),
    Tool(
        name="add_project_update_comment",
        description=(
            "Reply on a project update, in Markdown. Anyone who can read the project may reply. "
            "The reply notifies the update's author, earlier repliers and anyone it @mentions."
        ),
        scopes=("comments:write",),
        schema=object_schema(
            {
                "project_id": string(PROJECT_HELP),
                "update_id": string(UPDATE_HELP),
                "body": string("The reply, in Markdown"),
            },
            required=("project_id", "update_id", "body"),
        ),
        handler=_add_project_update_comment,
    ),
    Tool(
        name="react_to_project_update",
        description=(
            "Add an emoji reaction to a project update, or to one of its replies when comment_id is given. "
            "Pass remove true to take the caller's reaction back."
        ),
        scopes=("comments:write",),
        schema=object_schema(
            {
                "project_id": string(PROJECT_HELP),
                "update_id": string(UPDATE_HELP),
                "emoji": string(
                    "One emoji, such as 👍, a built-in shortcode such as :tada:, "
                    "or a custom workspace emoji shortcode such as :team-logo:"
                ),
                "comment_id": string("A reply on the update to react to instead of the update itself"),
                "remove": {"type": "boolean", "description": "Take the reaction back rather than add it"},
            },
            required=("project_id", "update_id", "emoji"),
        ),
        handler=_react_to_project_update,
    ),
)
