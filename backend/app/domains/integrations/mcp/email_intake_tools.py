"""The MCP tools for a team's create by email addresses.

They answer and write what the `email-intake` routes do, through the same service
calls and capability checks: reading needs team read and `teams:read`, changing
needs team admin and `teams:write`. Mail to an address files issues as whoever
turned it on, so an agent that turns one on is the one its issues are filed as.
"""

from __future__ import annotations

from typing import Any, Optional

from app.common.api.dependencies.authz import Capability, check_capability
from app.common.db.dynamo.teams import Team
from app.domains.integrations.email_intake import (
    disable_intake,
    enable_intake,
    read_team_intake,
    regenerate_intake,
)
from app.domains.integrations.mcp.toolkit import Tool, ToolCall, object_schema, string, team_ref
from app.domains.integrations.mcp.transport import ToolError
from app.domains.integrations.service import require_team_content

TEAM_ARGUMENT = "Team: id, key such as ENG, or name"


def _team(call: ToolCall, capability: Capability) -> Team:
    """The team named in `team_id`, held to the capability its route needs and to its content."""
    team = team_ref(call, call.require("team_id"))
    check_capability(call.repositories, call.context, capability, team.team_id)
    require_team_content(call.context, team.team_id)
    return team


def _flag(call: ToolCall, name: str) -> Optional[bool]:
    """A boolean argument, or `None` when it was not given."""
    if not call.present(name):
        return None
    value = call.arguments[name]
    if not isinstance(value, bool):
        raise ToolError(f"{name} must be true or false")
    return value


def _addresses(call: ToolCall, team: Team) -> Any:
    """The team's live addresses as the read route answers them."""
    return read_team_intake(call.repositories, call.context.workspace_id, team).model_dump(mode="json")


def _get_team_email_intake(call: ToolCall) -> Any:
    """A team's live create by email addresses, its own and its templates'."""
    return _addresses(call, _team(call, Capability.TEAM_READ))


def _update_team_email_intake(call: ToolCall) -> Any:
    """Turn one address on or off, or regenerate it, and answer the team's addresses."""
    team = _team(call, Capability.TEAM_ADMIN)
    template_id = str(call.arguments.get("template_id") or "").strip() or None
    enabled = _flag(call, "enabled")
    regenerate = _flag(call, "regenerate")
    if enabled is None and not regenerate:
        raise ToolError("Give enabled, regenerate or both")
    if enabled is False:
        if regenerate:
            raise ToolError("An address cannot be turned off and regenerated at once")
        if call.repositories.github.email_intake.get(call.context.workspace_id, team.team_id, template_id):
            disable_intake(call.repositories, call.context, team, template_id)
        return _addresses(call, team)
    if enabled:
        enable_intake(call.repositories, call.context, team, template_id)
    if regenerate:
        regenerate_intake(call.repositories, call.context, team, template_id)
    return _addresses(call, team)


EMAIL_INTAKE_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="get_team_email_intake",
        description=(
            "Read a team's create by email addresses: its own, and one per issue template that has one. Mail "
            "sent to an address files an issue in the team, in Triage when triage is on. available is false "
            "where this deployment takes no mail."
        ),
        scopes=("teams:read",),
        schema=object_schema({"team_id": string(TEAM_ARGUMENT)}, required=("team_id",)),
        handler=_get_team_email_intake,
    ),
    Tool(
        name="update_team_email_intake",
        description=(
            "Turn a team's create by email address on or off, or regenerate it, which revokes the old address "
            "at once. Give template_id for that template's own address instead of the team's. Issues mail "
            "files are created as the person who turned the address on. Needs team admin."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "template_id": string("An issue template id, for that template's address; the team's when absent"),
                "enabled": {"type": "boolean", "description": "True turns the address on, false turns it off"},
                "regenerate": {
                    "type": "boolean",
                    "description": "True gives the address a fresh token, so mail to the old one is dropped",
                },
            },
            required=("team_id",),
        ),
        handler=_update_team_email_intake,
    ),
)
