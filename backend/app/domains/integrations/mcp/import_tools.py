"""The MCP tools for importing a file, a Linear or Shortcut workspace or GitHub Issues, and following or stopping one.

They run the same `app.common.issue_import`, `app.common.linear_import` and
`github_import` functions as the import routes and check the same workspace
admin capability, so an agent can move a team off Linear or GitHub Issues
exactly as an admin can in the app. The Linear key an agent passes is used for
that call, sealed while the job runs and deleted when it ends, and never comes
back in an answer. A GitHub import needs no key: it reads through the
workspace's installed GitHub App. A Shortcut API token is handled exactly as a
Linear key is, and its preview answers what the chosen teams would bring over
without writing. A file import takes the CSV export of Jira,
Linear, Asana, Shortcut or Pivotal Tracker, any other CSV, or a Trello board's
JSON, with the same preset and mapping the import settings screen offers, and
its dry run writes nothing.
"""

from __future__ import annotations

from typing import Any

from app.common import audit, issue_import, linear_import
from app.common.api.dependencies.authz import Capability, check_capability
from app.common.csv_import import IMPORT_FIELDS, PRESETS, CsvRejected
from app.common.issue_rules import require_team_member
from app.common.linear_api import LinearAuthFailed, LinearError
from app.domains.integrations import github_import, shortcut_import
from app.domains.integrations.mcp.toolkit import (
    NOT_VISIBLE,
    Tool,
    ToolCall,
    enum,
    object_schema,
    string,
    team_id_ref,
)
from app.domains.integrations.mcp.transport import ToolError
from app.domains.integrations.schemas.imports import (
    IssueImportPreviewRead,
    IssueImportRead,
    ShortcutImportPreviewRead,
    ShortcutPreviewTeamRead,
)
from app.domains.integrations.shortcut_api import ShortcutAuthFailed, ShortcutError

KEY_ARGUMENT = "A Linear personal API key with read access. Used for this import only and never stored after it."

TEAMS_SCHEMA: dict[str, Any] = {
    "type": "array",
    "minItems": 1,
    "items": {
        "type": "object",
        "properties": {
            "linear_team_id": string("The Linear team id list_linear_teams answered"),
            "team_id": string("The Standupless team it goes into: id, key such as ENG, or name"),
            "create_statuses": {
                "type": "boolean",
                "description": "Create a status for each Linear workflow state the team has no status of the "
                "same name for, before the issues import. Defaults to false",
            },
            "import_templates": {
                "type": "boolean",
                "description": "Bring the Linear team's issue templates over, skipping names the team already "
                "has. Defaults to false",
            },
        },
        "required": ["linear_team_id", "team_id"],
    },
    "description": "Each Linear team to import and the Standupless team it goes into",
}

SHORTCUT_TOKEN_ARGUMENT = (
    "A Shortcut API token from Settings, API Tokens. Used for this import only and never stored after it."
)

SHORTCUT_TEAMS_SCHEMA: dict[str, Any] = {
    "type": "array",
    "minItems": 1,
    "items": {
        "type": "object",
        "properties": {
            "shortcut_team_id": string("The Shortcut team id list_shortcut_teams answered"),
            "team_id": string("The Standupless team it goes into: id, key such as ENG, or name"),
        },
        "required": ["shortcut_team_id", "team_id"],
    },
    "description": "Each Shortcut team to import and the Standupless team it goes into",
}

FILE_PROPERTIES: dict[str, Any] = {
    "team_id": string("The Standupless team the issues go into: id, key such as ENG, or name"),
    "preset": enum(
        PRESETS,
        "Whose export the file is: jira, linear, asana, shortcut or pivotal for their CSV exports, trello for a "
        "board's JSON export, generic for any other CSV. Picks the columns each field is read from",
    ),
    "file": string("The whole file as text: a CSV with its header row first, or for trello the board's JSON"),
    "file_name": string("The file's name, shown on the import"),
    "mapping": {
        "type": "object",
        "additionalProperties": {"type": ["string", "null"]},
        "description": (
            "Overrides of the preset's mapping, field to header name; null unmaps a field. Fields: "
            + ", ".join(IMPORT_FIELDS)
        ),
    },
}


def _linear_error(exc: LinearError) -> ToolError:
    """A Linear failure as a tool error that never carries the key."""
    if isinstance(exc, LinearAuthFailed):
        return ToolError("Linear refused the API key. Check it has read access and has not been revoked.")
    return ToolError("Linear did not answer, try again shortly.")


def _job_json(job: issue_import.ImportJob) -> dict[str, Any]:
    """One import as the tools answer it, the same shape the import routes answer."""
    return IssueImportRead.from_job(job).model_dump(mode="json")


def _file_arguments(call: ToolCall) -> tuple[str, str, str, Any]:
    """The team, preset, file text and mapping a file import names, checked for the caller."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    preset = str(call.optional("preset", "generic")).strip()
    if preset not in PRESETS:
        raise ToolError(f"preset is one of {', '.join(PRESETS)}")
    mapping = call.optional("mapping")
    if mapping is not None and not isinstance(mapping, dict):
        raise ToolError("mapping is an object of field to header name")
    team_id = team_id_ref(call, str(call.require("team_id")).strip())
    require_team_member(call.repositories, call.context, team_id)
    return team_id, preset, str(call.require("file")), mapping


def _preview_issue_import(call: ToolCall) -> Any:
    """What importing a file into a team would do, row by row, writing nothing."""
    team_id, preset, text, mapping = _file_arguments(call)
    try:
        preview = issue_import.preview_import(
            call.repositories, call.context.workspace_id, team_id, preset, text, mapping
        )
    except CsvRejected as exc:
        raise ToolError(str(exc)) from None
    return IssueImportPreviewRead.from_preview(preview).model_dump(mode="json")


def _import_issues_from_file(call: ToolCall) -> Any:
    """Queue an import of a file into one team."""
    team_id, preset, text, mapping = _file_arguments(call)
    file_name = str(call.optional("file_name", "")).strip()
    try:
        job = issue_import.start_import(
            call.repositories, call.context, team_id, preset, text, mapping, file_name=file_name
        )
    except CsvRejected as exc:
        raise ToolError(str(exc)) from None
    except (issue_import.ImportUnavailable, issue_import.ImportInProgress) as exc:
        raise ToolError(str(exc)) from exc
    audit.record(
        call.repositories,
        call.context,
        "import.started",
        target_type="import",
        target_id=job.import_id,
        target_label=job.file_name,
        after={"team_id": job.team_id, "preset": job.preset, "total_rows": job.total_rows},
    )
    return _job_json(job)


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
    choices: list[tuple[str, str, bool, bool]] = []
    for item in call.require("teams"):
        if not isinstance(item, dict):
            raise ToolError("each teams entry needs linear_team_id and team_id")
        linear_team_id = str(item.get("linear_team_id") or "").strip()
        team = str(item.get("team_id") or "").strip()
        if not linear_team_id or not team:
            raise ToolError("each teams entry needs linear_team_id and team_id")
        team_id = team_id_ref(call, team)
        require_team_member(call.repositories, call.context, team_id)
        choices.append(
            (linear_team_id, team_id, item.get("create_statuses") is True, item.get("import_templates") is True)
        )
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


def _shortcut_error(exc: ShortcutError) -> ToolError:
    """A Shortcut failure as a tool error that never carries the token."""
    if isinstance(exc, ShortcutAuthFailed):
        return ToolError("Shortcut refused the API token. Check it is current and has not been revoked.")
    return ToolError("Shortcut did not answer, try again shortly.")


def _list_shortcut_teams(call: ToolCall) -> Any:
    """The Shortcut teams a token can read."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    try:
        teams = shortcut_import.read_teams(str(call.require("api_token")).strip())
    except ShortcutError as exc:
        raise _shortcut_error(exc) from None
    return {"teams": [{"id": team["id"], "key": team["key"], "name": team["name"]} for team in teams]}


def _shortcut_arguments(call: ToolCall) -> tuple[str, list[shortcut_import.SourceTeamMapping]]:
    """The token and checked team mapping a Shortcut import or preview names."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    token = str(call.require("api_token")).strip()
    choices: list[tuple[str, str]] = []
    for item in call.require("teams"):
        if not isinstance(item, dict):
            raise ToolError("each teams entry needs shortcut_team_id and team_id")
        shortcut_team_id = str(item.get("shortcut_team_id") or "").strip()
        team = str(item.get("team_id") or "").strip()
        if not shortcut_team_id or not team:
            raise ToolError("each teams entry needs shortcut_team_id and team_id")
        team_id = team_id_ref(call, team)
        require_team_member(call.repositories, call.context, team_id)
        choices.append((shortcut_team_id, team_id))
    try:
        return token, shortcut_import.team_mappings(token, choices)
    except ShortcutError as exc:
        raise _shortcut_error(exc) from None
    except shortcut_import.UnknownShortcutTeam:
        raise ToolError("A chosen Shortcut team is not readable with this token, or was chosen twice") from None


def _preview_shortcut_import(call: ToolCall) -> Any:
    """What importing Shortcut teams would bring over, writing nothing."""
    token, mappings = _shortcut_arguments(call)
    try:
        teams = shortcut_import.preview(call.repositories, call.context.workspace_id, token, mappings)
    except ShortcutError as exc:
        raise _shortcut_error(exc) from None
    return ShortcutImportPreviewRead(teams=[ShortcutPreviewTeamRead(**team) for team in teams]).model_dump(mode="json")


def _import_shortcut_workspace(call: ToolCall) -> Any:
    """Queue an import of Shortcut teams into Standupless teams."""
    token, mappings = _shortcut_arguments(call)
    try:
        job = shortcut_import.start_shortcut_import(call.repositories, call.context, token, mappings)
    except ShortcutError as exc:
        raise _shortcut_error(exc) from None
    except (issue_import.ImportUnavailable, issue_import.ImportInProgress) as exc:
        raise ToolError(str(exc)) from exc
    audit.record(
        call.repositories,
        call.context,
        "import.started",
        target_type="import",
        target_id=job.import_id,
        target_label="Shortcut",
        after={
            "preset": job.preset,
            "teams": [
                {"shortcut_team": mapping.key or mapping.source_id, "team_id": mapping.team_id} for mapping in mappings
            ],
        },
    )
    return _job_json(job)


def _list_github_import_repositories(call: ToolCall) -> Any:
    """The repositories the installed GitHub App covers."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    rows = github_import.importable_repositories(call.repositories, call.context.workspace_id)
    return {
        "repositories": [
            {
                "repository_id": row.repository_id,
                "full_name": row.full_name,
                "private": row.private,
                "team_id": row.team_id,
            }
            for row in rows
        ]
    }


def _import_github_issues(call: ToolCall) -> Any:
    """Queue an import of one repository's Issues into one team."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    repository_id = str(call.require("repository_id")).strip()
    if not repository_id.isdigit():
        raise ToolError("repository_id is the numeric id list_github_import_repositories answered")
    team_id = team_id_ref(call, str(call.require("team_id")).strip())
    require_team_member(call.repositories, call.context, team_id)
    try:
        job = github_import.start_github_import(call.repositories, call.context, team_id, repository_id)
    except github_import.RepositoryNotAvailable as exc:
        raise ToolError(str(exc)) from None
    except (issue_import.ImportUnavailable, issue_import.ImportInProgress) as exc:
        raise ToolError(str(exc)) from exc
    audit.record(
        call.repositories,
        call.context,
        "import.started",
        target_type="import",
        target_id=job.import_id,
        target_label=job.file_name,
        after={"preset": job.preset, "team_id": job.team_id, "repository_id": job.github_repository_id},
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
        name="preview_issue_import",
        description=(
            "Dry run a file import into one team without writing anything: the column each field maps to, how "
            "many rows import, each row's problems, the labels it would create and where each source status "
            "lands. Takes the CSV export of Jira, Linear, Asana, Shortcut or Pivotal Tracker, any other CSV, or "
            "a Trello board's JSON. Needs workspace owner or admin."
        ),
        scopes=("settings:read", "admin"),
        schema=object_schema(FILE_PROPERTIES, required=("team_id", "file")),
        handler=_preview_issue_import,
    ),
    Tool(
        name="import_issues_from_file",
        description=(
            "Start an import of a file into one team, as preview_issue_import reads it: the CSV export of Jira, "
            "Linear, Asana, Shortcut or Pivotal Tracker, any other CSV, or a Trello board's JSON, whose checklist "
            "items become sub-issues. People are matched by email, then display name. Runs in the background; "
            "poll get_workspace_import. Needs workspace owner or admin."
        ),
        scopes=("settings:write", "admin"),
        schema=object_schema(FILE_PROPERTIES, required=("team_id", "file")),
        handler=_import_issues_from_file,
    ),
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
        name="list_shortcut_teams",
        description=(
            "The teams a Shortcut API token can read, with their ids, mention names and names, to choose what "
            "import_shortcut_workspace imports. The token is not stored. Needs workspace owner or admin."
        ),
        scopes=("settings:write", "admin"),
        schema=object_schema({"api_token": string(SHORTCUT_TOKEN_ARGUMENT)}, required=("api_token",)),
        handler=_list_shortcut_teams,
    ),
    Tool(
        name="preview_shortcut_import",
        description=(
            "Dry run a Shortcut import without writing anything: per chosen team, how many stories, epics and "
            "iterations come over, where each workflow state lands, the labels it would create and how many "
            "story owners match a member by email. Needs workspace owner or admin."
        ),
        scopes=("settings:write", "admin"),
        schema=object_schema(
            {"api_token": string(SHORTCUT_TOKEN_ARGUMENT), "teams": SHORTCUT_TEAMS_SCHEMA},
            required=("api_token", "teams"),
        ),
        handler=_preview_shortcut_import,
    ),
    Tool(
        name="import_shortcut_workspace",
        description=(
            "Start an import from Shortcut: each chosen Shortcut team's stories with labels, owners, estimates, "
            "comments, tasks, sub-task stories and story links, its epics as projects and its iterations as "
            "cycles, into existing Standupless teams (create_team first for a new one). People are matched by "
            "email. Running it again updates what an earlier import wrote instead of duplicating it. Runs in the "
            "background; poll get_workspace_import. Needs workspace owner or admin."
        ),
        scopes=("settings:write", "admin"),
        schema=object_schema(
            {"api_token": string(SHORTCUT_TOKEN_ARGUMENT), "teams": SHORTCUT_TEAMS_SCHEMA},
            required=("api_token", "teams"),
        ),
        handler=_import_shortcut_workspace,
    ),
    Tool(
        name="list_github_import_repositories",
        description=(
            "The repositories the workspace's installed GitHub App covers, with their ids, full names and the team "
            "each is pinned to, to choose what import_github_issues imports. Empty when the App is not installed "
            "or is suspended. Needs workspace owner or admin."
        ),
        scopes=("settings:read", "admin"),
        schema=object_schema({}),
        handler=_list_github_import_repositories,
    ),
    Tool(
        name="import_github_issues",
        description=(
            "Start an import of one GitHub repository's Issues, with labels, assignees and comments, into an "
            "existing Standupless team, through the installed GitHub App. Pull requests are skipped. People are "
            "matched by linked GitHub account, then email, then login. Running it again updates what an earlier "
            "import wrote instead of duplicating it. Runs in the background; poll get_workspace_import. Needs "
            "workspace owner or admin."
        ),
        scopes=("settings:write", "admin"),
        schema=object_schema(
            {
                "repository_id": string("The repository_id list_github_import_repositories answered"),
                "team_id": string("The Standupless team the issues go into: id, key such as ENG, or name"),
            },
            required=("repository_id", "team_id"),
        ),
        handler=_import_github_issues,
    ),
    Tool(
        name="get_workspace_import",
        description=(
            "One import's status, phase, tallies and the problems it kept, for a Linear, Shortcut, GitHub or CSV "
            "import. Needs workspace owner or admin."
        ),
        scopes=("settings:read", "admin"),
        schema=object_schema(
            {"import_id": string("The import_id an import tool answered")},
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
            {"import_id": string("The import_id an import tool answered")},
            required=("import_id",),
        ),
        handler=_cancel_workspace_import,
        idempotent=True,
    ),
)
