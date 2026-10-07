"""The MCP tools for a team's Slack and Discord channel notifications.

They do what the `channels` routes do, through the same management calls: every one
needs team admin, reading with a `teams:read` credential and changing with
`teams:write`. A webhook URL goes in on add and on an edit that replaces it, and no
tool ever returns one, only its masked tail.
"""

from __future__ import annotations

from typing import Any

from app.common.api.dependencies.authz import Capability, check_capability
from app.common.db.dynamo.channels import CHANNEL_EVENTS
from app.common.db.dynamo.teams import Team
from app.domains.integrations.channels import manage
from app.domains.integrations.mcp.toolkit import Tool, ToolCall, object_schema, string, team_ref
from app.domains.integrations.mcp.transport import ToolError
from app.domains.integrations.schemas.channels import ChannelCreate, ChannelUpdate

TEAM_ARGUMENT = "Team: id, key such as ENG, or name"

EVENTS_SCHEMA: dict[str, Any] = {
    "type": "array",
    "minItems": 1,
    "items": {"type": "string", "enum": list(CHANNEL_EVENTS)},
    "description": "The events the channel gets",
}


def _team(call: ToolCall) -> Team:
    """The team named in `team_id`, held to team admin."""
    team = team_ref(call, call.require("team_id"))
    check_capability(call.repositories, call.context, Capability.TEAM_ADMIN, team.team_id)
    return team


def _run(action: Any) -> Any:
    """Run one management call, turning its errors into tool errors."""
    try:
        return action()
    except manage.ChannelError as exc:
        raise ToolError(exc.message) from exc
    except manage.ChannelUnavailable as exc:
        raise ToolError(str(exc)) from exc
    except manage.ChannelNotFound as exc:
        raise ToolError("No channel by that id on this team") from exc


def _list_channels(call: ToolCall) -> Any:
    """A team's channel destinations."""
    team = _team(call)
    rows = manage.list_for_team(call.repositories, call.context.workspace_id, team.team_id)
    return {"team_id": team.team_id, "channels": [row.model_dump(mode="json") for row in rows]}


def _create_channel(call: ToolCall) -> Any:
    """Add a channel to a team."""
    team = _team(call)
    payload = ChannelCreate.model_validate(
        {
            "url": call.require("url"),
            "label": call.arguments.get("label") or "",
            "events": call.arguments.get("events") or [],
            "enabled": call.arguments.get("enabled", True),
        }
    )
    workspace_id = call.context.workspace_id
    row = _run(lambda: manage.create(call.repositories, workspace_id, team.team_id, call.context.user_id, payload))
    return row.model_dump(mode="json")


def _update_channel(call: ToolCall) -> Any:
    """Change a channel's URL, label, events or whether it is on."""
    team = _team(call)
    changes = {name: call.arguments[name] for name in ("url", "label", "events", "enabled") if name in call.arguments}
    payload = ChannelUpdate.model_validate(changes)
    workspace_id = call.context.workspace_id
    channel_id = str(call.require("channel_id"))
    row = _run(lambda: manage.update(call.repositories, workspace_id, team.team_id, channel_id, payload))
    return row.model_dump(mode="json")


def _delete_channel(call: ToolCall) -> Any:
    """Remove a channel from a team."""
    team = _team(call)
    channel_id = str(call.require("channel_id"))
    _run(lambda: manage.delete(call.repositories, call.context.workspace_id, team.team_id, channel_id))
    return {"deleted": channel_id}


def _test_channel(call: ToolCall) -> Any:
    """Post a test message to a channel now."""
    team = _team(call)
    channel_id = str(call.require("channel_id"))
    result = _run(
        lambda: manage.send_test_message(
            call.repositories, call.context.workspace_id, team.team_id, channel_id, call.context.user_id
        )
    )
    return result.model_dump(mode="json")


_CHANNEL_ID = string("Channel id, from list_channels")

CHANNEL_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_channels",
        description=(
            "List the Slack and Discord channels a team posts notifications to, with each one's events, "
            "masked URL and last status. Needs team admin."
        ),
        scopes=("teams:read",),
        schema=object_schema({"team_id": string(TEAM_ARGUMENT)}, required=("team_id",)),
        handler=_list_channels,
    ),
    Tool(
        name="create_channel",
        description=(
            "Post a team's notifications to a Slack incoming webhook (hooks.slack.com/services/...) or a "
            "Discord webhook (discord.com/api/webhooks/...), for the chosen events. Needs team admin."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "url": string("The incoming webhook URL"),
                "label": string("A name for the channel, such as #eng"),
                "events": EVENTS_SCHEMA,
                "enabled": {"type": "boolean", "description": "Whether it posts, true by default"},
            },
            required=("team_id", "url", "events"),
        ),
        handler=_create_channel,
    ),
    Tool(
        name="update_channel",
        description=(
            "Change a team channel's URL, label, events or whether it is on. Turning a channel that was "
            "switched off for a removed webhook back on clears the notice. Needs team admin."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "channel_id": _CHANNEL_ID,
                "url": string("A replacement incoming webhook URL"),
                "label": string("A name for the channel"),
                "events": EVENTS_SCHEMA,
                "enabled": {"type": "boolean", "description": "Whether it posts"},
            },
            required=("team_id", "channel_id"),
        ),
        handler=_update_channel,
        idempotent=True,
    ),
    Tool(
        name="delete_channel",
        description="Stop posting a team's notifications to a channel and forget its URL. Needs team admin.",
        scopes=("teams:write",),
        schema=object_schema(
            {"team_id": string(TEAM_ARGUMENT), "channel_id": _CHANNEL_ID}, required=("team_id", "channel_id")
        ),
        handler=_delete_channel,
        destructive=True,
    ),
    Tool(
        name="test_channel",
        description="Post a test message to a team channel now and report the status it answered. Needs team admin.",
        scopes=("teams:write",),
        schema=object_schema(
            {"team_id": string(TEAM_ARGUMENT), "channel_id": _CHANNEL_ID}, required=("team_id", "channel_id")
        ),
        handler=_test_channel,
    ),
)
