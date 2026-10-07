"""The MCP tools for a team's async standup digest.

`get_standup` answers exactly what `GET .../teams/{team_id}/standup` does, through
the same service call, so an agent, the CLI and the page read one digest. Writing
the caller's own note needs only team read, as the route does, under a
`comments:write` credential since a note is a short written update; changing the
team's schedule needs team admin and `teams:write`.
"""

from __future__ import annotations

from typing import Any

from app.common.api.dependencies.authz import Capability, check_capability
from app.common.db.dynamo.teams import Team
from app.common.standup import StandupWindowError
from app.domains.integrations import standup_service
from app.domains.integrations.mcp.toolkit import Tool, ToolCall, enum, nullable, object_schema, string, team_ref
from app.domains.integrations.mcp.transport import ToolError
from app.domains.integrations.schemas.standup import MAX_NOTE_LENGTH, StandupNoteWrite, StandupSettingsUpdate

TEAM_ARGUMENT = "Team: id, key such as ENG, or name"

DATE_ARGUMENT = "Digest date as YYYY-MM-DD in the team's timezone"


def _team(call: ToolCall, capability: Capability) -> Team:
    """The team named in `team_id`, held to the capability its route needs."""
    team = team_ref(call, call.require("team_id"))
    check_capability(call.repositories, call.context, capability, team.team_id)
    return team


def _get_standup(call: ToolCall) -> Any:
    """One team's standup digest for a date, grouped by person."""
    team = _team(call, Capability.TEAM_READ)
    cadence = call.optional("cadence")
    if cadence not in (None, "daily", "weekly"):
        raise ToolError("cadence must be daily or weekly")
    try:
        digest = standup_service.digest(
            call.repositories, call.context.workspace_id, team.team_id, call.optional("date"), cadence
        )
    except StandupWindowError as exc:
        raise ToolError(str(exc)) from exc
    return digest.model_dump(mode="json")


def _set_standup_note(call: ToolCall) -> Any:
    """Write or clear the caller's note for a digest date, the next digest by default."""
    team = _team(call, Capability.TEAM_READ)
    body = str(call.optional("body", "")).strip()
    workspace_id = call.context.workspace_id
    try:
        if not body:
            standup_service.delete_note(
                call.repositories, workspace_id, team.team_id, call.context.user_id, call.optional("date")
            )
            note = standup_service.read_note(
                call.repositories, workspace_id, team.team_id, call.context.user_id, call.optional("date")
            )
        else:
            payload = StandupNoteWrite.model_validate({"body": body, "date": call.optional("date")})
            note = standup_service.write_note(
                call.repositories, workspace_id, team.team_id, call.context.user_id, payload
            )
    except StandupWindowError as exc:
        raise ToolError(str(exc)) from exc
    return note.model_dump(mode="json")


def _update_standup_settings(call: ToolCall) -> Any:
    """Change when a team's digest is cut."""
    team = _team(call, Capability.TEAM_ADMIN)
    fields = {
        name: call.arguments[name] for name in ("cadence", "send_time", "timezone", "weekday") if name in call.arguments
    }
    payload = StandupSettingsUpdate.model_validate(fields)
    try:
        saved = standup_service.update_settings(call.repositories, call.context.workspace_id, team.team_id, payload)
    except StandupWindowError as exc:
        raise ToolError(str(exc)) from exc
    return saved.model_dump(mode="json")


STANDUP_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="get_standup",
        description=(
            "Get a team's async standup digest for one date: per person, the issues completed, started "
            "and commented on in the window, open issues blocked, overdue or due soon, project updates "
            "posted, and their note. The window ends on the date at the team's send time and starts at "
            "the previous weekday, or seven days earlier for weekly. Defaults to today."
        ),
        scopes=("teams:read",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "date": string(DATE_ARGUMENT),
                "cadence": enum(("daily", "weekly"), "Window shape, the team's own when left out"),
            },
            required=("team_id",),
        ),
        handler=_get_standup,
    ),
    Tool(
        name="set_standup_note",
        description=(
            "Write the caller's note for a team's standup digest, such as what they are on today and "
            "what blocks them. Lands in the next digest unless a date is given. An empty or missing body clears it."
        ),
        scopes=("comments:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "body": {"type": "string", "maxLength": MAX_NOTE_LENGTH, "description": "The note text, empty to clear"},
                "date": nullable(DATE_ARGUMENT),
            },
            required=("team_id",),
        ),
        handler=_set_standup_note,
        idempotent=True,
    ),
    Tool(
        name="update_standup_settings",
        description=(
            "Change a team's standup digest schedule: cadence off, daily on weekdays or weekly, the send "
            "time as HH:MM, an IANA timezone, and the weekday for weekly, Monday as 0. Needs team admin."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "cadence": enum(("off", "daily", "weekly"), "When the digest goes out"),
                "send_time": string("Local send time as HH:MM"),
                "timezone": string("IANA timezone such as America/New_York"),
                "weekday": {"type": "integer", "minimum": 0, "maximum": 6, "description": "Weekly send day"},
            },
            required=("team_id",),
        ),
        handler=_update_standup_settings,
        idempotent=True,
    ),
)
