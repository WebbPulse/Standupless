"""The MCP tools for a team's GitHub links: the issue sync link and the pinned repositories.

The sync tools answer and write what the `github-sync` routes do, through the same
shared calls and capability checks: reading needs team read and `teams:read`,
changing needs team admin and `teams:write`. A change keeps every setting it does
not name, so an agent can flip one switch without restating the link, and a public
repository syncs both ways only when `allow_public_two_way` is on.

A pinned repository is the separate link the GitHub repositories route writes: it
narrows the repository's pull request matching to one team and lets that team's
release pipeline publish GitHub Releases from its deployments. The read answers it
beside the sync link, so a team with no issue sync still shows the repositories it
releases from.
"""

from __future__ import annotations

from typing import Any

from app.common.api.dependencies.authz import Capability, check_capability
from app.common.db.dynamo.github import SYNC_DIRECTIONS, Repository_
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
from app.domains.integrations.service import require_team_content
from app.domains.integrations.team_sync import read_team_sync, save_team_sync

TEAM_ARGUMENT = "Team: id, key such as ENG, or name"

SETTINGS = ("direction", "enabled", "sync_labels", "allow_public_two_way")


def _team(call: ToolCall, capability: Capability) -> Team:
    """The team named in `team_id`, held to the capability its route needs."""
    team = team_ref(call, call.require("team_id"))
    check_capability(call.repositories, call.context, capability, team.team_id)
    return team


def _pinned_repositories(call: ToolCall, team_id: str) -> list[str]:
    """The owner/name of every repository pinned to the team, sorted."""
    rows = call.repositories.github.list_repositories(call.context.workspace_id)
    return sorted(row.full_name for row in rows if row.team_id == team_id)


def _sync_json(call: ToolCall, team: Team, read: TeamSyncRead | None) -> dict[str, Any]:
    """A team's sync link, or `linked: false` when it has none, with the repositories pinned to it."""
    pinned = {"pinned_repositories": _pinned_repositories(call, team.team_id)}
    if read is None:
        return {"team_id": team.team_id, "linked": False, **pinned}
    return {"linked": True, **read.model_dump(mode="json"), **pinned}


def _repository(call: ToolCall, value: Any) -> Repository_:
    """A repository by its numeric id or its owner/name, among the installation's repositories."""
    reference = str(value).strip()
    rows = call.repositories.github.list_repositories(call.context.workspace_id)
    by_id = [row for row in rows if row.repository_id == reference]
    if by_id:
        return by_id[0]
    folded = reference.casefold()
    named = [row for row in rows if row.full_name.casefold() == folded]
    if len(named) != 1:
        raise ToolError(f"The GitHub App cannot see a repository named {reference}")
    return named[0]


def _repository_id(call: ToolCall, value: Any) -> str:
    """A repository id from its numeric id or its owner/name, among the installation's repositories."""
    return _repository(call, value).repository_id


def _get_team_github_sync(call: ToolCall) -> Any:
    """Which repository a team's issues sync with, which way, and the public repository setting."""
    team = _team(call, Capability.TEAM_READ)
    return _sync_json(call, team, read_team_sync(call.repositories, call.context.workspace_id, team.team_id))


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
    return _sync_json(call, team, saved)


def _pin_team_repository(call: ToolCall) -> Any:
    """Pin a repository to a team, or unpin it, as the GitHub repositories route does.

    Pinning needs workspace admin like the route, and membership of a private team.
    A repository pinned to another team is refused rather than taken over, and
    unpinning one the team does not hold changes nothing.
    """
    team = _team(call, Capability.TEAM_ADMIN)
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    workspace_id = call.context.workspace_id
    repository = _repository(call, call.require("repository"))
    pinned = call.arguments.get("pinned", True)
    if not isinstance(pinned, bool):
        raise ToolError("pinned must be true or false")
    if pinned:
        require_team_content(call.context, team.team_id)
        if repository.team_id not in (None, team.team_id):
            raise ToolError(f"{repository.full_name} is pinned to another team; unpin it there first")
        if repository.team_id is None:
            call.repositories.github.set_repository_team(workspace_id, repository.repository_id, team.team_id)
    elif repository.team_id == team.team_id:
        call.repositories.github.set_repository_team(workspace_id, repository.repository_id, None)
    return _sync_json(call, team, read_team_sync(call.repositories, workspace_id, team.team_id))


SYNC_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="get_team_github_sync",
        description=(
            "Read which GitHub repository a team's issues sync with, which way, whether labels and the sync "
            "are on, whether the repository is private, and whether two way sync is allowed on a public one, "
            "plus pinned_repositories, the repositories pinned to the team for pull request matching and "
            "GitHub Releases."
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
    Tool(
        name="pin_team_repository",
        description=(
            "Pin a GitHub repository to a team, or unpin it with pinned false. A pinned repository matches "
            "pull requests against that team's keys only, and its deployments publish GitHub Releases for "
            "the team's release stages set to publish. Independent of issue sync, so nothing is imported. "
            "Needs workspace admin."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "repository": string("Repository id or owner/name"),
                "pinned": {"type": "boolean", "description": "True pins, false unpins. True by default"},
            },
            required=("team_id", "repository"),
        ),
        handler=_pin_team_repository,
        idempotent=True,
    ),
)
