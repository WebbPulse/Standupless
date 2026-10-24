"""The MCP tools for importing Jira Cloud projects through Jira's API.

They run the same `jira_import` functions as the Jira import routes and check the
same workspace admin capability, so an agent can move a team off Jira exactly as
an admin can in the app. The account email and API token an agent passes are
used for that call, sealed while an import runs and deleted when it ends, and
never come back in an answer. The job is followed and cancelled with
get_workspace_import and cancel_workspace_import.
"""

from __future__ import annotations

from typing import Any

from app.common import audit, issue_import
from app.common.api.dependencies.authz import Capability, check_capability
from app.common.issue_rules import require_team_member
from app.domains.integrations import jira_api, jira_import
from app.domains.integrations.jira_api import JiraAuthFailed, JiraError
from app.domains.integrations.mcp.toolkit import Tool, ToolCall, object_schema, string, team_id_ref
from app.domains.integrations.mcp.transport import ToolError
from app.domains.integrations.schemas.imports import IssueImportRead
from app.domains.integrations.schemas.jira_imports import JiraProjectPreviewRead

SITE_ARGUMENT = "The Jira Cloud site, such as https://your-team.atlassian.net"

EMAIL_ARGUMENT = "The email of the Atlassian account the API token belongs to"

TOKEN_ARGUMENT = "An Atlassian API token. Used for this call or import only and never stored after it."

UNKNOWN_PROJECT = "A chosen Jira project is not one this account can browse, or was chosen twice"

INVALID_SITE = "site_url must be a Jira Cloud site such as https://your-team.atlassian.net"

CREDENTIAL_PROPERTIES: dict[str, Any] = {
    "site_url": string(SITE_ARGUMENT),
    "email": string(EMAIL_ARGUMENT),
    "token": string(TOKEN_ARGUMENT),
}

PROJECTS_SCHEMA: dict[str, Any] = {
    "type": "array",
    "minItems": 1,
    "maxItems": 50,
    "items": {
        "type": "object",
        "properties": {
            "project_key": string("The Jira project key list_jira_projects answered, such as ENG"),
            "jql": string("A JQL filter, alone or narrowing the project. Any ORDER BY is dropped"),
            "team_id": string("The Standupless team its issues go into: id, key such as ENG, or name"),
            "epics_as": {
                "type": "string",
                "enum": list(jira_import.EPIC_MODES),
                "description": (
                    "projects (the default) writes each epic as a Standupless project holding its issues; parents "
                    "writes each epic as an issue its children are sub-issues of"
                ),
            },
            "statuses": {
                "type": "object",
                "additionalProperties": {"type": "string"},
                "description": (
                    "Jira status name to the id of the team status it lands in (list_statuses). Anything unmapped "
                    "lands in the status of the same name, else the one its Jira status category means, else the "
                    "team's default"
                ),
            },
        },
        "required": ["team_id"],
    },
    "description": "Each Jira project or JQL filter to import, the Standupless team it goes into, and how it maps",
}

IMPORT_PROPERTIES: dict[str, Any] = {**CREDENTIAL_PROPERTIES, "projects": PROJECTS_SCHEMA}

REQUIRED: tuple[str, ...] = ("site_url", "email", "token")


def _jira_error(exc: JiraError) -> ToolError:
    """A Jira failure as a tool error that never carries the credentials."""
    if isinstance(exc, JiraAuthFailed):
        return ToolError("Jira refused the email and API token. Check the token has not expired or been revoked.")
    return ToolError("Jira did not answer, try again shortly.")


def _signin(call: ToolCall) -> tuple[str, jira_import.Credentials]:
    """The site and credentials a call names, refusing a site that is not Jira Cloud."""
    try:
        site = jira_api.site_url(str(call.require("site_url")))
    except jira_api.InvalidSite:
        raise ToolError(INVALID_SITE) from None
    email = str(call.require("email")).strip()
    token = str(call.require("token")).strip()
    if not email or not token:
        raise ToolError("email and token are required")
    return site, jira_import.Credentials(email=email, token=token)


def _choices(call: ToolCall) -> list[jira_import.ProjectChoice]:
    """The projects a call names, with each team resolved and checked for the caller."""
    items = call.require("projects")
    if not isinstance(items, list) or not 1 <= len(items) <= 50:
        raise ToolError("projects is a list of one to 50 entries")
    choices: list[jira_import.ProjectChoice] = []
    for item in items:
        if not isinstance(item, dict):
            raise ToolError("each projects entry needs team_id and a project_key or jql")
        project_key = str(item.get("project_key") or "").strip()
        jql = str(item.get("jql") or "").strip()
        team = str(item.get("team_id") or "").strip()
        if not team or not (project_key or jql):
            raise ToolError("each projects entry needs team_id and a project_key or jql")
        epics_as = str(item.get("epics_as") or "projects")
        if epics_as not in jira_import.EPIC_MODES:
            raise ToolError("epics_as is projects or parents")
        statuses = item.get("statuses") or {}
        if not isinstance(statuses, dict):
            raise ToolError("statuses is an object of Jira status name to status id")
        team_id = team_id_ref(call, team)
        require_team_member(call.repositories, call.context, team_id)
        choices.append(
            jira_import.ProjectChoice(
                team_id=team_id,
                project_key=project_key,
                jql=jql,
                epics_as=epics_as,
                statuses={str(source): str(status_id) for source, status_id in statuses.items()},
            )
        )
    return choices


def _choice_error(exc: Exception) -> ToolError:
    """A preview or import the chosen projects do not fit, as a tool error."""
    if isinstance(exc, JiraError):
        return _jira_error(exc)
    if isinstance(exc, jira_import.UnknownJiraProject):
        return ToolError(UNKNOWN_PROJECT)
    return ToolError(str(exc))


CHOICE_ERRORS = (JiraError, jira_import.UnknownJiraProject, jira_import.InvalidJql, jira_import.UnknownStatusChoice)


def _list_jira_projects(call: ToolCall) -> Any:
    """The Jira projects an account can browse on a site."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    site, credentials = _signin(call)
    try:
        projects = jira_import.read_projects(site, credentials.email, credentials.token)
    except JiraError as exc:
        raise _jira_error(exc) from None
    return {"site_url": site, "projects": projects}


def _preview_jira_import(call: ToolCall) -> Any:
    """What importing the chosen Jira projects would do, writing nothing."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    site, credentials = _signin(call)
    choices = _choices(call)
    try:
        previews = jira_import.preview_projects(
            call.repositories, call.context.workspace_id, site, credentials, choices
        )
    except CHOICE_ERRORS as exc:
        raise _choice_error(exc) from None
    return {
        "site_url": site,
        "projects": [JiraProjectPreviewRead.from_preview(preview).model_dump(mode="json") for preview in previews],
    }


def _import_jira_workspace(call: ToolCall) -> Any:
    """Queue an import of Jira projects into Standupless teams."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    site, credentials = _signin(call)
    choices = _choices(call)
    try:
        job = jira_import.start_jira_import(call.repositories, call.context, site, credentials, choices)
    except CHOICE_ERRORS as exc:
        raise _choice_error(exc) from None
    except (issue_import.ImportUnavailable, issue_import.ImportInProgress) as exc:
        raise ToolError(str(exc)) from exc
    audit.record(
        call.repositories,
        call.context,
        "import.started",
        target_type="import",
        target_id=job.import_id,
        target_label="Jira",
        after=jira_import.audit_after(job),
    )
    return IssueImportRead.from_job(job).model_dump(mode="json")


JIRA_IMPORT_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_jira_projects",
        description=(
            "The projects an Atlassian account can browse on a Jira Cloud site, with their keys and names, to "
            "choose what import_jira_workspace imports. Signs in with the account email and an API token, which "
            "are not stored. Needs workspace owner or admin."
        ),
        scopes=("settings:write", "admin"),
        schema=object_schema(CREDENTIAL_PROPERTIES, required=REQUIRED),
        handler=_list_jira_projects,
    ),
    Tool(
        name="preview_jira_import",
        description=(
            "Dry run a Jira import without writing anything: each chosen project or JQL filter's issue count, "
            "every Jira status and the team status it lands in, and the story point and sprint fields found. "
            "Needs workspace owner or admin."
        ),
        scopes=("settings:write", "admin"),
        schema=object_schema(IMPORT_PROPERTIES, required=(*REQUIRED, "projects")),
        handler=_preview_jira_import,
    ),
    Tool(
        name="import_jira_workspace",
        description=(
            "Start an import from Jira Cloud: each chosen project or JQL filter's issues become issues in an "
            "existing Standupless team (create_team first for a new one). Issue types and Jira labels become "
            "labels, statuses map by status category, epics become projects or parent issues, sprints become "
            "cycles, sub-tasks become sub-issues, issue links become relations, story points become estimates, "
            "and comments come across as markdown. People are matched by email. Running it again updates what "
            "an earlier import wrote instead of duplicating it. Runs in the background; poll "
            "get_workspace_import. Needs workspace owner or admin."
        ),
        scopes=("settings:write", "admin"),
        schema=object_schema(IMPORT_PROPERTIES, required=(*REQUIRED, "projects")),
        handler=_import_jira_workspace,
    ),
)
