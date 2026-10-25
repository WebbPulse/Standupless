"""The pieces every MCP tool module shares: the tool record, the call, schemas and shapes.

Split from the tool modules so each of them can build on one definition of what a
tool is and how it answers, and so the error mapping that turns a route's
`HTTPException` into a tool error lives in one place. The tools call the same
`app.common` write and read paths the routes do, and those raise the routes'
errors, so the mapping is what lets a tool reuse them without catching each one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional

from fastapi import HTTPException
from pydantic import ValidationError

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.planning import project_slug_id
from app.common.api.schemas.projects_display import PROJECTS_COLUMNS, PROJECTS_DISPLAY_FIELDS
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.teams import Team, TeamRepository
from app.common.issue_keys import current
from app.common.issue_move import find_issue_by_number
from app.common.issue_rules import TRIAGE_STATUS_NAME, load_visible_issue, shown_status_id
from app.common.issue_rules import not_found as issue_not_found
from app.common.plan_features import PLAN_FEATURE_UNAVAILABLE
from app.common.plan_limits import PLAN_LIMIT_REACHED
from app.common.planning_rules import visible_project_teams, visible_team_ids
from app.common.sla import sla_status
from app.common.team_refs import TEAM_NOT_FOUND_CODE, find_team, team_not_found_message
from app.common.team_retirement import refuse_if_retired
from app.domains.integrations.mcp.arguments import client_schema, with_alternatives
from app.domains.integrations.mcp.transport import ToolError

MAX_RESULTS = 50

DEFAULT_RESULTS = 20

PRIORITIES = ("none", "urgent", "high", "medium", "low")

NOT_VISIBLE = "Not found, or not visible to this credential"


@dataclass(frozen=True)
class Tool:
    """One callable tool: its schema, the scopes it needs, and its handler.

    `destructive` marks a tool that deletes or removes something, which clients use
    to ask the person before calling it, and `idempotent` one whose repeat call
    changes nothing further. Whether a tool only reads is derived from its scopes, so
    the hint cannot drift from what the credential is checked for.
    `administers_team` marks a team settings or membership tool, which a workspace
    admin may call on a private team they are outside.
    """

    name: str
    description: str
    scopes: tuple[str, ...]
    schema: Mapping[str, Any]
    handler: Callable[["ToolCall"], Any]
    destructive: bool = False
    idempotent: bool = False
    administers_team: bool = False

    @property
    def read_only(self) -> bool:
        """Whether every scope this tool needs is a read scope."""
        return all(scope.endswith(":read") for scope in self.scopes)

    def descriptor(self) -> dict[str, Any]:
        """This tool as `tools/list` renders it, with its behaviour hints."""
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": client_schema(self.schema),
            "annotations": {
                "readOnlyHint": self.read_only,
                "destructiveHint": self.destructive,
                "idempotentHint": self.idempotent,
                "openWorldHint": False,
            },
        }


@dataclass(frozen=True)
class ToolCall:
    """Everything one tool invocation needs, resolved once by the transport."""

    context: AuthzContext
    repositories: Repositories
    arguments: Mapping[str, Any]

    def require(self, name: str) -> Any:
        """One required argument, or a tool error naming it."""
        value = self.arguments.get(name)
        if value is None or (isinstance(value, str) and not value.strip()):
            raise ToolError(f"{name} is required")
        return value

    def optional(self, name: str, default: Any = None) -> Any:
        """One optional argument, or the default."""
        value = self.arguments.get(name)
        return default if value is None else value

    def present(self, name: str) -> bool:
        """Whether the caller named this argument at all, null included.

        A patch tool needs the difference: an absent field is left alone, while an
        explicit null clears it.
        """
        return name in self.arguments


def object_schema(properties: Mapping[str, Any], required: tuple[str, ...] = ()) -> dict[str, Any]:
    """A JSON Schema object, in the one shape every tool's schema takes.

    An `issue_id` or `target_issue_id` property brings its key alternative with it,
    so every tool that acts on an issue takes its key without declaring it.
    """
    schema: dict[str, Any] = {"type": "object", "properties": with_alternatives(properties)}
    if required:
        schema["required"] = list(required)
    schema["additionalProperties"] = False
    return schema


def string(description: str) -> dict[str, Any]:
    """A string property carrying its description."""
    return {"type": "string", "description": description}


def nullable(description: str) -> dict[str, Any]:
    """A string property that also takes null, which clears the field it names."""
    return {"type": ["string", "null"], "description": description}


def one_or_many(description: str) -> dict[str, Any]:
    """A filter property taking one string or a list of them, ORed."""
    return {
        "description": description,
        "anyOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}],
    }


def enum(values: tuple[str, ...], description: str) -> dict[str, Any]:
    """A string property narrowed to a fixed set."""
    return {"type": "string", "enum": list(values), "description": description}


def nullable_enum(values: tuple[str, ...], description: str) -> dict[str, Any]:
    """A string property narrowed to a fixed set that also takes null, which clears it."""
    return {"type": ["string", "null"], "enum": [*values, None], "description": description}


def projects_display_schema(description: str, *, clearable: bool = False) -> dict[str, Any]:
    """A projects page arrangement, each field one of the page's choices, null allowed when it clears."""
    return {
        "type": ["object", "null"] if clearable else "object",
        "properties": {
            **{field: {"type": "string", "enum": list(choices)} for field, choices in PROJECTS_DISPLAY_FIELDS.items()},
            "columns": {
                "type": "array",
                "items": {"type": "string", "enum": list(PROJECTS_COLUMNS)},
                "description": "The properties shown beside the name; an empty list shows the name alone",
            },
        },
        "additionalProperties": False,
        "description": description,
    }


def string_list(description: str) -> dict[str, Any]:
    """A list of strings, such as label or team ids."""
    return {"type": "array", "items": {"type": "string"}, "description": description}


def page_properties() -> dict[str, Any]:
    """The cursor and limit every paged listing takes."""
    return {
        "cursor": string("The next_cursor a previous page answered, to read the page after it"),
        "limit": {"type": "integer", "minimum": 1, "maximum": MAX_RESULTS, "description": "Page size"},
    }


def limit(value: Any) -> int:
    """A result limit clamped to the tool's own bounds."""
    try:
        candidate = int(value)
    except (TypeError, ValueError):
        return DEFAULT_RESULTS
    return max(1, min(candidate, MAX_RESULTS))


def filter_values(value: Any) -> Optional[list[str]]:
    """One filter argument as a list of strings, whichever shape the agent sent."""
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        return [str(item) for item in value if item is not None]
    return [str(value)]


def resolve_user(call: ToolCall, value: Any) -> Optional[str]:
    """A user argument with `me` resolved to the caller, or `None` for null."""
    if value is None:
        return None
    candidate = str(value)
    return call.context.user_id if candidate == "me" else candidate


def team_ref(call: ToolCall, value: Any, *, administer: bool = False) -> Team:
    """One visible team named by its id, its key prefix or its name.

    An agent holds whichever a person wrote, ENG or Engineering, or the id a listing
    answered. An invisible team and an unknown one answer the same message naming
    the reference, so a name cannot be used to probe for teams outside a guest's
    reach, yet the answer does not read as a permissions problem. `administer`
    also admits a private team a workspace admin is outside, for the admin tools.
    """
    reference = str(value).strip()
    if not reference:
        raise ToolError("team is required")
    workspace_id = call.context.workspace_id
    team = find_team(call.repositories.teams, workspace_id, reference)
    if team is None:
        folded = reference.casefold()
        rows = call.repositories.teams.list_for_workspace(workspace_id)
        named = [row for row in rows if row.name.casefold() == folded]
        team = named[0] if len(named) == 1 else None
    visible = call.context.can_find_team if administer else call.context.can_see_team
    if team is None or not visible(team.team_id):
        raise ToolError(team_not_found_message(reference))
    return team


def team_id_ref(call: ToolCall, value: Any) -> str:
    """The id of one visible team named by its id, key prefix or name."""
    return team_ref(call, value).team_id


def resolve_team_arguments(call: ToolCall, *, administer: bool = False, writes: bool = False) -> ToolCall:
    """The call with every `team_id` and `team_ids` argument resolved to team ids.

    The one place a tool's team reference is read, so every tool accepts an id, a
    key prefix such as SUP or a name without resolving it itself. A null is left
    alone, because on a patch it clears the field rather than naming a team.
    `administer` also resolves a private team a workspace admin is outside, for
    the tools that manage a team's settings and members. `writes` refuses a
    `team_id` naming a retired team, which is read-only.
    """
    arguments = dict(call.arguments)
    value = arguments.get("team_id")
    if isinstance(value, str) and value.strip():
        team = team_ref(call, value, administer=administer)
        if writes:
            refuse_if_retired(team)
        arguments["team_id"] = team.team_id
    values = arguments.get("team_ids")
    if isinstance(values, list):
        arguments["team_ids"] = [
            team_id_ref(call, item) if isinstance(item, str) and item.strip() else item for item in values
        ]
    return ToolCall(context=call.context, repositories=call.repositories, arguments=arguments)


def ambiguous(kind: str, reference: str) -> ToolError:
    """The error a name matching more than one visible row answers."""
    return ToolError(f"More than one {kind} is named {reference}; pass its id instead")


def project_id_ref(call: ToolCall, value: Any) -> str:
    """A project id from an id, a name or a short id unique among the projects the caller can see.

    Only projects on a visible team are matched by name, so a name cannot probe for
    a project outside the caller's reach. An id is passed through for the write or
    read path to hold to visibility itself.
    """
    reference = str(value).strip()
    if not reference:
        raise ToolError("project_id is required")
    workspace_id = call.context.workspace_id
    if call.repositories.planning.get_project(workspace_id, reference) is not None:
        return reference
    visible = set(visible_team_ids(call.repositories, call.context))
    folded = reference.casefold()
    named = [
        row
        for row in call.repositories.planning.list_projects(workspace_id)
        if row.name.casefold() == folded and visible_project_teams(row, visible)
    ]
    if not named:
        named = [
            row
            for row in call.repositories.planning.list_projects(workspace_id)
            if project_slug_id(row.project_id) == folded and visible_project_teams(row, visible)
        ]
    if len(named) > 1:
        raise ambiguous("project", reference)
    if not named:
        raise ToolError(NOT_VISIBLE)
    return named[0].project_id


def initiative_id_ref(call: ToolCall, value: Any) -> str:
    """An initiative id from an id or a name unique within the workspace.

    A guest is never matched, since initiatives span the workspace and a guest is
    refused every one of them.
    """
    reference = str(value).strip()
    if not reference:
        raise ToolError("initiative_id is required")
    if call.context.is_guest:
        raise ToolError(NOT_VISIBLE)
    workspace_id = call.context.workspace_id
    if call.repositories.planning.get_initiative(workspace_id, reference) is not None:
        return reference
    folded = reference.casefold()
    named = [row for row in call.repositories.planning.list_initiatives(workspace_id) if row.name.casefold() == folded]
    if len(named) > 1:
        raise ambiguous("initiative", reference)
    if not named:
        raise ToolError(NOT_VISIBLE)
    return named[0].initiative_id


def user_ref(call: ToolCall, value: Any) -> str:
    """A workspace member's user id from `me`, an id or an email address.

    Only members of this workspace resolve, so an email cannot be used to learn
    whether somebody outside it has an account.
    """
    reference = str(value).strip()
    if not reference:
        raise ToolError("user is required")
    if reference == "me":
        return call.context.user_id
    workspace_id = call.context.workspace_id
    if "@" in reference:
        user = call.repositories.users.get_by_email(reference.lower())
        if user is None or call.repositories.memberships.get(workspace_id, user.id) is None:
            raise ToolError(NOT_VISIBLE)
        return user.id
    if call.repositories.memberships.get(workspace_id, reference) is None:
        raise ToolError(NOT_VISIBLE)
    return reference


def issue_by_key(call: ToolCall, key: str, *, include_deleted: bool = False) -> Issue:
    """One issue by its human key, resolved through its team's prefix.

    Visibility is the issue's own team's, so a key held before a move answers the
    issue where it now lives, and an unknown prefix answers the same not-found an
    invisible issue does, so keys cannot be used to probe for teams. A deleted
    issue resolves only with `include_deleted`.
    """
    prefix, _, number = key.rpartition("-")
    if not prefix or not number.isdigit():
        raise ToolError("An issue key looks like ABC-123")

    team = call.repositories.teams.get_by_key_prefix(call.context.workspace_id, prefix.upper())
    if team is None:
        raise issue_not_found()

    issue = find_issue_by_number(
        call.repositories, call.context.workspace_id, team.team_id, int(number), include_deleted=include_deleted
    )
    if issue is None or not call.context.can_see_team(issue.team_id):
        raise issue_not_found()
    return issue


def issue_ref(call: ToolCall, value: Any, *, include_deleted: bool = False) -> Issue:
    """One visible issue named by its id or its key.

    Both spellings because an agent reading a conversation has the key a person
    wrote and an agent chaining calls has the id a previous tool answered. Ids are
    ULIDs and carry no dash, so the two cannot be confused. A deleted issue
    resolves only with `include_deleted`, which the read and restore tools pass.
    """
    reference = str(value).strip()
    if "-" in reference:
        return issue_by_key(call, reference, include_deleted=include_deleted)
    return load_visible_issue(call.repositories, call.context, reference, include_deleted=include_deleted)


def issue_id_ref(call: ToolCall, value: Any) -> Optional[str]:
    """An issue id from an id or a key, leaving null as null.

    Used for arguments such as `parent_id` that the write path validates itself,
    so only a key needs resolving here.
    """
    if value is None:
        return None
    reference = str(value).strip()
    if "-" in reference:
        return issue_by_key(call, reference).issue_id
    return reference


def issue_json(teams: TeamRepository, issue: Issue, *, status_name: str = "") -> dict[str, Any]:
    """One issue as a tool answers it, under its team's current key.

    Ids are included here, unlike in the public share shapes, because the caller is
    inside the workspace and needs them to make the next call. What bounds this
    credential is its scopes and its membership, not the ids it can see. An issue
    waiting in triage reports the synthetic triage status, as every client shows it.
    """
    issue = current(teams, issue)
    return {
        "issue_id": issue.issue_id,
        "issue_key": issue.key,
        "team_id": issue.team_id,
        "title": issue.title,
        "body": issue.body or "",
        "status_id": shown_status_id(issue),
        "status": TRIAGE_STATUS_NAME if issue.in_triage else status_name,
        "priority": issue.priority,
        "assignee_id": issue.assignee_id,
        "label_ids": list(issue.label_ids),
        "estimate": issue.estimate,
        "start_date": issue.start_date,
        "due_date": issue.due_date,
        "parent_id": issue.parent_id,
        "cycle_id": issue.cycle_id,
        "project_id": issue.project_id,
        "project_milestone_id": issue.project_milestone_id,
        "created_at": issue.created_at.isoformat(),
        "updated_at": issue.updated_at.isoformat(),
        "archived_at": issue.archived_at.isoformat() if issue.archived_at else None,
        "deleted_at": issue.deleted_at.isoformat() if issue.deleted_at else None,
        "deleted_by": issue.deleted_by,
        "in_triage": issue.in_triage,
        "snoozed_until": issue.snoozed_until.isoformat() if issue.snoozed_until else None,
        "sla_started_at": issue.sla_started_at.isoformat() if issue.sla_started_at else None,
        "sla_breaches_at": issue.sla_breaches_at.isoformat() if issue.sla_breaches_at else None,
        "sla_paused_at": issue.sla_paused_at.isoformat() if issue.sla_paused_at else None,
        "sla_status": sla_status(issue),
        "started_at": issue.started_at.isoformat() if issue.started_at else None,
        "completed_at": issue.completed_at.isoformat() if issue.completed_at else None,
        "cancelled_at": issue.cancelled_at.isoformat() if issue.cancelled_at else None,
        "status_changed_at": issue.entered_status_at().isoformat(),
        "external_ref": issue.external_ref,
    }


def summary_json(teams: TeamRepository, issue: Issue, parent: Optional[Issue] = None) -> dict[str, Any]:
    """One issue as a listing renders it, under its team's current key and the synthetic triage status in triage.

    Given its `parent`, a sub-issue also names the parent's key and title, so a
    listing that leaves the parent out still says whose step the row is.
    """
    issue = current(teams, issue)
    named = parent if parent is not None and parent.issue_id == issue.parent_id else None
    return {
        "issue_id": issue.issue_id,
        "issue_key": issue.key,
        "team_id": issue.team_id,
        "title": issue.title,
        "status_id": shown_status_id(issue),
        "in_triage": issue.in_triage,
        "priority": issue.priority,
        "estimate": issue.estimate,
        "assignee_id": issue.assignee_id,
        "parent_id": issue.parent_id,
        "parent_key": named.key if named is not None else None,
        "parent_title": named.title if named is not None else None,
        "cycle_id": issue.cycle_id,
        "project_id": issue.project_id,
        "updated_at": issue.updated_at.isoformat(),
        "archived_at": issue.archived_at.isoformat() if issue.archived_at else None,
        "sla_breaches_at": issue.sla_breaches_at.isoformat() if issue.sla_breaches_at else None,
        "sla_status": sla_status(issue),
        "started_at": issue.started_at.isoformat() if issue.started_at else None,
        "completed_at": issue.completed_at.isoformat() if issue.completed_at else None,
        "cancelled_at": issue.cancelled_at.isoformat() if issue.cancelled_at else None,
    }


PLAN_REFUSAL_CODES: frozenset[str] = frozenset({PLAN_FEATURE_UNAVAILABLE, PLAN_LIMIT_REACHED})
"""The error codes that mean the workspace plan, not the credential, refused a write."""


def http_error_message(exc: HTTPException) -> str:
    """The tool error text one route error becomes.

    A 404 keeps the routes' rule that invisible and absent look the same, except a
    team's, whose message already names the reference and nothing more. A plan
    refusal says what the plan lacks and carries its code, so a caller with the
    role is not sent chasing credentials. Any other 403 says the credential may not
    write there. Anything else carries the route's own message, which is written
    for a person and reads as well to a model.
    """
    detail = exc.detail
    message = detail.get("message") if isinstance(detail, Mapping) else detail
    code = detail.get("error_code") if isinstance(detail, Mapping) else None
    text = str(message) if message else "The request was refused"
    if exc.status_code == 404 and code != TEAM_NOT_FOUND_CODE:
        return NOT_VISIBLE
    if code in PLAN_REFUSAL_CODES:
        return f"{text} ({code})"
    if exc.status_code == 403:
        return f"This credential may not write there. {text}"
    return text


def validation_message(exc: ValidationError) -> str:
    """A payload validation failure as one line naming each bad field."""
    parts = []
    for error in exc.errors():
        field = ".".join(str(part) for part in error.get("loc", ()))
        parts.append(f"{field}: {error.get('msg', 'invalid')}" if field else str(error.get("msg", "invalid")))
    return "; ".join(parts) or "The arguments are invalid"
