"""The MCP tool for setting the caller's own away status.

It writes exactly what `PUT` and `DELETE /api/workspaces/{workspace_id}/members/me/status`
do, through the same service call, under the `members:write` scope the routes
carry. The status is read back through `list_users` and `list_workspace_members`.
"""

from __future__ import annotations

from typing import Any

from app.common import member_status
from app.common.api.dependencies.authz import Capability, check_capability
from app.common.api.schemas.member_status import STATUS_EMOJI_MAX, STATUS_TEXT_MAX, UserStatusUpdate, current_status
from app.domains.integrations.mcp.toolkit import Tool, ToolCall, nullable, object_schema


def _set_my_status(call: ToolCall) -> Any:
    """Set or clear the caller's status in this workspace, answering the status now in force."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_READ)
    if call.optional("clear"):
        membership = member_status.clear_my_status(call.repositories, call.context)
    else:
        payload = UserStatusUpdate.model_validate(
            {
                "emoji": call.optional("emoji") or "",
                "text": call.optional("text") or "",
                "away": bool(call.optional("away", False)),
                "until": call.optional("until"),
            }
        )
        membership = member_status.set_my_status(call.repositories, call.context, payload)
    current = current_status(membership.user_status)
    return {
        "user_id": membership.user_id,
        "user_status": current.model_dump(mode="json") if current is not None else None,
    }


MEMBER_STATUS_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="set_my_status",
        description=(
            "Set the caller's own status in this workspace: an emoji, a short text, whether they are away, and "
            "when it clears itself. Presets people use are On vacation and Out sick (away), Focusing and In "
            "meetings. A new status replaces the old one. Pass clear to remove it. It shows on every member "
            "list and picker, and an away assignee shows an away note, but it pauses no notifications."
        ),
        scopes=("members:write",),
        schema=object_schema(
            {
                "emoji": {
                    "type": "string",
                    "maxLength": STATUS_EMOJI_MAX,
                    "description": "One emoji, such as 🌴",
                },
                "text": {
                    "type": "string",
                    "maxLength": STATUS_TEXT_MAX,
                    "description": "Short text, such as On vacation",
                },
                "away": {"type": "boolean", "description": "Whether the caller is away, false by default"},
                "until": nullable("When it clears itself, as an ISO 8601 timestamp in the future; null to keep it"),
                "clear": {"type": "boolean", "description": "True to remove the status, ignoring the other fields"},
            }
        ),
        handler=_set_my_status,
        idempotent=True,
    ),
)
