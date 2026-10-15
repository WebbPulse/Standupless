"""The MCP tools for a team's GitHub links: the issue sync link and the pinned repositories.

The sync tools answer and write what the `github-sync` routes do, through the same
shared calls and capability checks: reading needs team read and `teams:read`,
changing needs team admin and `teams:write`. A change keeps every setting it does
not name, so an agent can flip one switch without restating the link, and a public
repository syncs both ways only when `allow_public_two_way` is on.

A pinned repository is the separate link the GitHub repositories route writes: it
chooses which team's release pipeline publishes GitHub Releases from the
repository's deployments, and leaves pull request matching across every team. The read answers it
beside the sync link, so a team with no issue sync still shows the repositories it
releases from. The pin also carries the repository's release source, so a package
repository with no deployments can record its releases from tags or GitHub Releases.
"""

from __future__ import annotations

from typing import Any

from app.common.api.dependencies.authz import Capability, check_capability
from app.common.db.dynamo.github import RELEASE_SOURCE_KINDS, SYNC_DIRECTIONS, Repository_
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
from app.domains.integrations.schemas.integrations import TAG_PATTERN_MAX, TeamSyncRead, TeamSyncWrite
from app.domains.integrations.service import require_team_content
from app.domains.integrations.team_sync import read_team_sync, record_pin, save_team_sync

TEAM_ARGUMENT = "Team: id, key such as ENG, or name"

SETTINGS = ("direction", "enabled", "sync_labels", "allow_public_two_way")

RELEASE_ARGUMENTS = ("release_source", "tag_pattern", "release_status", "move_issues")


def _team(call: ToolCall, capability: Capability) -> Team:
    """The team named in `team_id`, held to the capability its route needs."""
    team = team_ref(call, call.require("team_id"))
    check_capability(call.repositories, call.context, capability, team.team_id)
    return team


def _pinned_repositories(call: ToolCall, team_id: str) -> list[str]:
    """The owner/name of every repository pinned to the team, sorted."""
    rows = call.repositories.github.list_repositories(call.context.workspace_id)
    return sorted(row.full_name for row in rows if row.team_id == team_id)


def _release_sources(call: ToolCall, team_id: str) -> dict[str, Any]:
    """What records the releases of each repository pinned to the team, by owner/name."""
    rows = call.repositories.github.list_repositories(call.context.workspace_id)
    return {
        row.full_name: row.release_source.model_dump(mode="json")
        for row in sorted(rows, key=lambda row: row.full_name)
        if row.team_id == team_id
    }


def _sync_json(call: ToolCall, team: Team, read: TeamSyncRead | None) -> dict[str, Any]:
    """A team's sync link, or `linked: false` when it has none, with the repositories pinned to it."""
    pinned = {
        "pinned_repositories": _pinned_repositories(call, team.team_id),
        "release_sources": _release_sources(call, team.team_id),
    }
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
    saved = save_team_sync(call.repositories, call.context, team.team_id, payload)
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
            record_pin(
                call.repositories, call.context, repository.repository_id, repository.full_name, None, team.team_id
            )
        _set_release_source(call, team, repository)
    elif repository.team_id == team.team_id:
        call.repositories.github.set_repository_team(workspace_id, repository.repository_id, None)
        record_pin(call.repositories, call.context, repository.repository_id, repository.full_name, team.team_id, None)
    return _sync_json(call, team, read_team_sync(call.repositories, workspace_id, team.team_id))


def _set_release_source(call: ToolCall, team: Team, repository: Repository_) -> None:
    """Change what records a pinned repository's releases, keeping each part of the setting not named."""
    from app.domains.integrations.tag_releases import resolve_release_source

    if not any(call.present(name) for name in RELEASE_ARGUMENTS):
        return
    current = repository.release_source
    move_issues = call.arguments.get("move_issues", current.move_issues)
    if not isinstance(move_issues, bool):
        raise ToolError("move_issues must be true or false")
    kind = str(call.arguments.get("release_source", current.kind))
    if kind not in RELEASE_SOURCE_KINDS:
        raise ToolError(f"release_source must be one of {', '.join(RELEASE_SOURCE_KINDS)}")
    pattern = call.arguments.get("tag_pattern", current.tag_pattern)
    status = call.arguments.get("release_status", current.status_id)
    source = resolve_release_source(
        call.repositories,
        call.context.workspace_id,
        team.team_id,
        kind=kind,
        tag_pattern=str(pattern).strip()[:TAG_PATTERN_MAX] or None if pattern is not None else None,
        status=str(status).strip() or None if status is not None else None,
        move_issues=move_issues,
    )
    call.repositories.github.set_repository_release_source(call.context.workspace_id, repository.repository_id, source)


SYNC_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="get_team_github_sync",
        description=(
            "Read which GitHub repository a team's issues sync with, which way, whether labels and the sync "
            "are on, whether the repository is private, and whether two way sync is allowed on a public one, "
            "plus pinned_repositories, the repositories whose deployments feed the team's "
            "GitHub Releases, and release_sources, what records each pinned repository's releases."
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
            "Pin a GitHub repository to a team, or unpin it with pinned false. A pin only chooses which team's "
            "releases the repository feeds: its deployments publish GitHub Releases for the team's release "
            "stages set to publish, and its pull requests still link to any team key they mention. Independent "
            "of issue sync, so nothing is imported. release_source chooses what records the team's releases: "
            "deployments (the default), tags (each pushed tag matching tag_pattern, a glob such as v* or "
            "python-v*) or github_releases (each published GitHub Release whose tag matches). A tag release is "
            "named after the repository and tag, carries the issues named since the previous matching tag, "
            "and moves the issues it closes to release_status, the team's Done by default, unless move_issues "
            "is false. Release settings not given are kept. Needs workspace admin."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "repository": string("Repository id or owner/name"),
                "pinned": {"type": "boolean", "description": "True pins, false unpins. True by default"},
                "release_source": enum(
                    RELEASE_SOURCE_KINDS, "What records the team's releases from this repository; kept when absent"
                ),
                "tag_pattern": string("A glob the tags must match, such as v* or python-v*; empty records every tag"),
                "release_status": string(
                    "The team status, by id or name, a tag release moves the issues it closes to; empty means Done"
                ),
                "move_issues": {
                    "type": "boolean",
                    "description": "Whether a tag release moves the issues it closes. True by default",
                },
            },
            required=("team_id", "repository"),
        ),
        handler=_pin_team_repository,
        idempotent=True,
    ),
)
