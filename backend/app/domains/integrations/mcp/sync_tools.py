"""The MCP tools for a team's GitHub issue sync link.

They answer and write what the `github-sync` routes do, through the same shared
calls and capability checks: reading needs team read and `teams:read`, changing
needs team admin and `teams:write`. A change keeps every setting it does not name,
so an agent can flip one switch without restating the link, and a public
repository syncs both ways only when `allow_public_two_way` is on.
"""

from __future__ import annotations

from typing import Any

from app.common.api.dependencies.authz import Capability, check_capability
from app.common.db.dynamo.github import SYNC_DIRECTIONS
from app.common.db.dynamo.teams import Team
from app.domains.integrations.mcp.toolkit import (
    Tool,
    ToolCall,
    enum,
    object_schema,
    string,
    team_ref,
)
from app.domains.integrations.mcp.transport import ToolError
from app.domains.integrations.schemas.integrations import TeamSyncRead, TeamSyncWrite
from app.domains.integrations.team_sync import read_team_sync, save_team_sync

TEAM_ARGUMENT = "Team: id, key such as ENG, or name"

SETTINGS = ("direction", "enabled", "sync_labels", "allow_public_two_way")


def _team(call: ToolCall, capability: Capability) -> Team:
    """The team named in `team_id`, held to the capability its route needs."""
    team = team_ref(call, call.require("team_id"))
    check_capability(call.repositories, call.context, capability, team.team_id)
    return team


def _sync_json(team: Team, read: TeamSyncRead | None) -> dict[str, Any]:
    """A team's sync link, or `linked: false` when it has none."""
    if read is None:
        return {"team_id": team.team_id, "linked": False}
    return {"linked": True, **read.model_dump(mode="json")}


def _repository_id(call: ToolCall, value: Any) -> str:
    """A repository id from its numeric id or its owner/name, among the installation's repositories."""
    reference = str(value).strip()
    rows = call.repositories.github.list_repositories(call.context.workspace_id)
    if any(row.repository_id == reference for row in rows):
        return reference
    folded = reference.casefold()
    named = [row for row in rows if row.full_name.casefold() == folded]
    if len(named) != 1:
        raise ToolError(f"The GitHub App cannot see a repository named {reference}")
    return named[0].repository_id


def _get_team_github_sync(call: ToolCall) -> Any:
    """Which repository a team's issues sync with, which way, and the public repository setting."""
    team = _team(call, Capability.TEAM_READ)
    return _sync_json(team, read_team_sync(call.repositories, call.context.workspace_id, team.team_id))


def _update_team_github_sync(call: ToolCall) -> Any:
    """Link a team to a repository or change its sync, keeping every setting not named."""
    team = _team(call, Capability.TEAM_ADMIN)
    workspace_id = call.context.workspace_id
    current = read_team_sync(call.repositories, workspace_id, team.team_id)
    body: dict[str, Any] = current.model_dump(include={"repository_id", *SETTINGS}) if current is not None else {}
    if call.present("repository"):
        body["repository_id"] = _repository_id(call, call.arguments["repository"])
    if "repository_id" not in body:
        raise ToolError("This team does not sync yet, so name a repository")
    body.update({name: call.arguments[name] for name in SETTINGS if call.present(name)})
    payload = TeamSyncWrite.model_validate(body)
    saved = save_team_sync(call.repositories, workspace_id, call.context.user_id, team.team_id, payload)
    return _sync_json(team, saved)


SYNC_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="get_team_github_sync",
        description=(
            "Read which GitHub repository a team's issues sync with, which way, whether labels and the sync "
            "are on, whether the repository is private, and whether two way sync is allowed on a public one."
        ),
        scopes=("teams:read",),
        schema=object_schema({"team_id": string(TEAM_ARGUMENT)}, required=("team_id",)),
        handler=_get_team_github_sync,
    ),
    Tool(
        name="update_team_github_sync",
        description=(
            "Link a team's issues to a GitHub repository or change how they sync, keeping every setting not "
            "given. A public repository only syncs github_to_standupless unless allow_public_two_way is true, "
            "which publishes the team's issues on GitHub and keeps the link two way if the repository turns "
            "public. Needs team admin."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "repository": string("Repository id or owner/name; needed when the team does not sync yet"),
                "direction": enum(SYNC_DIRECTIONS, "two_way, or github_to_standupless to import without writing back"),
                "enabled": {"type": "boolean", "description": "Whether the sync runs; false pauses it"},
                "sync_labels": {"type": "boolean", "description": "Whether labels follow between the two sides"},
                "allow_public_two_way": {
                    "type": "boolean",
                    "description": (
                        "Allow two way sync on a public repository, publishing the team's issues there. Off by default"
                    ),
                },
            },
            required=("team_id",),
        ),
        handler=_update_team_github_sync,
        idempotent=True,
    ),
)
