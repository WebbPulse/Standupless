"""The MCP tools for importing a Linear workspace and following or stopping an import.

They run the same `app.common.issue_import` and `app.common.linear_import`
functions as the import routes and check the same workspace admin capability, so
an agent can move a team off Linear exactly as an admin can in the app. The
Linear key an agent passes is used for that call, sealed while the job runs and
deleted when it ends, and never comes back in an answer.
"""

from __future__ import annotations

from typing import Any

from app.common import audit, issue_import, linear_import
from app.common.api.dependencies.authz import Capability, check_capability
from app.common.issue_rules import require_team_member
from app.common.linear_api import LinearAuthFailed, LinearError
from app.domains.integrations.mcp.toolkit import NOT_VISIBLE, Tool, ToolCall, object_schema, string, team_id_ref
from app.domains.integrations.mcp.transport import ToolError
from app.domains.integrations.schemas.imports import IssueImportRead

KEY_ARGUMENT = "A Linear personal API key with read access. Used for this import only and never stored after it."

TEAMS_SCHEMA: dict[str, Any] = {
    "type": "array",
    "minItems": 1,
    "items": {
        "type": "object",
        "properties": {
            "linear_team_id": string("The Linear team id list_linear_teams answered"),
            "team_id": string("The Standupless team it goes into: id, key such as ENG, or name"),
        },
        "required": ["linear_team_id", "team_id"],
    },
    "description": "Each Linear team to import and the Standupless team it goes into",
}


def _linear_error(exc: LinearError) -> ToolError:
    """A Linear failure as a tool error that never carries the key."""
    if isinstance(exc, LinearAuthFailed):
        return ToolError("Linear refused the API key. Check it has read access and has not been revoked.")
    return ToolError("Linear did not answer, try again shortly.")


def _job_json(job: issue_import.ImportJob) -> dict[str, Any]:
    """One import as the tools answer it, the same shape the import routes answer."""
    return IssueImportRead.from_job(job).model_dump(mode="json")


def _list_linear_teams(call: ToolCall) -> Any:
    """The Linear teams a key can read."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    try:
        teams = linear_import.read_teams(str(call.require("api_key")).strip())
    except LinearError as exc:
        raise _linear_error(exc) from None
    return {"teams": teams}


def _import_linear_workspace(call: ToolCall) -> Any:
    """Queue an import of Linear teams into Standupless teams."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    api_key = str(call.require("api_key")).strip()
    choices: list[tuple[str, str]] = []
    for item in call.require("teams"):
        if not isinstance(item, dict):
            raise ToolError("each teams entry needs linear_team_id and team_id")
        linear_team_id = str(item.get("linear_team_id") or "").strip()
        team = str(item.get("team_id") or "").strip()
        if not linear_team_id or not team:
            raise ToolError("each teams entry needs linear_team_id and team_id")
        team_id = team_id_ref(call, team)
        require_team_member(call.repositories, call.context, team_id)
        choices.append((linear_team_id, team_id))
    try:
        mappings = linear_import.team_mappings(api_key, choices)
        job = issue_import.start_linear_import(call.repositories, call.context, api_key, mappings)
    except LinearError as exc:
        raise _linear_error(exc) from None
    except linear_import.UnknownLinearTeam:
        raise ToolError("A chosen Linear team is not readable with this key, or was chosen twice") from None
    except (issue_import.ImportUnavailable, issue_import.ImportInProgress) as exc:
        raise ToolError(str(exc)) from exc
    audit.record(
        call.repositories,
        call.context,
        "import.started",
        target_type="import",
        target_id=job.import_id,
        target_label="Linear",
        after={
            "preset": job.preset,
            "teams": [{"linear_key": mapping.linear_key, "team_id": mapping.team_id} for mapping in mappings],
        },
    )
    return _job_json(job)


def _get_workspace_import(call: ToolCall) -> Any:
    """One import's progress, tallies and problems."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    try:
        job = issue_import.load_job(call.context.workspace_id, str(call.require("import_id")).strip())
    except issue_import.ImportUnavailable as exc:
        raise ToolError(str(exc)) from exc
    if job is None:
        raise ToolError(NOT_VISIBLE)
    return _job_json(job)


def _cancel_workspace_import(call: ToolCall) -> Any:
    """Stop an import that is queued or running."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    try:
        job = issue_import.cancel_import(call.context.workspace_id, str(call.require("import_id")).strip())
    except issue_import.ImportUnavailable as exc:
        raise ToolError(str(exc)) from exc
    except issue_import.ImportNotFound:
        raise ToolError(NOT_VISIBLE) from None
    audit.record(
        call.repositories,
        call.context,
        "import.cancelled",
        target_type="import",
        target_id=job.import_id,
        target_label=job.file_name,
        after={"status": job.status},
    )
    return _job_json(job)


IMPORT_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_linear_teams",
        description=(
            "The teams a Linear personal API key can read, with their ids, keys and names, to choose what "
            "import_linear_workspace imports. The key is not stored. Needs workspace owner or admin."
        ),
        scopes=("settings:write", "admin"),
        schema=object_schema({"api_key": string(KEY_ARGUMENT)}, required=("api_key",)),
        handler=_list_linear_teams,
    ),
    Tool(
        name="import_linear_workspace",
        description=(
            "Start an import from Linear: each chosen Linear team's issues with labels, comments, sub-issues and "
            "relations, its cycles, its projects with milestones and updates, and the workspace's initiatives, "
            "into existing Standupless teams (create_team first for a new one). People are matched by email. "
            "Running it again updates what an earlier import wrote instead of duplicating it. Runs in the "
            "background; poll get_workspace_import. Needs workspace owner or admin."
        ),
        scopes=("settings:write", "admin"),
        schema=object_schema(
            {"api_key": string(KEY_ARGUMENT), "teams": TEAMS_SCHEMA},
            required=("api_key", "teams"),
        ),
        handler=_import_linear_workspace,
    ),
    Tool(
        name="get_workspace_import",
        description=(
            "One import's status, phase, tallies and the problems it kept, for a Linear or CSV import. Needs "
            "workspace owner or admin."
        ),
        scopes=("settings:read", "admin"),
        schema=object_schema(
            {"import_id": string("The import_id import_linear_workspace answered")},
            required=("import_id",),
        ),
        handler=_get_workspace_import,
    ),
    Tool(
        name="cancel_workspace_import",
        description=(
            "Stop an import that is queued or running. What it already wrote stays; running the import again "
            "picks up from there. Needs workspace owner or admin."
        ),
        scopes=("settings:write", "admin"),
        schema=object_schema(
            {"import_id": string("The import_id import_linear_workspace answered")},
            required=("import_id",),
        ),
        handler=_cancel_workspace_import,
        idempotent=True,
    ),
)
