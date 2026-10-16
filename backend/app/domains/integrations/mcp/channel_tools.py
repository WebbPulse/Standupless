"""The MCP tools for team and workspace Slack and Discord channel notifications.

They do what the `channels` routes do, through the same management calls, reading
with a `teams:read` credential and changing with `teams:write`. Naming a team acts
on that team's channels and needs team admin; leaving `team_id` out acts on the
workspace's own channels, which follow every open team or the teams named in
`team_ids`, and needs workspace admin. A webhook URL goes in on add and on an edit
that replaces it, and no tool ever returns one, only its masked tail.
"""

from __future__ import annotations

from typing import Any

from app.common.api.dependencies.authz import Capability, check_capability
from app.common.db.dynamo.channels import CHANNEL_EVENTS
from app.common.db.dynamo.teams import Team
from app.domains.integrations.channels import manage
from app.domains.integrations.mcp.toolkit import Tool, ToolCall, object_schema, string, string_list, team_ref
from app.domains.integrations.mcp.transport import ToolError
from app.domains.integrations.schemas.channels import (
    ChannelCreate,
    ChannelUpdate,
    WorkspaceChannelCreate,
    WorkspaceChannelUpdate,
)

TEAM_ARGUMENT = "Team: id, key such as ENG, or name. Leave out for the workspace's own channels."

TEAMS_ARGUMENT = (
    "Workspace channels only: the teams it follows, by id, key or name. Empty or left out follows every open team."
)

TARGET_FIELDS = ("url", "slack_channel_id", "slack_channel_name", "discord_channel_id", "discord_channel_name")

EVENTS_SCHEMA: dict[str, Any] = {
    "type": "array",
    "minItems": 1,
    "items": {"type": "string", "enum": list(CHANNEL_EVENTS)},
    "description": "The events the channel gets",
}


def _team(call: ToolCall) -> Team | None:
    """The team named in `team_id` held to team admin, or `None` for the workspace held to workspace admin."""
    if not call.arguments.get("team_id"):
        check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
        return None
    team = team_ref(call, call.require("team_id"))
    check_capability(call.repositories, call.context, Capability.TEAM_ADMIN, team.team_id)
    return team


def _team_id(team: Team | None) -> str | None:
    """The scope a management call takes: the team id, or `None` for the workspace."""
    return team.team_id if team is not None else None


def _followed(call: ToolCall, team: Team | None) -> list[str] | None:
    """The team ids named in `team_ids`, refused on a team channel, or `None` when the argument is absent."""
    if "team_ids" not in call.arguments:
        return None
    if team is not None:
        raise ToolError("team_ids only applies to a workspace channel; leave team_id out")
    return [team_ref(call, value).team_id for value in call.arguments.get("team_ids") or []]


def _run(action: Any) -> Any:
    """Run one management call, turning its errors into tool errors."""
    try:
        return action()
    except manage.ChannelError as exc:
        raise ToolError(exc.message) from exc
    except manage.ChannelUnavailable as exc:
        raise ToolError(str(exc)) from exc
    except manage.ChannelNotFound as exc:
        raise ToolError("No channel by that id here") from exc


def _list_channels(call: ToolCall) -> Any:
    """A team's channel destinations, or the workspace's own."""
    team = _team(call)
    workspace_id = call.context.workspace_id
    if team is None:
        rows = manage.list_for_workspace(call.repositories, workspace_id)
        return {"scope": "workspace", "channels": [row.model_dump(mode="json") for row in rows]}
    rows = manage.list_for_team(call.repositories, workspace_id, team.team_id)
    return {"team_id": team.team_id, "channels": [row.model_dump(mode="json") for row in rows]}


def _create_channel(call: ToolCall) -> Any:
    """Add a channel to a team, or to the workspace."""
    team = _team(call)
    body: dict[str, Any] = {
        name: call.arguments[name] for name in TARGET_FIELDS if call.arguments.get(name) not in (None, "")
    }
    body.update(
        label=call.arguments.get("label") or "",
        events=call.arguments.get("events") or [],
        enabled=call.arguments.get("enabled", True),
    )
    followed = _followed(call, team)
    if team is None:
        payload: ChannelCreate = WorkspaceChannelCreate.model_validate({**body, "team_ids": followed or []})
    else:
        payload = ChannelCreate.model_validate(body)
    row = _run(lambda: manage.create(call.repositories, call.context, _team_id(team), payload))
    return row.model_dump(mode="json")


def _update_channel(call: ToolCall) -> Any:
    """Change a channel's URL, label, events, followed teams or whether it is on."""
    team = _team(call)
    changes = {name: call.arguments[name] for name in ("url", "label", "events", "enabled") if name in call.arguments}
    followed = _followed(call, team)
    if team is None:
        if "url" in changes:
            raise ToolError("A workspace channel posts through the Slack or Discord App and has no webhook URL")
        payload: ChannelUpdate | WorkspaceChannelUpdate = WorkspaceChannelUpdate.model_validate(
            {**changes, **({"team_ids": followed} if followed is not None else {})}
        )
    else:
        payload = ChannelUpdate.model_validate(changes)
    channel_id = str(call.require("channel_id"))
    row = _run(lambda: manage.update(call.repositories, call.context, _team_id(team), channel_id, payload))
    return row.model_dump(mode="json")


def _delete_channel(call: ToolCall) -> Any:
    """Remove a channel from a team or the workspace."""
    team = _team(call)
    channel_id = str(call.require("channel_id"))
    _run(lambda: manage.delete(call.repositories, call.context, _team_id(team), channel_id))
    return {"deleted": channel_id}


def _test_channel(call: ToolCall) -> Any:
    """Post a test message to a channel now."""
    team = _team(call)
    channel_id = str(call.require("channel_id"))
    result = _run(
        lambda: manage.send_test_message(
            call.repositories, call.context.workspace_id, _team_id(team), channel_id, call.context.user_id
        )
    )
    return result.model_dump(mode="json")


_CHANNEL_ID = string("Channel id, from list_channels")

CHANNEL_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_channels",
        description=(
            "List the Slack and Discord channels a team posts notifications to, with each one's events, "
            "masked URL and last status. Leave team_id out for the workspace's own channels, which need "
            "workspace admin. Needs team admin."
        ),
        scopes=("teams:read",),
        schema=object_schema({"team_id": string(TEAM_ARGUMENT)}),
        handler=_list_channels,
    ),
    Tool(
        name="create_channel",
        description=(
            "Post a team's notifications to a Slack incoming webhook (hooks.slack.com/services/...), a "
            "Discord webhook (discord.com/api/webhooks/...), or a channel of the installed Slack or Discord "
            "App, for the chosen events. Give exactly one of url, slack_channel_id and discord_channel_id. "
            "Leave team_id out to add a workspace channel, which posts through an App, follows every open "
            "team or the teams in team_ids, and needs workspace admin. Needs team admin."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "url": string("An incoming webhook URL, team channels only"),
                "slack_channel_id": string("A Slack channel id the installed Slack App posts to, such as C0123"),
                "slack_channel_name": string("The Slack channel's name, shown in the list"),
                "discord_channel_id": string("A Discord channel id the installed Discord App posts to"),
                "discord_channel_name": string("The Discord channel's name, shown in the list"),
                "team_ids": string_list(TEAMS_ARGUMENT),
                "label": string("A name for the channel, such as #eng"),
                "events": EVENTS_SCHEMA,
                "enabled": {"type": "boolean", "description": "Whether it posts, true by default"},
            },
            required=("events",),
        ),
        handler=_create_channel,
    ),
    Tool(
        name="update_channel",
        description=(
            "Change a channel's URL, label, events, followed teams or whether it is on. Turning a channel "
            "that was switched off for a removed webhook back on clears the notice. Leave team_id out for a "
            "workspace channel, which needs workspace admin. Needs team admin."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "channel_id": _CHANNEL_ID,
                "url": string("A replacement incoming webhook URL, team webhook channels only"),
                "team_ids": string_list(TEAMS_ARGUMENT),
                "label": string("A name for the channel"),
                "events": EVENTS_SCHEMA,
                "enabled": {"type": "boolean", "description": "Whether it posts"},
            },
            required=("channel_id",),
        ),
        handler=_update_channel,
        idempotent=True,
    ),
    Tool(
        name="delete_channel",
        description=(
            "Stop posting notifications to a channel and forget its URL. Leave team_id out for a workspace "
            "channel, which needs workspace admin. Needs team admin."
        ),
        scopes=("teams:write",),
        schema=object_schema({"team_id": string(TEAM_ARGUMENT), "channel_id": _CHANNEL_ID}, required=("channel_id",)),
        handler=_delete_channel,
        destructive=True,
    ),
    Tool(
        name="test_channel",
        description=(
            "Post a test message to a channel now and report the status it answered. Leave team_id out for a "
            "workspace channel, which needs workspace admin. Needs team admin."
        ),
        scopes=("teams:write",),
        schema=object_schema({"team_id": string(TEAM_ARGUMENT), "channel_id": _CHANNEL_ID}, required=("channel_id",)),
        handler=_test_channel,
    ),
)
