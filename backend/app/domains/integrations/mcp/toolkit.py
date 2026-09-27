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
from app.common.db.dynamo.issues import Issue
from app.common.issue_rules import load_visible_issue
from app.common.issue_rules import not_found as issue_not_found
from app.domains.integrations.mcp.transport import ToolError

MAX_RESULTS = 50

DEFAULT_RESULTS = 20

PRIORITIES = ("none", "urgent", "high", "medium", "low")

NOT_VISIBLE = "Not found, or not visible to this credential"


@dataclass(frozen=True)
class Tool:
    """One callable tool: its schema, the scopes it needs, and its handler."""

    name: str
    description: str
    scopes: tuple[str, ...]
    schema: Mapping[str, Any]
    handler: Callable[["ToolCall"], Any]

    def descriptor(self) -> dict[str, Any]:
        """This tool as `tools/list` renders it."""
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": dict(self.schema),
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
    """A JSON Schema object, in the one shape every tool's schema takes."""
    schema: dict[str, Any] = {"type": "object", "properties": dict(properties)}
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


def issue_by_key(call: ToolCall, key: str) -> Issue:
    """One issue by its human key, resolved through its team's prefix.

    Visibility is the key's team's, and an unknown prefix answers the same
    not-found an invisible issue does, so keys cannot be used to probe for teams.
    """
    prefix, _, number = key.rpartition("-")
    if not prefix or not number.isdigit():
        raise ToolError("An issue key looks like ABC-123")

    team = call.repositories.teams.get_by_key_prefix(call.context.workspace_id, prefix.upper())
    if team is None or not call.context.can_see_team(team.team_id):
        raise issue_not_found()

    issue = call.repositories.issues.get_by_number(call.context.workspace_id, team.team_id, int(number))
    if issue is None:
        raise issue_not_found()
    return issue


def issue_ref(call: ToolCall, value: Any) -> Issue:
    """One visible issue named by its id or its key.

    Both spellings because an agent reading a conversation has the key a person
    wrote and an agent chaining calls has the id a previous tool answered. Ids are
    ULIDs and carry no dash, so the two cannot be confused.
    """
    reference = str(value).strip()
    if "-" in reference:
        return issue_by_key(call, reference)
    return load_visible_issue(call.repositories, call.context, reference)


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


def issue_json(issue: Issue, *, status_name: str = "") -> dict[str, Any]:
    """One issue as a tool answers it.

    Ids are included here, unlike in the public share shapes, because the caller is
    inside the workspace and needs them to make the next call. What bounds this
    credential is its scopes and its membership, not the ids it can see.
    """
    return {
        "issue_id": issue.issue_id,
        "issue_key": issue.key,
        "team_id": issue.team_id,
        "title": issue.title,
        "body": issue.body or "",
        "status_id": issue.status_id,
        "status": status_name,
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
    }


def summary_json(issue: Issue) -> dict[str, Any]:
    """One issue as a listing renders it."""
    return {
        "issue_id": issue.issue_id,
        "issue_key": issue.key,
        "team_id": issue.team_id,
        "title": issue.title,
        "status_id": issue.status_id,
        "priority": issue.priority,
        "assignee_id": issue.assignee_id,
        "parent_id": issue.parent_id,
        "cycle_id": issue.cycle_id,
        "project_id": issue.project_id,
        "updated_at": issue.updated_at.isoformat(),
    }


def http_error_message(exc: HTTPException) -> str:
    """The tool error text one route error becomes.

    A 404 keeps the routes' rule that invisible and absent look the same. A 403
    says the credential may not write there, which is the only reason a visible
    target refuses. Anything else carries the route's own message, which is written
    for a person and reads as well to a model.
    """
    detail = exc.detail
    message = detail.get("message") if isinstance(detail, Mapping) else detail
    text = str(message) if message else "The request was refused"
    if exc.status_code == 404:
        return NOT_VISIBLE
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
