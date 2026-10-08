"""The MCP tools for releases: what shipped where, and the pipeline of stages a team ships through.

Each tool runs the same `app.common.releases` path the release routes do, so an
agent recording a release after a deploy gets exactly what a CI job posting to the
API gets: a commit the team already released advances that release rather than
making a second one, and issue references that match nothing are echoed back in
`skipped_issues` instead of refusing the release. Any team member records and edits
a release; only a team administrator changes the pipeline, deletes a release or
backfills releases from past GitHub deployments.
"""

from __future__ import annotations

from typing import Any

from app.common import releases
from app.common.api.schemas.releases import (
    BACKFILL_MAX_LIMIT,
    COMMIT_MESSAGES_MAX,
    ISSUES_MAX,
    ReleaseBackfill,
    ReleaseCreate,
    ReleaseDetailRead,
    ReleaseIssuesAdd,
    ReleasePipelineRead,
    ReleasePipelineUpdate,
    ReleaseRead,
    ReleaseStageAdvance,
    ReleaseUpdate,
)
from app.common.planning_rules import require_team_admin
from app.domains.integrations import deployments
from app.domains.integrations.mcp.toolkit import (
    Tool,
    ToolCall,
    limit,
    nullable,
    object_schema,
    page_properties,
    string,
    string_list,
    team_id_ref,
)
from app.domains.integrations.mcp.transport import ToolError

TEAM_HELP = "The team: id, key such as ENG, or name"

RELEASE_HELP = "The release: id, or its name within the team"

STAGE_HELP = "A stage of the team's release pipeline, by id or name, such as Staging or Production"

NAME_LOOKUP_LIMIT = 100
"""How many of a team's newest releases a release named by name is looked for among."""


def _team_id(call: ToolCall) -> str:
    """The id of the visible team the `team_id` argument names."""
    return team_id_ref(call, call.require("team_id"))


def _release_id(call: ToolCall, team_id: str) -> str:
    """A release id from an id, or a name unique among the team's newest releases."""
    reference = str(call.require("release_id")).strip()
    if call.repositories.releases.get(call.context.workspace_id, team_id, reference) is not None:
        return reference
    rows, _ = releases.list_releases(call.repositories, call.context, team_id, limit=NAME_LOOKUP_LIMIT)
    matches = [row for row in rows if row.name.casefold() == reference.casefold()]
    if len(matches) > 1:
        raise ToolError(f"More than one release is named {reference}; pass its id instead")
    if not matches:
        raise ToolError(f"No release {reference} in this team")
    return matches[0].release_id


def _stage_json(stage: Any) -> dict[str, Any] | None:
    """One reached stage as a tool answers it."""
    if stage is None:
        return None
    return {
        "stage_id": stage.stage_id,
        "name": stage.name,
        "reached_at": stage.reached_at.isoformat(),
        "source": stage.source,
        "environment": stage.environment,
        "url": stage.url,
    }


def _release_json(release: ReleaseRead) -> dict[str, Any]:
    """One release as a listing answers it."""
    return {
        "release_id": release.release_id,
        "team_id": release.team_id,
        "name": release.name,
        "version": release.version,
        "source": release.source,
        "repository": release.repository,
        "sha": release.sha,
        "url": release.url,
        "pr_number": release.pr_number,
        "pr_url": release.pr_url,
        "github_release_url": release.github_release_url,
        "issue_count": release.issue_count,
        "current_stage": _stage_json(release.current_stage),
        "created_at": release.created_at.isoformat(),
    }


def _detail_json(release: ReleaseDetailRead) -> dict[str, Any]:
    """One release with its stages, issues and notes."""
    body = _release_json(release)
    body.update(
        {
            "description": release.description,
            "previous_sha": release.previous_sha,
            "stages": [_stage_json(stage) for stage in release.stages],
            "issues": [
                {"issue_id": row.issue_id, "key": row.key, "title": row.title, "status_category": row.status_category}
                for row in release.issues
            ],
            "notes": release.notes,
            "skipped_issues": release.skipped_issues,
        }
    )
    return body


def _pipeline_json(pipeline: ReleasePipelineRead) -> dict[str, Any]:
    """A team's pipeline as a tool answers it."""
    return {
        "team_id": pipeline.team_id,
        "configured": pipeline.configured,
        "stages": [
            {
                "stage_id": stage.stage_id,
                "name": stage.name,
                "github_environments": stage.github_environments,
                "status_id": stage.status_id,
                "publish_github_release": stage.publish_github_release,
            }
            for stage in pipeline.stages
        ],
    }


def _list_releases(call: ToolCall) -> Any:
    """One page of a team's releases, newest first."""
    team_id = _team_id(call)
    rows, next_cursor = releases.list_releases(
        call.repositories,
        call.context,
        team_id,
        cursor=call.optional("cursor"),
        limit=limit(call.optional("limit")),
    )
    return {"releases": [_release_json(row) for row in rows], "next_cursor": next_cursor}


def _get_release(call: ToolCall) -> Any:
    """One release with its stages, issues and notes."""
    team_id = _team_id(call)
    release_id = _release_id(call, team_id)
    return _detail_json(releases.get_release(call.repositories, call.context, team_id, release_id))


def _create_release(call: ToolCall) -> Any:
    """Record a release reaching a stage through the route's own path."""
    team_id = _team_id(call)
    payload: dict[str, Any] = {}
    for name in (
        "name",
        "version",
        "description",
        "stage",
        "sha",
        "previous_sha",
        "repository",
        "url",
        "environment",
        "issues",
        "commit_messages",
    ):
        if call.optional(name) is not None:
            payload[name] = call.arguments[name]
    detail, created = releases.create_release(
        call.repositories, call.context, team_id, ReleaseCreate.model_validate(payload)
    )
    return {**_detail_json(detail), "created": created}


def _advance_release(call: ToolCall) -> Any:
    """Mark a release as having reached a stage."""
    team_id = _team_id(call)
    release_id = _release_id(call, team_id)
    payload = {"stage": call.require("stage")}
    for name in ("environment", "url"):
        if call.optional(name) is not None:
            payload[name] = call.arguments[name]
    detail = releases.advance_release(
        call.repositories, call.context, team_id, release_id, ReleaseStageAdvance.model_validate(payload)
    )
    return _detail_json(detail)


def _update_release(call: ToolCall) -> Any:
    """Patch a release's name, version, description or link; null clears an optional one."""
    team_id = _team_id(call)
    release_id = _release_id(call, team_id)
    payload = {name: call.arguments[name] for name in ("name", "version", "description", "url") if call.present(name)}
    detail = releases.update_release(
        call.repositories, call.context, team_id, release_id, ReleaseUpdate.model_validate(payload)
    )
    return _detail_json(detail)


def _add_issues_to_release(call: ToolCall) -> Any:
    """Add issues of the team to a release by key or id."""
    team_id = _team_id(call)
    release_id = _release_id(call, team_id)
    payload = ReleaseIssuesAdd.model_validate({"issues": call.require("issues")})
    detail = releases.add_release_issues(call.repositories, call.context, team_id, release_id, payload.issues)
    return _detail_json(detail)


def _remove_issue_from_release(call: ToolCall) -> Any:
    """Take one issue off a release."""
    team_id = _team_id(call)
    release_id = _release_id(call, team_id)
    detail = releases.remove_release_issue(
        call.repositories, call.context, team_id, release_id, str(call.require("issue"))
    )
    return _detail_json(detail)


def _delete_release(call: ToolCall) -> Any:
    """Delete a release as a team administrator."""
    team_id = _team_id(call)
    release_id = _release_id(call, team_id)
    releases.delete_release(call.repositories, call.context, team_id, release_id)
    return {"deleted": True, "release_id": release_id, "team_id": team_id}


def _get_release_pipeline(call: ToolCall) -> Any:
    """The team's ordered release stages."""
    return _pipeline_json(releases.get_pipeline(call.repositories, call.context, _team_id(call)))


def _set_release_pipeline(call: ToolCall) -> Any:
    """Replace the team's release stages as a team administrator."""
    team_id = _team_id(call)
    stages = call.require("stages")
    if not isinstance(stages, list):
        raise ToolError("stages must be a list")
    payload = ReleasePipelineUpdate.model_validate({"stages": stages})
    return _pipeline_json(releases.set_pipeline(call.repositories, call.context, team_id, payload))


def _backfill_releases(call: ToolCall) -> Any:
    """Rebuild one batch of a team's releases from past GitHub deployments, as a team administrator."""
    team_id = _team_id(call)
    require_team_admin(call.repositories, call.context, team_id)
    payload = {
        name: call.arguments[name]
        for name in ("repository", "environment", "limit", "cursor")
        if call.optional(name) is not None
    }
    result = deployments.backfill(
        call.repositories, call.context.workspace_id, team_id, ReleaseBackfill.model_validate(payload)
    )
    return result.model_dump(mode="json")


RELEASE_REF: dict[str, Any] = {"team_id": string(TEAM_HELP), "release_id": string(RELEASE_HELP)}

STAGE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "stage_id": string("The stage's id, to keep it when renaming; omit for a new stage"),
        "name": string("The stage name, such as Staging"),
        "github_environments": string_list("GitHub deployment environments that reach this stage, such as staging"),
        "status_id": nullable(
            "A status, by id or name, that the release's issues move to on reaching this stage. "
            "Issues only move forward, never back or out of canceled. Null for none"
        ),
        "publish_github_release": {
            "type": "boolean",
            "description": (
                "Whether a GitHub deployment reaching this stage publishes a GitHub Release, "
                "tagged with the release name, with the release notes as its body"
            ),
        },
    },
    "required": ["name"],
    "additionalProperties": False,
}

RELEASE_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_releases",
        description="One page of a team's releases, newest first, each with its furthest stage and issue count.",
        scopes=("releases:read",),
        schema=object_schema({"team_id": string(TEAM_HELP), **page_properties()}, required=("team_id",)),
        handler=_list_releases,
    ),
    Tool(
        name="get_release",
        description="One release with every stage it reached, its issues and its release notes.",
        scopes=("releases:read",),
        schema=object_schema(RELEASE_REF, required=("team_id", "release_id")),
        handler=_get_release,
    ),
    Tool(
        name="create_release",
        description=(
            "Record a release reaching a stage of the team's pipeline, the first stage by default. "
            "Issues come from issues and from team keys found in commit_messages. "
            "A sha the team already released advances that release instead of making another."
        ),
        scopes=("releases:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_HELP),
                "name": string("The release name; defaults to the date and short sha"),
                "version": string("A version such as 1.4.0"),
                "description": string("What the release is, in Markdown"),
                "stage": string(STAGE_HELP),
                "sha": string("The commit shipped"),
                "previous_sha": string("The commit the last release of this stage shipped"),
                "repository": string("The repository, such as owner/name"),
                "url": string("A link to the deploy or build"),
                "environment": string("The environment it reached, such as production"),
                "issues": string_list(f"Issues it carried, each a key such as ENG-12 or an id; at most {ISSUES_MAX}"),
                "commit_messages": string_list(
                    f"Commit messages it shipped; team issue keys in them are linked; at most {COMMIT_MESSAGES_MAX}"
                ),
            },
            required=("team_id",),
        ),
        handler=_create_release,
    ),
    Tool(
        name="advance_release",
        description="Mark a release as having reached a stage. Reaching a stage again keeps the first time.",
        scopes=("releases:write",),
        schema=object_schema(
            {
                **RELEASE_REF,
                "stage": string(STAGE_HELP),
                "environment": string("The environment it reached"),
                "url": string("A link to the deploy"),
            },
            required=("team_id", "release_id", "stage"),
        ),
        handler=_advance_release,
        idempotent=True,
    ),
    Tool(
        name="update_release",
        description="Change a release's name, version, description or link. Only the fields named are written.",
        scopes=("releases:write",),
        schema=object_schema(
            {
                **RELEASE_REF,
                "name": string("The release name"),
                "version": nullable("A version, or null"),
                "description": nullable("The description in Markdown, or null"),
                "url": nullable("A link, or null"),
            },
            required=("team_id", "release_id"),
        ),
        handler=_update_release,
    ),
    Tool(
        name="add_issues_to_release",
        description="Add issues of the release's team to it. References matching nothing come back in skipped_issues.",
        scopes=("releases:write",),
        schema=object_schema(
            {**RELEASE_REF, "issues": string_list("Issues, each a key such as ENG-12 or an id")},
            required=("team_id", "release_id", "issues"),
        ),
        handler=_add_issues_to_release,
        idempotent=True,
    ),
    Tool(
        name="remove_issue_from_release",
        description="Take one issue off a release. The issue itself is untouched.",
        scopes=("releases:write",),
        schema=object_schema(
            {**RELEASE_REF, "issue": string("The issue, a key such as ENG-12 or an id")},
            required=("team_id", "release_id", "issue"),
        ),
        handler=_remove_issue_from_release,
        destructive=True,
        idempotent=True,
    ),
    Tool(
        name="delete_release",
        description="Permanently delete a release record. Its issues are untouched. Team administrators only.",
        scopes=("releases:write",),
        schema=object_schema(RELEASE_REF, required=("team_id", "release_id")),
        handler=_delete_release,
        destructive=True,
    ),
    Tool(
        name="get_release_pipeline",
        description="A team's ordered release stages and the GitHub environments that reach each.",
        scopes=("releases:read",),
        schema=object_schema({"team_id": string(TEAM_HELP)}, required=("team_id",)),
        handler=_get_release_pipeline,
    ),
    Tool(
        name="set_release_pipeline",
        description=(
            "Replace a team's ordered release stages. Keep a stage's stage_id to rename it without "
            "losing the releases that reached it. Team administrators only."
        ),
        scopes=("releases:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_HELP),
                "stages": {"type": "array", "items": STAGE_SCHEMA, "description": "The stages, in order"},
            },
            required=("team_id", "stages"),
        ),
        handler=_set_release_pipeline,
        idempotent=True,
    ),
    Tool(
        name="backfill_releases",
        description=(
            "Rebuild a team's releases from a GitHub environment's past successful deployments, newest first, "
            "a few per call. Pass next_cursor back as cursor until it is null. Never moves issues or "
            "publishes GitHub Releases. Team administrators only."
        ),
        scopes=("releases:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_HELP),
                "repository": string("The repository, owner/name or id; defaults to the team's pinned repositories"),
                "environment": string("The GitHub environment, production by default"),
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": BACKFILL_MAX_LIMIT,
                    "description": "Deployments per call",
                },
                "cursor": string("The next_cursor a previous call answered"),
            },
            required=("team_id",),
        ),
        handler=_backfill_releases,
        idempotent=True,
    ),
)
