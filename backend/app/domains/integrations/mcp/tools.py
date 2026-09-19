"""The eight MCP tools, their schemas, and the scopes each one needs.

Every tool writes through the same repositories the HTTP routes use, so an issue
created by an agent carries the same key allocation, the same activity row and the
same stream record as one created in the UI. There is no MCP-shaped write path,
which is what keeps the two from drifting.

There is no delete tool and no workspace administration tool. An agent that can
create and update but never destroy is a different risk from one that can do both,
and the difference is worth more than the convenience of a `delete_issue`.

Each tool receives the `AuthzContext` the transport resolved, and decides project
visibility with the same helpers a route does. A tool reaching a project the caller
cannot see answers the same not-found it would over HTTP.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Mapping, Optional

from app.common.api.dependencies.authz import IMPLIED_PROJECT_ROLE, PROJECT_ROLES, AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.comments import build_comment
from app.common.db.dynamo.issues import Issue, issue_key, new_issue_id
from app.domains.integrations.mcp.transport import ToolError

MAX_RESULTS = 50

DEFAULT_RESULTS = 20

PRIORITIES = ("none", "urgent", "high", "medium", "low")


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


def _object(properties: Mapping[str, Any], required: tuple[str, ...] = ()) -> dict[str, Any]:
    """A JSON Schema object, in the one shape every tool's schema takes."""
    schema: dict[str, Any] = {"type": "object", "properties": dict(properties)}
    if required:
        schema["required"] = list(required)
    schema["additionalProperties"] = False
    return schema


def _string(description: str) -> dict[str, Any]:
    """A string property carrying its description."""
    return {"type": "string", "description": description}


def _visible_issue(call: ToolCall, issue_id: str) -> Issue:
    """One issue the caller may see, or a tool error.

    The not-found and the not-visible cases give the same message, for the same
    reason the HTTP routes give the same 404: distinguishing them would let an
    agent enumerate the projects its token cannot reach.
    """
    issue = call.repositories.issues.get(call.context.workspace_id, issue_id)
    if issue is None or not call.context.can_see_project(issue.project_id):
        raise ToolError("No issue with that id is visible to this credential")
    return issue


def _require_project_member(call: ToolCall, project_id: str) -> None:
    """Hold that this credential may write in one project, or refuse the tool call.

    The scope check upstream says what kind of write the credential carries; this
    says whether its holder may write in this project at all. Without it a guest
    with a read-only project membership is refused over HTTP and allowed over MCP,
    which would make the transport, not the membership, decide what a person can do.

    Invisibility is already the not-found message every read gives, so what is left
    here is a caller who can see the project and holds no role that writes.
    """
    if not call.context.can_see_project(project_id):
        raise ToolError("No project with that id is visible to this credential")
    membership = call.repositories.memberships.get_project_membership(
        call.context.workspace_id, project_id, call.context.user_id
    )
    role = membership.role if membership is not None else None
    if role not in PROJECT_ROLES:
        role = IMPLIED_PROJECT_ROLE.get(call.context.role)
    if role is None:
        raise ToolError("This credential may not write in that project")


def _issue_json(issue: Issue, *, status_name: str = "") -> dict[str, Any]:
    """One issue as a tool answers it.

    Ids are included here, unlike in the public share shapes, because the caller is
    inside the workspace and needs them to make the next call. What bounds this
    credential is its scopes and its membership, not the ids it can see.
    """
    return {
        "issue_id": issue.issue_id,
        "issue_key": issue.key,
        "project_id": issue.project_id,
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
        "created_at": issue.created_at.isoformat(),
        "updated_at": issue.updated_at.isoformat(),
    }


def _summary_json(issue: Issue) -> dict[str, Any]:
    """One issue as a listing renders it."""
    return {
        "issue_id": issue.issue_id,
        "issue_key": issue.key,
        "project_id": issue.project_id,
        "title": issue.title,
        "status_id": issue.status_id,
        "priority": issue.priority,
        "assignee_id": issue.assignee_id,
        "updated_at": issue.updated_at.isoformat(),
    }


def _visible_projects(call: ToolCall) -> list[str]:
    """Every project this credential may read, in a stable order."""
    projects = call.repositories.projects.list_for_workspace(call.context.workspace_id)
    return sorted(project.project_id for project in projects if call.context.can_see_project(project.project_id))


def _search_issues(call: ToolCall) -> Any:
    """Issues matching a query, newest first, inside the visible projects only.

    Filtered after the project read rather than through the search index, because
    the index is a separate table this domain holds no grant on. The fan-out is
    bounded by the result limit, so a broad query costs one short page per visible
    project rather than a scan.
    """
    query = str(call.optional("query", "") or "").strip().lower()
    project_id = call.optional("project_id")
    status_id = call.optional("status_id")
    assignee_id = call.optional("assignee_id")
    limit = _limit(call.optional("limit", DEFAULT_RESULTS))

    if project_id:
        if not call.context.can_see_project(str(project_id)):
            raise ToolError("No project with that id is visible to this credential")
        wanted = [str(project_id)]
    else:
        wanted = _visible_projects(call)

    found: list[Issue] = []
    for candidate in wanted:
        page = call.repositories.issues.list_for_project(call.context.workspace_id, candidate, limit=MAX_RESULTS)
        for item in page.items:
            issue = Issue.model_validate(dict(item))
            if query and query not in issue.title.lower() and query not in (issue.body or "").lower():
                continue
            if status_id and issue.status_id != str(status_id):
                continue
            if assignee_id and issue.assignee_id != str(assignee_id):
                continue
            found.append(issue)

    found.sort(key=lambda row: row.updated_at, reverse=True)
    return {"issues": [_summary_json(issue) for issue in found[:limit]]}


def _get_issue(call: ToolCall) -> Any:
    """One issue by its id or its key.

    Both spellings because an agent reading a conversation has the key a person
    wrote and an agent chaining calls has the id a previous tool answered.
    """
    issue_id = call.optional("issue_id")
    issue_key_value = call.optional("issue_key")
    if not issue_id and not issue_key_value:
        raise ToolError("Name either issue_id or issue_key")

    if issue_id:
        issue = _visible_issue(call, str(issue_id))
    else:
        issue = _by_key(call, str(issue_key_value))

    return _issue_json(issue, status_name=_status_name(call, issue))


def _by_key(call: ToolCall, key: str) -> Issue:
    """One issue by its human key, resolved through its project's prefix."""
    prefix, _, number = key.rpartition("-")
    if not prefix or not number.isdigit():
        raise ToolError("An issue key looks like ABC-123")

    project = call.repositories.projects.get_by_key_prefix(call.context.workspace_id, prefix.upper())
    if project is None or not call.context.can_see_project(project.project_id):
        raise ToolError("No issue with that key is visible to this credential")

    issue = call.repositories.issues.get_by_number(call.context.workspace_id, project.project_id, int(number))
    if issue is None:
        raise ToolError("No issue with that key is visible to this credential")
    return issue


def _status_name(call: ToolCall, issue: Issue) -> str:
    """The display name of one issue's status, or empty when it has been deleted."""
    row = call.repositories.project_config.get_status(call.context.workspace_id, issue.project_id, issue.status_id)
    return row.name if row is not None else ""


def _create_issue(call: ToolCall) -> Any:
    """Create an issue in a visible project, allocating its key from the counter.

    The same counter and the same activity row as the HTTP route, so an agent's
    issue is indistinguishable from a person's downstream. The status defaults to
    the project's first when none is named, which is what the UI does too.
    """
    project_id = str(call.require("project_id"))
    _require_project_member(call, project_id)

    project = call.repositories.projects.get(call.context.workspace_id, project_id)
    if project is None:
        raise ToolError("No project with that id is visible to this credential")

    statuses = call.repositories.project_config.list_statuses(call.context.workspace_id, project_id)
    if not statuses:
        raise ToolError("That project has no statuses yet")

    named = call.optional("status_id")
    if named:
        chosen = next((row for row in statuses if row.status_id == str(named)), None)
        if chosen is None:
            raise ToolError("That status does not belong to the project")
    else:
        chosen = sorted(statuses, key=lambda row: row.position)[0]

    number = call.repositories.counters.allocate_issue_number(call.context.workspace_id, project_id)
    issue = Issue(
        workspace_id=call.context.workspace_id,
        issue_id=new_issue_id(),
        project_id=project_id,
        key=issue_key(project.key_prefix, number),
        number=number,
        title=str(call.require("title")),
        body=call.optional("body"),
        status_id=chosen.status_id,
        priority=_priority(call.optional("priority", "none")),
        assignee_id=call.optional("assignee_id"),
        label_ids=[str(value) for value in call.optional("label_ids", []) or []],
        estimate=_estimate(call.optional("estimate")),
        created_by=call.context.user_id,
    )
    created = call.repositories.issues.create(issue)
    _record(call, created, "created")
    return _issue_json(created, status_name=chosen.name)


def _update_issue(call: ToolCall) -> Any:
    """Change fields on a visible issue, leaving every unnamed field alone.

    A patch rather than a replace, because an agent updating one field must not
    silently clear the rest; only the keys present in the arguments are written.
    """
    issue = _visible_issue(call, str(call.require("issue_id")))
    _require_project_member(call, issue.project_id)

    updated = issue.model_copy(
        update={
            key: value
            for key, value in {
                "title": call.optional("title"),
                "body": call.optional("body"),
                "status_id": call.optional("status_id"),
                "priority": _priority(call.optional("priority")) if call.optional("priority") else None,
                "label_ids": (
                    [str(value) for value in call.optional("label_ids")]
                    if call.optional("label_ids") is not None
                    else None
                ),
                "estimate": _estimate(call.optional("estimate")) if call.optional("estimate") else None,
                "start_date": call.optional("start_date"),
                "due_date": call.optional("due_date"),
            }.items()
            if value is not None
        }
        | {"updated_at": datetime.now(issue.updated_at.tzinfo)}
    )

    if updated.status_id != issue.status_id:
        statuses = call.repositories.project_config.list_statuses(call.context.workspace_id, issue.project_id)
        if not any(row.status_id == updated.status_id for row in statuses):
            raise ToolError("That status does not belong to the project")

    stored = call.repositories.issues.replace(updated)
    _record(call, stored, "updated")
    return _issue_json(stored, status_name=_status_name(call, stored))


def _assign_issue(call: ToolCall) -> Any:
    """Assign or unassign a visible issue.

    A null `assignee_id` unassigns, which is why the argument is required but
    nullable: omitting it entirely would be ambiguous between the two.
    """
    issue = _visible_issue(call, str(call.require("issue_id")))
    _require_project_member(call, issue.project_id)
    assignee_id = call.arguments.get("assignee_id")

    updated = issue.model_copy(
        update={
            "assignee_id": str(assignee_id) if assignee_id else None,
            "updated_at": datetime.now(issue.updated_at.tzinfo),
        }
    )
    stored = call.repositories.issues.replace(updated)
    _record(call, stored, "assigned")
    return _issue_json(stored, status_name=_status_name(call, stored))


def _add_comment(call: ToolCall) -> Any:
    """Add a comment to a visible issue."""
    issue = _visible_issue(call, str(call.require("issue_id")))
    _require_project_member(call, issue.project_id)
    body = str(call.require("body"))

    comment = build_comment(
        call.context.workspace_id,
        issue.issue_id,
        issue.project_id,
        call.context.user_id,
        body,
    )
    created = call.repositories.comments.create(comment)
    return {
        "comment_id": created.comment_id,
        "issue_id": created.issue_id,
        "body": created.body,
        "created_at": created.created_at.isoformat(),
    }


def _list_projects(call: ToolCall) -> Any:
    """Every project this credential may read, with what an agent needs to write."""
    projects = call.repositories.projects.list_for_workspace(call.context.workspace_id)
    visible = [row for row in projects if call.context.can_see_project(row.project_id)]
    return {
        "projects": [
            {
                "project_id": row.project_id,
                "name": row.name,
                "key_prefix": row.key_prefix,
                "estimate_scale": row.estimate_scale,
            }
            for row in sorted(visible, key=lambda row: row.name.lower())
        ]
    }


def _list_statuses(call: ToolCall) -> Any:
    """One visible project's statuses in board order, with their categories."""
    project_id = str(call.require("project_id"))
    if not call.context.can_see_project(project_id):
        raise ToolError("No project with that id is visible to this credential")

    statuses = call.repositories.project_config.list_statuses(call.context.workspace_id, project_id)
    return {
        "statuses": [
            {
                "status_id": row.status_id,
                "name": row.name,
                "category": row.category,
                "position": row.position,
            }
            for row in sorted(statuses, key=lambda row: row.position)
        ]
    }


def _record(call: ToolCall, issue: Issue, kind: str) -> None:
    """Write the activity row one tool write produces.

    Not best effort: a swallowed failure here is how a missing grant stayed
    invisible, because every tool write recorded nothing and still answered success.
    A raise instead means the read-only guard fails the suite and a denied write
    fails the request, which is what makes the grant and the code agree.

    The actor kind travels with the row, so a feed can say a change arrived through
    a credential rather than from a person sitting at the product. A tool write that
    read as an ordinary edit would make an agent's changes indistinguishable from
    its owner's.
    """
    call.repositories.activity.record(
        build_activity(
            call.context.workspace_id,
            issue.project_id,
            issue.issue_id,
            call.context.user_id,
            kind,
            actor_kind=call.context.actor.value,
        )
    )


def _limit(value: Any) -> int:
    """A result limit clamped to the tool's own bounds."""
    try:
        candidate = int(value)
    except (TypeError, ValueError):
        return DEFAULT_RESULTS
    return max(1, min(candidate, MAX_RESULTS))


def _priority(value: Any) -> str:
    """A priority narrowed to the five the product allows."""
    candidate = str(value or "none").strip().lower()
    if candidate not in PRIORITIES:
        raise ToolError(f"priority must be one of: {', '.join(PRIORITIES)}")
    return candidate


def _estimate(value: Any) -> Optional[str]:
    """An estimate as the string the row stores, or `None`."""
    if value is None:
        return None
    return str(value)


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="search_issues",
        description="Search issues by text, project, status or assignee. Answers summaries, newest first.",
        scopes=("issues:read",),
        schema=_object(
            {
                "query": _string("Text to match against the title and body"),
                "project_id": _string("Narrow to one project"),
                "status_id": _string("Narrow to one status"),
                "assignee_id": _string("Narrow to one assignee"),
                "limit": {"type": "integer", "minimum": 1, "maximum": MAX_RESULTS},
            }
        ),
        handler=_search_issues,
    ),
    Tool(
        name="get_issue",
        description="Read one issue in full, by its id or its key such as ABC-123.",
        scopes=("issues:read",),
        schema=_object(
            {
                "issue_id": _string("The issue's id"),
                "issue_key": _string("The issue's key, such as ABC-123"),
            }
        ),
        handler=_get_issue,
    ),
    Tool(
        name="create_issue",
        description="Create an issue in a project, allocating its key.",
        scopes=("issues:write",),
        schema=_object(
            {
                "project_id": _string("The project to create it in"),
                "title": _string("The issue title"),
                "body": _string("The issue body"),
                "status_id": _string("The starting status, defaulting to the project's first"),
                "priority": {"type": "string", "enum": list(PRIORITIES)},
                "assignee_id": _string("Who to assign it to"),
                "label_ids": {"type": "array", "items": {"type": "string"}},
                "estimate": _string("The estimate, in the project's scale"),
            },
            required=("project_id", "title"),
        ),
        handler=_create_issue,
    ),
    Tool(
        name="update_issue",
        description="Change fields on an issue. Only the fields named are written.",
        scopes=("issues:write",),
        schema=_object(
            {
                "issue_id": _string("The issue to change"),
                "title": _string("A new title"),
                "body": _string("A new body"),
                "status_id": _string("A new status"),
                "priority": {"type": "string", "enum": list(PRIORITIES)},
                "label_ids": {"type": "array", "items": {"type": "string"}},
                "estimate": _string("A new estimate"),
                "start_date": _string("A new start date, ISO 8601"),
                "due_date": _string("A new due date, ISO 8601"),
            },
            required=("issue_id",),
        ),
        handler=_update_issue,
    ),
    Tool(
        name="assign_issue",
        description="Assign an issue, or unassign it with a null assignee_id.",
        scopes=("issues:write",),
        schema=_object(
            {
                "issue_id": _string("The issue to assign"),
                "assignee_id": {
                    "type": ["string", "null"],
                    "description": "Who to assign it to, or null to unassign",
                },
            },
            required=("issue_id",),
        ),
        handler=_assign_issue,
    ),
    Tool(
        name="add_comment",
        description="Add a comment to an issue this credential can read.",
        scopes=("comments:write",),
        schema=_object(
            {
                "issue_id": _string("The issue to comment on"),
                "body": _string("The comment body"),
            },
            required=("issue_id", "body"),
        ),
        handler=_add_comment,
    ),
    Tool(
        name="list_projects",
        description="Every project this credential can read, with key prefix and estimate scale.",
        scopes=("projects:read",),
        schema=_object({}),
        handler=_list_projects,
    ),
    Tool(
        name="list_statuses",
        description="One project's statuses in board order, with their categories.",
        scopes=("projects:read",),
        schema=_object({"project_id": _string("The project to read")}, required=("project_id",)),
        handler=_list_statuses,
    ),
)

TOOLS_BY_NAME: dict[str, Tool] = {tool.name: tool for tool in TOOLS}


def render(value: Any) -> str:
    """One tool's answer as the text content MCP carries.

    JSON rather than prose, because every consumer is a language model reading a
    structure it will chain further calls from, and indentation costs tokens for
    nothing a model needs.
    """
    return json.dumps(value, default=str, sort_keys=True)
