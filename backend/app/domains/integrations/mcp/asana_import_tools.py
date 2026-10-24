"""The MCP tools for importing Asana projects through Asana's API.

They run the same `asana_import` functions as the Asana import routes and check
the same workspace admin capability, so an agent can move a team off Asana
exactly as an admin can in the app. The personal access token an agent passes
is used for that call, sealed while an import runs and deleted when it ends, and
never comes back in an answer. The job is followed and cancelled with
get_workspace_import and cancel_workspace_import.
"""

from __future__ import annotations

from typing import Any

from app.common import audit, issue_import
from app.common.api.dependencies.authz import Capability, check_capability
from app.common.issue_rules import require_team_member
from app.domains.integrations import asana_import
from app.domains.integrations.asana_api import AsanaAuthFailed, AsanaError
from app.domains.integrations.mcp.toolkit import Tool, ToolCall, object_schema, string, team_id_ref
from app.domains.integrations.mcp.transport import ToolError
from app.domains.integrations.schemas.asana_imports import AsanaProjectPreviewRead
from app.domains.integrations.schemas.imports import IssueImportRead

TOKEN_ARGUMENT = "An Asana personal access token. Used for this call or import only and never stored after it."

UNKNOWN_PROJECT = "A chosen Asana project is not readable with this token, or was chosen twice"

PROJECTS_SCHEMA: dict[str, Any] = {
    "type": "array",
    "minItems": 1,
    "maxItems": 50,
    "items": {
        "type": "object",
        "properties": {
            "project_gid": string("The Asana project gid list_asana_projects answered"),
            "team_id": string("The Standupless team its tasks go into: id, key such as ENG, or name"),
            "create_project": {
                "type": "boolean",
                "description": "Also write the Asana project as a Standupless project. Defaults to true",
            },
            "status_field_gid": string(
                "A single choice custom field whose options set the status instead of the task's section, from "
                "the status_fields preview_asana_import answered"
            ),
            "statuses": {
                "type": "object",
                "additionalProperties": {"type": "string"},
                "description": (
                    "Section or option name to the id of the team status it lands in (list_statuses). Anything "
                    "unmapped lands in the status of the same name, else the status its name means, else the "
                    "team's default"
                ),
            },
        },
        "required": ["project_gid", "team_id"],
    },
    "description": "Each Asana project to import, the Standupless team it goes into, and how its tasks map",
}

IMPORT_PROPERTIES: dict[str, Any] = {"token": string(TOKEN_ARGUMENT), "projects": PROJECTS_SCHEMA}


def _asana_error(exc: AsanaError) -> ToolError:
    """An Asana failure as a tool error that never carries the token."""
    if isinstance(exc, AsanaAuthFailed):
        return ToolError("Asana refused the personal access token. Check it has not expired or been revoked.")
    return ToolError("Asana did not answer, try again shortly.")


def _choices(call: ToolCall) -> list[asana_import.ProjectChoice]:
    """The projects a call names, with each team resolved and checked for the caller."""
    items = call.require("projects")
    if not isinstance(items, list) or not 1 <= len(items) <= 50:
        raise ToolError("projects is a list of one to 50 entries")
    choices: list[asana_import.ProjectChoice] = []
    for item in items:
        if not isinstance(item, dict):
            raise ToolError("each projects entry needs project_gid and team_id")
        project_gid = str(item.get("project_gid") or "").strip()
        team = str(item.get("team_id") or "").strip()
        if not project_gid or not team:
            raise ToolError("each projects entry needs project_gid and team_id")
        statuses = item.get("statuses") or {}
        if not isinstance(statuses, dict):
            raise ToolError("statuses is an object of section or option name to status id")
        team_id = team_id_ref(call, team)
        require_team_member(call.repositories, call.context, team_id)
        choices.append(
            asana_import.ProjectChoice(
                project_gid=project_gid,
                team_id=team_id,
                create_project=item.get("create_project") is not False,
                status_field_gid=str(item.get("status_field_gid") or "").strip(),
                statuses={str(source): str(status_id) for source, status_id in statuses.items()},
            )
        )
    return choices


def _list_asana_projects(call: ToolCall) -> Any:
    """The Asana projects a token can read."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    try:
        projects = asana_import.read_projects(str(call.require("token")).strip())
    except AsanaError as exc:
        raise _asana_error(exc) from None
    return {"projects": projects}


def _preview_asana_import(call: ToolCall) -> Any:
    """What importing the chosen Asana projects would do, writing nothing."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    token = str(call.require("token")).strip()
    choices = _choices(call)
    try:
        previews = asana_import.preview_projects(call.repositories, call.context.workspace_id, token, choices)
    except AsanaError as exc:
        raise _asana_error(exc) from None
    except asana_import.UnknownAsanaProject:
        raise ToolError(UNKNOWN_PROJECT) from None
    except asana_import.UnknownStatusChoice as exc:
        raise ToolError(str(exc)) from None
    return {"projects": [AsanaProjectPreviewRead.from_preview(preview).model_dump(mode="json") for preview in previews]}


def _import_asana_workspace(call: ToolCall) -> Any:
    """Queue an import of Asana projects into Standupless teams."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    token = str(call.require("token")).strip()
    choices = _choices(call)
    try:
        job = asana_import.start_asana_import(call.repositories, call.context, token, choices)
    except AsanaError as exc:
        raise _asana_error(exc) from None
    except asana_import.UnknownAsanaProject:
        raise ToolError(UNKNOWN_PROJECT) from None
    except asana_import.UnknownStatusChoice as exc:
        raise ToolError(str(exc)) from None
    except (issue_import.ImportUnavailable, issue_import.ImportInProgress) as exc:
        raise ToolError(str(exc)) from exc
    audit.record(
        call.repositories,
        call.context,
        "import.started",
        target_type="import",
        target_id=job.import_id,
        target_label="Asana",
        after={
            "preset": job.preset,
            "projects": [
                {"project_gid": mapping.project_gid, "team_id": mapping.team_id} for mapping in job.asana_projects
            ],
        },
    )
    return IssueImportRead.from_job(job).model_dump(mode="json")


ASANA_IMPORT_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_asana_projects",
        description=(
            "The projects an Asana personal access token can read across its Asana workspaces, with their gids, "
            "names and teams, to choose what import_asana_workspace imports. The token is not stored. Needs "
            "workspace owner or admin."
        ),
        scopes=("settings:write", "admin"),
        schema=object_schema({"token": string(TOKEN_ARGUMENT)}, required=("token",)),
        handler=_list_asana_projects,
    ),
    Tool(
        name="preview_asana_import",
        description=(
            "Dry run an Asana import without writing anything: each chosen project's task count, its sections or "
            "the options of a chosen single choice field, the team status each lands in, and the single choice "
            "fields that could set the status instead. Needs workspace owner or admin."
        ),
        scopes=("settings:write", "admin"),
        schema=object_schema(IMPORT_PROPERTIES, required=("token", "projects")),
        handler=_preview_asana_import,
    ),
    Tool(
        name="import_asana_workspace",
        description=(
            "Start an import from Asana: each chosen project's tasks become issues in an existing Standupless team "
            "(create_team first for a new one), with subtasks as sub-issues, tags as labels, due dates and "
            "comments. Sections, or a chosen single choice field, set the status. Each project can also become a "
            "Standupless project. People are matched by email. Running it again updates what an earlier import "
            "wrote instead of duplicating it. Runs in the background; poll get_workspace_import. Needs workspace "
            "owner or admin."
        ),
        scopes=("settings:write", "admin"),
        schema=object_schema(IMPORT_PROPERTIES, required=("token", "projects")),
        handler=_import_asana_workspace,
    ),
)
