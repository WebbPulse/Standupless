"""The MCP tools for a team's GitHub transition rules.

They answer and write what the `github-transitions` routes do, through the same
service calls and the same capability checks: reading needs team read and a
`teams:read` credential, and replacing the set needs team admin and `teams:write`.
A status may be named by id or by name, since an agent holds whichever a person
wrote, and a rule set is replaced whole so a preset lands in one call.
"""

from __future__ import annotations

from typing import Any, Mapping

from app.common.api.dependencies.authz import Capability, check_capability
from app.common.db.dynamo.team_config import TRIGGERS
from app.common.db.dynamo.teams import Team
from app.domains.integrations.mcp.toolkit import Tool, ToolCall, object_schema, string, team_ref
from app.domains.integrations.mcp.transport import ToolError
from app.domains.integrations.schemas.integrations import TransitionCreate, TransitionRead
from app.domains.integrations.service import effective_transitions, replace_team_transitions

TEAM_ARGUMENT = "Team: id, key such as ENG, or name"

MAX_RULES = 50


def _team(call: ToolCall, capability: Capability) -> Team:
    """The team named in `team_id`, held to the capability its route needs."""
    team = team_ref(call, call.require("team_id"))
    check_capability(call.repositories, call.context, capability, team.team_id)
    return team


def _rules_json(call: ToolCall, team_id: str, rules: list[TransitionRead]) -> dict[str, Any]:
    """A team's effective rules with each status's name beside its id."""
    statuses = call.repositories.team_config.list_statuses(call.context.workspace_id, team_id)
    names = {row.status_id: row.name for row in statuses}
    return {
        "team_id": team_id,
        "uses_defaults": any(rule.is_default for rule in rules),
        "rules": [
            {
                "trigger": rule.trigger,
                "branch": rule.branch_pattern,
                "status_id": rule.status_id,
                "status": names.get(rule.status_id) if rule.status_id else None,
            }
            for rule in rules
        ],
    }


def _status_id(call: ToolCall, statuses: list[Any], value: Any) -> str | None:
    """A status id from its id or its name, `None` for a rule that moves nothing."""
    if value is None:
        return None
    reference = str(value).strip()
    if not reference:
        return None
    if any(row.status_id == reference for row in statuses):
        return reference
    folded = reference.casefold()
    named = [row for row in statuses if row.name.casefold() == folded]
    if len(named) != 1:
        raise ToolError(f"No single status of this team is named {reference}")
    return named[0].status_id


def _list_github_transitions(call: ToolCall) -> Any:
    """What a team does to an issue on each pull request event, and into which branch."""
    team = _team(call, Capability.TEAM_READ)
    workspace_id = call.context.workspace_id
    stored = call.repositories.team_config.list_transitions(workspace_id, team.team_id)
    statuses = call.repositories.team_config.list_statuses(workspace_id, team.team_id)
    return _rules_json(call, team.team_id, effective_transitions(team.team_id, stored, statuses))


def _set_github_transitions(call: ToolCall) -> Any:
    """Replace a team's whole rule set; an empty list restores the defaults."""
    team = _team(call, Capability.TEAM_ADMIN)
    raw = call.arguments.get("rules")
    if not isinstance(raw, list):
        raise ToolError("rules must be a list")
    if len(raw) > MAX_RULES:
        raise ToolError(f"rules takes at most {MAX_RULES} rules")
    workspace_id = call.context.workspace_id
    statuses = call.repositories.team_config.list_statuses(workspace_id, team.team_id)
    rules: list[TransitionCreate] = []
    for entry in raw:
        if not isinstance(entry, Mapping):
            raise ToolError("each rule must be an object")
        rules.append(
            TransitionCreate.model_validate(
                {
                    "trigger": entry.get("trigger"),
                    "branch_pattern": entry.get("branch"),
                    "status_id": _status_id(call, statuses, entry.get("status")),
                }
            )
        )
    saved = replace_team_transitions(call.repositories, workspace_id, team.team_id, rules)
    return _rules_json(call, team.team_id, saved)


TRANSITION_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_github_transitions",
        description=(
            "List what a team does to a linked issue on each pull request event. A rule with a branch "
            "holds only for pull requests into a matching branch; uses_defaults means none are stored."
        ),
        scopes=("teams:read",),
        schema=object_schema({"team_id": string(TEAM_ARGUMENT)}, required=("team_id",)),
        handler=_list_github_transitions,
    ),
    Tool(
        name="set_github_transitions",
        description=(
            "Replace a team's GitHub transition rules. Each rule has a trigger, an optional branch glob "
            "such as main or release/*, and a status by id or name, null to move nothing. A branch rule "
            "beats one without a branch for the same trigger. An empty list restores the defaults. "
            "Needs team admin."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "rules": {
                    "type": "array",
                    "maxItems": MAX_RULES,
                    "description": "The whole new rule set",
                    "items": {
                        "type": "object",
                        "properties": {
                            "trigger": {"type": "string", "enum": list(TRIGGERS), "description": "The event"},
                            "branch": {
                                "type": ["string", "null"],
                                "description": "Target branch glob, or null for any branch",
                            },
                            "status": {
                                "type": ["string", "null"],
                                "description": "Status id or name, or null to move nothing",
                            },
                        },
                        "required": ["trigger"],
                        "additionalProperties": False,
                    },
                },
            },
            required=("team_id", "rules"),
        ),
        handler=_set_github_transitions,
        idempotent=True,
    ),
)
