"""The MCP tools for team planning: cycles, projects, milestones and project updates.

Every tool reads and writes through the same `app.common` paths the planning routes
run, so a project on a team the credential cannot see is invisible here as it is
over HTTP, and each write is held to the route's own role: any team member plans a
cycle, only a team administrator deletes one, a writer on one of a project's teams
edits it and its milestones, and only an administrator of every one of its teams
deletes it. A project update posted here moves the project's health exactly as one
posted in the app.

Teams are named by id, key prefix or name, and cycles, projects and milestones by
id or by a name that is unambiguous among the rows the caller can see.
"""

from __future__ import annotations

from typing import Any, get_args

from app.common.api.pagination import decode_cursor, encode_cursor
from app.common.api.schemas.issues import BULK_MAX_ISSUES, IssueBulkUpdate
from app.common.api.schemas.planning import (
    CycleCreate,
    CycleRead,
    CycleUpdate,
    MilestoneCreate,
    MilestoneRead,
    MilestoneUpdate,
    ProjectCreate,
    ProjectHealthField,
    ProjectIconField,
    ProjectPriorityField,
    ProjectRead,
    ProjectUpdate,
    ProjectUpdateCreate,
    ProjectUpdatePatch,
    ProjectUpdateRead,
)
from app.common.cycle_schedule import active_cycle
from app.common.cycle_writes import create_cycle, delete_cycle, update_cycle
from app.common.db.dynamo.issues import Issue
from app.common.issue_writes import bulk_update_issues
from app.common.milestone_writes import create_milestone, delete_milestone, update_milestone
from app.common.planning_rules import (
    counts_unestimated,
    load_readable_cycle,
    load_readable_project,
    require_team_member,
    require_team_reader,
)
from app.common.project_cadence import INTERVAL_OPTIONS, workspace_interval
from app.common.project_updates import (
    create_project_update,
    delete_project_update,
    list_project_updates,
    update_project_update,
)
from app.common.project_writes import create_project, delete_project, list_projects, update_project
from app.domains.integrations.mcp.toolkit import (
    NOT_VISIBLE,
    Tool,
    ToolCall,
    ambiguous,
    enum,
    initiative_id_ref,
    issue_ref,
    limit,
    nullable,
    nullable_enum,
    object_schema,
    page_properties,
    project_id_ref,
    resolve_user,
    string,
    string_list,
    summary_json,
    team_id_ref,
)
from app.domains.integrations.mcp.transport import ToolError

CYCLE_STATUSES: tuple[str, ...] = ("upcoming", "active", "completed", "cancelled")

PROJECT_STATUSES: tuple[str, ...] = ("backlog", "planned", "in_progress", "paused", "completed", "canceled")

PROJECT_HEALTHS: tuple[str, ...] = get_args(ProjectHealthField)

PROJECT_PRIORITIES: tuple[str, ...] = get_args(ProjectPriorityField)

PROJECT_ICONS: tuple[str, ...] = get_args(ProjectIconField)

CURRENT_CYCLE = "current"
"""The cycle reference that names a team's active cycle."""

PROJECT_FIELDS: tuple[str, ...] = (
    "name",
    "description",
    "start_date",
    "target_date",
    "status",
    "icon",
    "color",
    "health",
    "priority",
)

CLEARABLE_FIELDS: tuple[str, ...] = ("description", "start_date", "target_date", "icon", "color", "health")
"""The project fields a tool call clears by passing null."""

TEAM_HELP = "The team: id, key such as ENG, or name"

CYCLE_HELP = "The cycle: id, name, or 'current' for the team's active cycle"

PROJECT_HELP = "The project: id or name"

INITIATIVE_HELP = "The initiative: id or name"

MILESTONE_HELP = "The milestone: id or name within the project"


def _team_id(call: ToolCall, name: str = "team_id") -> str:
    """The id of the visible team one required argument names."""
    return team_id_ref(call, call.require(name))


def _project_id(call: ToolCall, value: Any) -> str:
    """A project id from an id or a name unique among the projects the caller can see."""
    return project_id_ref(call, value)


def _cycle_id(call: ToolCall, team_id: str, value: Any) -> str:
    """A cycle id of one readable team from an id, a unique name, or `current`."""
    reference = str(value).strip()
    if not reference:
        raise ToolError("cycle_id is required")
    require_team_reader(call.repositories, call.context, team_id)
    workspace_id = call.context.workspace_id
    if call.repositories.planning.get_cycle(workspace_id, team_id, reference) is not None:
        return reference
    cycles = call.repositories.planning.list_for_roadmap(workspace_id, team_id)
    if reference.casefold() == CURRENT_CYCLE:
        active = active_cycle(cycles)
        if active is None:
            raise ToolError("This team has no active cycle")
        return active.cycle_id
    folded = reference.casefold()
    named = [row for row in cycles if row.name.casefold() == folded]
    if len(named) > 1:
        raise ambiguous("cycle", reference)
    if not named:
        raise ToolError(NOT_VISIBLE)
    return named[0].cycle_id


def _milestone_id(call: ToolCall, project_id: str, value: Any) -> str:
    """A milestone id of one project from an id or a name unique within it."""
    reference = str(value).strip()
    if not reference:
        raise ToolError("milestone_id is required")
    workspace_id = call.context.workspace_id
    if call.repositories.planning.get_milestone(workspace_id, project_id, reference) is not None:
        return reference
    folded = reference.casefold()
    named = [
        row
        for row in call.repositories.planning.list_milestones(workspace_id, project_id)
        if row.name.casefold() == folded
    ]
    if len(named) > 1:
        raise ambiguous("milestone", reference)
    if not named:
        raise ToolError(NOT_VISIBLE)
    return named[0].milestone_id


def _cycle_json(cycle: CycleRead) -> dict[str, Any]:
    """One cycle as the tools answer it: its window, derived status, issue counts and carry-over."""
    return {
        "cycle_id": cycle.cycle_id,
        "team_id": cycle.team_id,
        "name": cycle.name,
        "number": cycle.number,
        "start_date": cycle.start_date,
        "end_date": cycle.end_date,
        "goal": cycle.goal,
        "status": cycle.status,
        "cancelled": cycle.cancelled,
        "counts": cycle.counts.model_dump(),
        "carry": cycle.carry.model_dump(),
    }


def _project_json(project: ProjectRead) -> dict[str, Any]:
    """One project as the tools answer it, its teams narrowed to the visible ones."""
    return {
        "project_id": project.project_id,
        "team_ids": project.team_ids,
        "name": project.name,
        "description": project.description,
        "lead_id": project.lead_id,
        "status": project.status,
        "health": project.health,
        "priority": project.priority,
        "icon": project.icon,
        "color": project.color,
        "member_ids": project.member_ids,
        "initiative_id": project.initiative_id,
        "start_date": project.start_date,
        "target_date": project.target_date,
        "counts": project.counts.model_dump(),
        "last_update_at": project.last_update_at.isoformat() if project.last_update_at else None,
        "update_interval_days": project.update_interval_days,
        "update_interval_inherited": project.update_interval_inherited,
        "next_update_due_at": project.next_update_due_at.isoformat() if project.next_update_due_at else None,
        "update_due_state": project.update_due_state,
        "updated_at": project.updated_at.isoformat(),
    }


def _milestone_json(milestone: MilestoneRead) -> dict[str, Any]:
    """One milestone as the tools answer it, in its project's manual order."""
    return {
        "milestone_id": milestone.milestone_id,
        "project_id": milestone.project_id,
        "name": milestone.name,
        "description": milestone.description,
        "target_date": milestone.target_date,
        "counts": milestone.counts.model_dump(),
    }


def _project_update_json(update: ProjectUpdateRead) -> dict[str, Any]:
    """One project update as the tools answer it, with whether the caller may change it."""
    return {
        "update_id": update.update_id,
        "project_id": update.project_id,
        "health": update.health,
        "body": update.body,
        "author_id": update.author_id,
        "source": update.source,
        "created_at": update.created_at.isoformat(),
        "edited_at": update.edited_at.isoformat() if update.edited_at else None,
        "can_edit": update.can_edit,
    }


def _list_cycles(call: ToolCall) -> Any:
    """One page of a team's cycles by start date, optionally narrowed by status.

    The status is derived from the dates, so it is filtered after the read, as the
    cycles route does, and a page can come back shorter than the limit while
    next_cursor still names more.
    """
    team_id = _team_id(call)
    require_team_reader(call.repositories, call.context, team_id)
    wanted = call.optional("status")
    if wanted is not None and wanted not in CYCLE_STATUSES:
        raise ToolError(f"status must be one of: {', '.join(CYCLE_STATUSES)}")
    scope = f"cycles:{call.context.workspace_id}:{team_id}"
    rows, last_key = call.repositories.planning.list_cycles(
        call.context.workspace_id,
        team_id,
        limit=limit(call.optional("limit")),
        start_key=decode_cursor(call.optional("cursor"), scope),
    )
    counted = counts_unestimated(call.repositories, call.context.workspace_id, team_id)
    cycles = [CycleRead.from_row(row, count_unestimated=counted) for row in rows]
    if wanted is not None:
        cycles = [row for row in cycles if row.status == wanted]
    return {"cycles": [_cycle_json(row) for row in cycles], "next_cursor": encode_cursor(last_key, scope)}


def _get_cycle(call: ToolCall) -> Any:
    """One cycle of a visible team, with its counts."""
    team_id = _team_id(call)
    cycle_id = _cycle_id(call, team_id, call.require("cycle_id"))
    cycle = load_readable_cycle(call.repositories, call.context, team_id, cycle_id)
    counted = counts_unestimated(call.repositories, call.context.workspace_id, team_id)
    return _cycle_json(CycleRead.from_row(cycle, count_unestimated=counted))


def _create_cycle(call: ToolCall) -> Any:
    """Create a cycle in a team the caller may write in, through the route's own path."""
    payload: dict[str, Any] = {
        "team_id": _team_id(call),
        "name": call.require("name"),
        "start_date": call.require("start_date"),
        "end_date": call.require("end_date"),
    }
    if call.optional("goal") is not None:
        payload["goal"] = call.arguments["goal"]
    return _cycle_json(create_cycle(call.repositories, call.context, CycleCreate.model_validate(payload)))


def _update_cycle(call: ToolCall) -> Any:
    """Patch a cycle's name, dates, goal or cancellation; a null goal clears it."""
    team_id = _team_id(call)
    cycle_id = _cycle_id(call, team_id, call.require("cycle_id"))
    payload: dict[str, Any] = {"team_id": team_id}
    for name in ("name", "start_date", "end_date", "cancelled"):
        if call.optional(name) is not None:
            payload[name] = call.arguments[name]
    if call.present("goal"):
        payload["goal"] = call.arguments["goal"]
    if "cancelled" in payload and not isinstance(payload["cancelled"], bool):
        raise ToolError("cancelled must be true or false")
    return _cycle_json(update_cycle(call.repositories, call.context, cycle_id, CycleUpdate.model_validate(payload)))


def _delete_cycle(call: ToolCall) -> Any:
    """Delete a cycle as a team administrator; its issues stay, with no cycle."""
    team_id = _team_id(call)
    cycle_id = _cycle_id(call, team_id, call.require("cycle_id"))
    delete_cycle(call.repositories, call.context, team_id, cycle_id)
    return {"deleted": True, "cycle_id": cycle_id, "team_id": team_id}


def _issues(call: ToolCall) -> list[Issue]:
    """The visible issues the `issue_ids` argument names, by key or id, first seen first."""
    values = call.require("issue_ids")
    if not isinstance(values, list) or not values:
        raise ToolError("issue_ids must be a non-empty list of issue keys or ids")
    if len(values) > BULK_MAX_ISSUES:
        raise ToolError(f"At most {BULK_MAX_ISSUES} issues at a time")
    found: dict[str, Issue] = {}
    for value in values:
        issue = issue_ref(call, value)
        found.setdefault(issue.issue_id, issue)
    return list(found.values())


def _cycle_team(call: ToolCall, issues: list[Issue]) -> str:
    """The cycle's team: the one named, or else the one team every issue is on."""
    if call.optional("team_id") is not None:
        return _team_id(call)
    teams = {issue.team_id for issue in issues}
    if len(teams) != 1:
        raise ToolError("The issues are on more than one team; name the cycle's team")
    return teams.pop()


def _bulk_cycle(call: ToolCall, issues: list[Issue], cycle_id: str | None) -> tuple[list[Issue], list[str]]:
    """Set or clear the cycle on several issues through the bulk issue patch path."""
    payload = IssueBulkUpdate.model_validate(
        {"issue_ids": [issue.issue_id for issue in issues], "patch": {"cycle_id": cycle_id}}
    )
    return bulk_update_issues(call.repositories, call.context, payload)


def _add_issues_to_cycle(call: ToolCall) -> Any:
    """Put several issues into one cycle of their team, all or nothing on validation."""
    issues = _issues(call)
    team_id = _cycle_team(call, issues)
    cycle_id = _cycle_id(call, team_id, call.require("cycle_id"))
    stored, skipped = _bulk_cycle(call, issues, cycle_id)
    return {"cycle_id": cycle_id, "issues": [summary_json(issue) for issue in stored], "skipped": skipped}


def _remove_issues_from_cycle(call: ToolCall) -> Any:
    """Take several issues out of one cycle, leaving any issue not in it untouched.

    The write rule is checked for every named issue's team even when none of them
    is in the cycle, so a reader is refused the same way whether or not the call
    would have changed anything.
    """
    issues = _issues(call)
    team_id = _cycle_team(call, issues)
    cycle_id = _cycle_id(call, team_id, call.require("cycle_id"))
    for team in dict.fromkeys(issue.team_id for issue in issues):
        require_team_member(call.repositories, call.context, team)
    inside = [issue for issue in issues if issue.cycle_id == cycle_id]
    unchanged = [issue.key for issue in issues if issue.cycle_id != cycle_id]
    stored, skipped = _bulk_cycle(call, inside, None) if inside else ([], [])
    return {
        "cycle_id": cycle_id,
        "issues": [summary_json(issue) for issue in stored],
        "not_in_cycle": unchanged,
        "skipped": skipped,
    }


def _list_projects(call: ToolCall) -> Any:
    """One page of the projects on teams this credential can see."""
    team_id = _team_id(call) if call.optional("team_id") is not None else None
    status_filter = call.optional("status")
    initiative = call.optional("initiative_id")
    rows, next_cursor = list_projects(
        call.repositories,
        call.context,
        team_id=team_id,
        initiative_id=initiative_id_ref(call, initiative) if initiative is not None else None,
        status_filter=str(status_filter) if status_filter else None,
        cursor=call.optional("cursor"),
        limit=limit(call.optional("limit")),
    )
    return {"projects": [_project_json(row) for row in rows], "next_cursor": next_cursor}


def _get_project(call: ToolCall) -> Any:
    """One project with its milestones, when at least one of its teams is visible."""
    project_id = _project_id(call, call.require("project_id"))
    project, visible = load_readable_project(call.repositories, call.context, project_id)
    default_days = workspace_interval(call.repositories.workspaces, call.context.workspace_id)
    body = _project_json(ProjectRead.from_row(project, visible, default_interval_days=default_days))
    milestones = call.repositories.planning.list_milestones(call.context.workspace_id, project.project_id)
    body["milestones"] = [_milestone_json(MilestoneRead.from_row(row)) for row in milestones]
    return body


def _project_payload(call: ToolCall, *, nullable_fields: bool) -> dict[str, Any]:
    """The project fields named in a tool call, as the route's body would carry them."""
    payload: dict[str, Any] = {}
    for name in PROJECT_FIELDS:
        if call.optional(name) is not None:
            payload[name] = call.arguments[name]
        elif nullable_fields and call.present(name) and name in CLEARABLE_FIELDS:
            payload[name] = None
    if call.optional("team_ids") is not None:
        teams = call.arguments["team_ids"]
        if not isinstance(teams, list):
            raise ToolError("team_ids must be a list of teams")
        payload["team_ids"] = [team_id_ref(call, team) for team in teams]
    if call.present("lead_id"):
        payload["lead_id"] = resolve_user(call, call.arguments["lead_id"])
    if call.optional("initiative_id") is not None:
        payload["initiative_id"] = initiative_id_ref(call, call.arguments["initiative_id"])
    elif nullable_fields and call.present("initiative_id"):
        payload["initiative_id"] = None
    if call.optional("update_interval_days") is not None:
        payload["update_interval_days"] = _interval(call.arguments["update_interval_days"])
    elif nullable_fields and call.present("update_interval_days"):
        payload["update_interval_days"] = None
    if call.optional("member_ids") is not None:
        members = call.arguments["member_ids"]
        if not isinstance(members, list):
            raise ToolError("member_ids must be a list of user ids")
        payload["member_ids"] = [resolve_user(call, member) for member in members]
    return payload


def _interval(value: Any) -> int:
    """A project update cadence in days, refused unless it is one of the allowed options."""
    if isinstance(value, str) and value.strip().isdigit():
        value = int(value.strip())
    if isinstance(value, bool) or not isinstance(value, int) or value not in INTERVAL_OPTIONS:
        options = ", ".join(str(option) for option in INTERVAL_OPTIONS)
        raise ToolError(f"update_interval_days must be one of: {options}")
    return value


def _create_project(call: ToolCall) -> Any:
    """Create a project on one or more teams the caller may write in."""
    payload = ProjectCreate.model_validate(_project_payload(call, nullable_fields=False))
    return _project_json(create_project(call.repositories, call.context, payload))


def _update_project(call: ToolCall) -> Any:
    """Patch a project's fields or its teams, through the route's own path."""
    project_id = _project_id(call, call.require("project_id"))
    payload = ProjectUpdate.model_validate(_project_payload(call, nullable_fields=True))
    return _project_json(update_project(call.repositories, call.context, project_id, payload))


def _delete_project(call: ToolCall) -> Any:
    """Delete a project as an administrator of every one of its teams."""
    project_id = _project_id(call, call.require("project_id"))
    delete_project(call.repositories, call.context, project_id)
    return {"deleted": True, "project_id": project_id}


def _list_project_milestones(call: ToolCall) -> Any:
    """Every milestone of a visible project, in its manual order."""
    project, _ = load_readable_project(call.repositories, call.context, _project_id(call, call.require("project_id")))
    rows = call.repositories.planning.list_milestones(call.context.workspace_id, project.project_id)
    return {"milestones": [_milestone_json(MilestoneRead.from_row(row)) for row in rows]}


def _create_milestone(call: ToolCall) -> Any:
    """Add a milestone after a project's last one, through the route's own path."""
    project_id = _project_id(call, call.require("project_id"))
    payload: dict[str, Any] = {"name": call.require("name")}
    for name in ("description", "target_date"):
        if call.optional(name) is not None:
            payload[name] = call.arguments[name]
    created = create_milestone(call.repositories, call.context, project_id, MilestoneCreate.model_validate(payload))
    return _milestone_json(created)


def _update_milestone(call: ToolCall) -> Any:
    """Rename, redescribe or redate a milestone; null clears the description or date."""
    project_id = _project_id(call, call.require("project_id"))
    load_readable_project(call.repositories, call.context, project_id)
    milestone_id = _milestone_id(call, project_id, call.require("milestone_id"))
    payload: dict[str, Any] = {}
    if call.optional("name") is not None:
        payload["name"] = call.arguments["name"]
    for name in ("description", "target_date"):
        if call.present(name):
            payload[name] = call.arguments[name]
    updated = update_milestone(
        call.repositories, call.context, project_id, milestone_id, MilestoneUpdate.model_validate(payload)
    )
    return _milestone_json(updated)


def _delete_milestone(call: ToolCall) -> Any:
    """Delete a milestone; its issues stay in the project with no milestone."""
    project_id = _project_id(call, call.require("project_id"))
    load_readable_project(call.repositories, call.context, project_id)
    milestone_id = _milestone_id(call, project_id, call.require("milestone_id"))
    delete_milestone(call.repositories, call.context, project_id, milestone_id)
    return {"deleted": True, "milestone_id": milestone_id, "project_id": project_id}


def _list_project_updates(call: ToolCall) -> Any:
    """One page of a visible project's updates, newest first."""
    rows, next_cursor = list_project_updates(
        call.repositories,
        call.context,
        _project_id(call, call.require("project_id")),
        cursor=call.optional("cursor"),
        limit=limit(call.optional("limit")),
    )
    return {"updates": [_project_update_json(row) for row in rows], "next_cursor": next_cursor}


def _create_project_update(call: ToolCall) -> Any:
    """Post an update on a project the caller may edit, setting the project's health."""
    project_id = _project_id(call, call.require("project_id"))
    payload = ProjectUpdateCreate.model_validate({"body": call.require("body"), "health": call.require("health")})
    return _project_update_json(create_project_update(call.repositories, call.context, project_id, payload))


def _update_project_update(call: ToolCall) -> Any:
    """Edit an update's body or health as its author or an admin, through the route's own path."""
    project_id = _project_id(call, call.require("project_id"))
    payload: dict[str, Any] = {}
    for name in ("body", "health"):
        if call.optional(name) is not None:
            payload[name] = call.arguments[name]
    updated = update_project_update(
        call.repositories,
        call.context,
        project_id,
        str(call.require("update_id")),
        ProjectUpdatePatch.model_validate(payload),
    )
    return _project_update_json(updated)


def _delete_project_update(call: ToolCall) -> Any:
    """Delete an update as its author or an admin; the project falls back to the previous health."""
    project_id = _project_id(call, call.require("project_id"))
    update_id = str(call.require("update_id"))
    delete_project_update(call.repositories, call.context, project_id, update_id)
    return {"deleted": True, "update_id": update_id, "project_id": project_id}


def _boolean(description: str) -> dict[str, Any]:
    """A boolean property carrying its description."""
    return {"type": "boolean", "description": description}


PROJECT_PROPERTIES: dict[str, Any] = {
    "name": string("The project name"),
    "description": nullable("The description, in Markdown"),
    "lead_id": nullable("The lead: user id, email, 'me' for the caller, or null"),
    "start_date": nullable("Start date, YYYY-MM-DD"),
    "target_date": nullable("Target date, YYYY-MM-DD"),
    "status": enum(PROJECT_STATUSES, "The project status"),
    "team_ids": string_list(
        "Every team the project is on, each an id, key such as ENG, or name; the caller must write in each one added"
    ),
    "health": nullable_enum(PROJECT_HEALTHS, "The project health, or null for none"),
    "priority": enum(PROJECT_PRIORITIES, "The project priority"),
    "icon": nullable_enum(PROJECT_ICONS, "The project icon, or null for the default"),
    "color": nullable("The project colour as #rrggbb, or null"),
    "member_ids": string_list("Every member of the project by user id, 'me' for the caller; replaces the list"),
    "initiative_id": nullable(f"{INITIATIVE_HELP} the project belongs to, or null for none"),
    "update_interval_days": {
        "type": ["integer", "null"],
        "enum": [*INTERVAL_OPTIONS, None],
        "description": (
            "Days between project updates the lead is reminded of: 7, 14 or 30, 0 for no reminders, "
            "or null to follow the workspace default"
        ),
    },
}

CYCLE_ISSUE_PROPERTIES: dict[str, Any] = {
    "cycle_id": string(CYCLE_HELP),
    "issue_ids": string_list(f"The issues, each a key such as ENG-12 or an id; at most {BULK_MAX_ISSUES}"),
    "team_id": string(f"{TEAM_HELP}; defaults to the issues' team"),
}

PLANNING_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_cycles",
        description="One page of a team's cycles by start date, with derived status and issue counts.",
        scopes=("cycles:read",),
        schema=object_schema(
            {
                "team_id": string(TEAM_HELP),
                "status": enum(CYCLE_STATUSES, "Only cycles in this status"),
                **page_properties(),
            },
            required=("team_id",),
        ),
        handler=_list_cycles,
    ),
    Tool(
        name="get_cycle",
        description="One cycle with its window, goal, status and issue counts. The cycle may be named or 'current'.",
        scopes=("cycles:read",),
        schema=object_schema(
            {"team_id": string(TEAM_HELP), "cycle_id": string(CYCLE_HELP)},
            required=("team_id", "cycle_id"),
        ),
        handler=_get_cycle,
    ),
    Tool(
        name="create_cycle",
        description="Create a cycle in a team, a time box from start_date to end_date. Any team member may plan one.",
        scopes=("cycles:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_HELP),
                "name": string("The cycle name"),
                "start_date": string("First day, YYYY-MM-DD"),
                "end_date": string("Last day, YYYY-MM-DD, not before start_date"),
                "goal": string("What the cycle sets out to do"),
            },
            required=("team_id", "name", "start_date", "end_date"),
        ),
        handler=_create_cycle,
    ),
    Tool(
        name="update_cycle",
        description=(
            "Change a cycle's name, dates, goal or cancellation. "
            "Only the fields named are written; null clears the goal."
        ),
        scopes=("cycles:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_HELP),
                "cycle_id": string(CYCLE_HELP),
                "name": string("The cycle name"),
                "start_date": string("First day, YYYY-MM-DD"),
                "end_date": string("Last day, YYYY-MM-DD"),
                "goal": nullable("What the cycle sets out to do, or null"),
                "cancelled": _boolean("true cancels the cycle, false restores it"),
            },
            required=("team_id", "cycle_id"),
        ),
        handler=_update_cycle,
    ),
    Tool(
        name="delete_cycle",
        description=(
            "Permanently delete a cycle and its burn-up history. Its issues stay but lose their cycle. "
            "Team administrators only."
        ),
        scopes=("cycles:write",),
        schema=object_schema(
            {"team_id": string(TEAM_HELP), "cycle_id": string(CYCLE_HELP)},
            required=("team_id", "cycle_id"),
        ),
        handler=_delete_cycle,
        destructive=True,
    ),
    Tool(
        name="add_issues_to_cycle",
        description=(
            "Put issues into a cycle of their team, replacing any cycle they were in. "
            "All or nothing: one issue refused refuses the call."
        ),
        scopes=("issues:write",),
        schema=object_schema(CYCLE_ISSUE_PROPERTIES, required=("cycle_id", "issue_ids")),
        handler=_add_issues_to_cycle,
    ),
    Tool(
        name="remove_issues_from_cycle",
        description=(
            "Take issues out of a cycle; the issues stay, with no cycle. Issues not in that cycle are left alone."
        ),
        scopes=("issues:write",),
        schema=object_schema(CYCLE_ISSUE_PROPERTIES, required=("cycle_id", "issue_ids")),
        handler=_remove_issues_from_cycle,
        destructive=True,
    ),
    Tool(
        name="list_projects",
        description=(
            "One page of projects on teams this credential can read, with status, issue counts and whether "
            "a project update is upcoming, due or overdue."
        ),
        scopes=("projects:read",),
        schema=object_schema(
            {
                "team_id": string(f"Only projects on this team. {TEAM_HELP}"),
                "status": enum(PROJECT_STATUSES, "Only projects in this status"),
                "initiative_id": string(f"Only projects in this initiative. {INITIATIVE_HELP}"),
                **page_properties(),
            }
        ),
        handler=_list_projects,
    ),
    Tool(
        name="get_project",
        description=(
            "One project with its teams, lead, members, dates, status, health, priority, counts, milestones "
            "and its update cadence and due state."
        ),
        scopes=("projects:read",),
        schema=object_schema({"project_id": string(PROJECT_HELP)}, required=("project_id",)),
        handler=_get_project,
    ),
    Tool(
        name="create_project",
        description="Create a project on one or more teams. The status defaults to backlog.",
        scopes=("projects:write",),
        schema=object_schema(PROJECT_PROPERTIES, required=("name", "team_ids")),
        handler=_create_project,
    ),
    Tool(
        name="update_project",
        description=(
            "Change a project's fields or its teams. Only the fields named are written; "
            "null clears the description, lead, dates, icon, colour, health and initiative, and returns the update "
            "cadence to the workspace default."
        ),
        scopes=("projects:write",),
        schema=object_schema({"project_id": string(PROJECT_HELP), **PROJECT_PROPERTIES}, required=("project_id",)),
        handler=_update_project,
    ),
    Tool(
        name="delete_project",
        description=(
            "Permanently delete a project with its milestones and updates. Its issues stay but lose the project. "
            "Needs an administrator of every team the project is on."
        ),
        scopes=("projects:write",),
        schema=object_schema({"project_id": string(PROJECT_HELP)}, required=("project_id",)),
        handler=_delete_project,
        destructive=True,
    ),
    Tool(
        name="list_project_milestones",
        description="Every milestone of a project in its manual order, with issue counts.",
        scopes=("milestones:read",),
        schema=object_schema({"project_id": string(PROJECT_HELP)}, required=("project_id",)),
        handler=_list_project_milestones,
    ),
    Tool(
        name="create_milestone",
        description="Add a milestone to a project, after its last one.",
        scopes=("milestones:write",),
        schema=object_schema(
            {
                "project_id": string(PROJECT_HELP),
                "name": string("The milestone name"),
                "description": string("The description, in Markdown"),
                "target_date": string("Target date, YYYY-MM-DD"),
            },
            required=("project_id", "name"),
        ),
        handler=_create_milestone,
    ),
    Tool(
        name="update_milestone",
        description=(
            "Rename a milestone or change its description or target date. "
            "Only the fields named are written; null clears the description or date."
        ),
        scopes=("milestones:write",),
        schema=object_schema(
            {
                "project_id": string(PROJECT_HELP),
                "milestone_id": string(MILESTONE_HELP),
                "name": string("The milestone name"),
                "description": nullable("The description, in Markdown, or null"),
                "target_date": nullable("Target date, YYYY-MM-DD, or null"),
            },
            required=("project_id", "milestone_id"),
        ),
        handler=_update_milestone,
    ),
    Tool(
        name="delete_milestone",
        description="Permanently delete a milestone. Its issues stay in the project but lose the milestone.",
        scopes=("milestones:write",),
        schema=object_schema(
            {"project_id": string(PROJECT_HELP), "milestone_id": string(MILESTONE_HELP)},
            required=("project_id", "milestone_id"),
        ),
        handler=_delete_milestone,
        destructive=True,
    ),
    Tool(
        name="list_project_updates",
        description="One page of a project's written status updates, newest first, each with the health it reported.",
        scopes=("projects:read",),
        schema=object_schema(
            {"project_id": string(PROJECT_HELP), **page_properties()},
            required=("project_id",),
        ),
        handler=_list_project_updates,
    ),
    Tool(
        name="create_project_update",
        description=(
            "Post a status update on a project, in Markdown, with its health. "
            "Posting sets the project's health and notifies its lead and members."
        ),
        scopes=("projects:write",),
        schema=object_schema(
            {
                "project_id": string(PROJECT_HELP),
                "body": string("The update, in Markdown"),
                "health": enum(PROJECT_HEALTHS, "How the project stands"),
            },
            required=("project_id", "body", "health"),
        ),
        handler=_create_project_update,
    ),
    Tool(
        name="update_project_update",
        description=(
            "Edit a project update's body or health, as its author or an admin. "
            "Changing the newest update's health moves the project's health."
        ),
        scopes=("projects:write",),
        schema=object_schema(
            {
                "project_id": string(PROJECT_HELP),
                "update_id": string("The update"),
                "body": string("The update, in Markdown"),
                "health": enum(PROJECT_HEALTHS, "How the project stands"),
            },
            required=("project_id", "update_id"),
        ),
        handler=_update_project_update,
    ),
    Tool(
        name="delete_project_update",
        description=(
            "Permanently delete a project update, as its author or an admin. "
            "Deleting the newest one returns the project to the previous update's health."
        ),
        scopes=("projects:write",),
        schema=object_schema(
            {"project_id": string(PROJECT_HELP), "update_id": string("The update")},
            required=("project_id", "update_id"),
        ),
        handler=_delete_project_update,
        destructive=True,
    ),
)
