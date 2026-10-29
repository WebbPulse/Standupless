"""The MCP tools for team planning: cycles, projects, milestones, Resources links and project updates.

Every tool reads and writes through the same `app.common` paths the planning routes
run, so a project on a team the credential cannot see is invisible here as it is
over HTTP, and each write is held to the route's own role: any team member plans a
cycle, only a team administrator deletes one, a writer on one of a project's teams
edits it, its milestones and its Resources links, and only an administrator of every one of its teams
deletes it. A project update posted here moves the project's health exactly as one
posted in the app.

Teams are named by id, key prefix or name, and cycles, projects and milestones by
id or by a name that is unambiguous among the rows the caller can see.
"""

from __future__ import annotations

from typing import Any, Optional, get_args

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
    ProjectLinkCreate,
    ProjectLinkRead,
    ProjectLinkUpdate,
    ProjectOpenIssuesAction,
    ProjectPriorityField,
    ProjectRead,
    ProjectRelationCreate,
    ProjectRelationRead,
    ProjectSortField,
    ProjectUpdate,
    ProjectUpdateCreate,
    ProjectUpdatePatch,
    ProjectUpdateRead,
)
from app.common.cycle_rollover import end_cycle_today, start_cycle_today_read
from app.common.cycle_schedule import RELATIVE_CYCLES, relative_cycle
from app.common.cycle_writes import create_cycle, delete_cycle, list_cycles, update_cycle
from app.common.date_resolution import DATE_RESOLUTIONS, date_label
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.planning import ProjectUpdateSnapshot
from app.common.issue_conversion import convert_to_project
from app.common.issue_keys import current
from app.common.issue_writes import bulk_update_issues
from app.common.milestone_conversion import convert_milestone_to_project
from app.common.milestone_writes import create_milestone, delete_milestone, update_milestone
from app.common.planning_rules import (
    counts_unestimated,
    load_readable_cycle,
    load_readable_project,
    require_team_member,
    require_team_reader,
)
from app.common.project_activity import activity_page
from app.common.project_cadence import INTERVAL_OPTIONS, workspace_interval
from app.common.project_filters import parse_property_filter
from app.common.project_link_writes import create_link, delete_link, project_links, update_link
from app.common.project_relations import create_relation, delete_relation, fill_one, list_relations
from app.common.project_update_report import report_lines
from app.common.project_updates import (
    create_project_update,
    delete_project_update,
    list_project_updates,
    update_project_update,
)
from app.common.project_writes import (
    create_project,
    delete_project,
    list_projects,
    set_project_archived,
    update_project,
)
from app.common.readable_ids import project_web_url
from app.common.team_time import team_today
from app.common.update_drafts import clear_posted_update_draft
from app.domains.integrations.mcp.project_label_tools import project_label_ids
from app.domains.integrations.mcp.project_status_tools import (
    STATUS_HELP,
    project_status_fields,
    status_filter_value,
    status_names,
)
from app.domains.integrations.mcp.template_tools import project_template_ref
from app.domains.integrations.mcp.toolkit import (
    NOT_VISIBLE,
    Tool,
    ToolCall,
    ambiguous,
    enum,
    filter_values,
    initiative_id_ref,
    issue_ref,
    limit,
    nullable,
    nullable_enum,
    object_schema,
    one_or_many,
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

PROJECT_HEALTHS: tuple[str, ...] = get_args(ProjectHealthField)

PROJECT_PRIORITIES: tuple[str, ...] = get_args(ProjectPriorityField)

PROJECT_ICONS: tuple[str, ...] = get_args(ProjectIconField)

PROJECT_SORTS: tuple[str, ...] = get_args(ProjectSortField)

OPEN_ISSUE_ACTIONS: tuple[str, ...] = get_args(ProjectOpenIssuesAction)

PROJECT_FIELDS: tuple[str, ...] = (
    "name",
    "description",
    "start_date",
    "target_date",
    "start_date_resolution",
    "target_date_resolution",
    "icon",
    "color",
    "health",
    "priority",
)

CLEARABLE_FIELDS: tuple[str, ...] = ("description", "start_date", "target_date", "icon", "color", "health")
"""The project fields a tool call clears by passing null."""

TEAM_HELP = "The team: id, key such as ENG, or name"

CYCLE_HELP = "The cycle: id, name, or current, next or previous on the team's schedule"

PROJECT_HELP = "The project: id, short id or name"

INITIATIVE_HELP = "The initiative: id or name"

MILESTONE_HELP = "The milestone: id or name within the project"

LINK_HELP = "The Resources link: id, or its exact URL within the project"


def _team_id(call: ToolCall, name: str = "team_id") -> str:
    """The id of the visible team one required argument names."""
    return team_id_ref(call, call.require(name))


def _project_id(call: ToolCall, value: Any) -> str:
    """A project id from an id or a name unique among the projects the caller can see."""
    return project_id_ref(call, value)


def _cycle_id(call: ToolCall, team_id: str, value: Any) -> str:
    """A cycle id of one readable team from an id, `current`, `next`, `previous`, or a unique name."""
    reference = str(value).strip()
    if not reference:
        raise ToolError("cycle_id is required")
    require_team_reader(call.repositories, call.context, team_id)
    workspace_id = call.context.workspace_id
    if call.repositories.planning.get_cycle(workspace_id, team_id, reference) is not None:
        return reference
    cycles = call.repositories.planning.list_for_roadmap(workspace_id, team_id)
    folded = reference.casefold()
    if folded in RELATIVE_CYCLES:
        found = relative_cycle(cycles, folded, team_today(call.repositories, workspace_id, team_id))
        if found is None:
            team = call.repositories.teams.get(workspace_id, team_id)
            raise ToolError(f"Team {team.key_prefix if team is not None else team_id} has no {folded} cycle")
        return found.cycle_id
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


def _link_id(call: ToolCall, project_id: str, value: Any) -> str:
    """A Resources link id of one project from an id or a URL held by exactly one of its links."""
    reference = str(value).strip()
    if not reference:
        raise ToolError("link_id is required")
    workspace_id = call.context.workspace_id
    if call.repositories.planning.get_project_link(workspace_id, project_id, reference) is not None:
        return reference
    named = [
        row for row in call.repositories.planning.list_project_links(workspace_id, project_id) if row.url == reference
    ]
    if len(named) > 1:
        raise ambiguous("link", reference)
    if not named:
        raise ToolError(NOT_VISIBLE)
    return named[0].link_id


def _link_json(link: ProjectLinkRead) -> dict[str, Any]:
    """One Resources link as the tools answer it, in its project's manual order."""
    return {
        "link_id": link.link_id,
        "project_id": link.project_id,
        "url": link.url,
        "title": link.title,
        "created_by": link.created_by,
        "created_at": link.created_at.isoformat(),
    }


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
        "gap_before_days": cycle.gap_before_days,
    }


def _project_json(project: ProjectRead, names: dict[str, str]) -> dict[str, Any]:
    """One project as the tools answer it, its teams narrowed to the visible ones.

    `status` is the category every rule reads, and `status_id` and `status_name`
    the workspace project status the project sits in. `body_version` is the
    description's version, sent back as `base_body_version` when editing it.
    """
    return {
        "project_id": project.project_id,
        "slug_id": project.slug_id,
        "team_ids": project.team_ids,
        "name": project.name,
        "description": project.description,
        "body_version": project.body_version,
        "lead_id": project.lead_id,
        "status": project.status,
        "status_id": project.status_id,
        "status_name": names.get(project.status_id, project.status),
        "health": project.health,
        "priority": project.priority,
        "icon": project.icon,
        "color": project.color,
        "member_ids": project.member_ids,
        "label_ids": project.label_ids,
        "initiative_id": project.initiative_id,
        "start_date": project.start_date,
        "target_date": project.target_date,
        "start_date_resolution": project.start_date_resolution,
        "target_date_resolution": project.target_date_resolution,
        "start_date_label": date_label(project.start_date, project.start_date_resolution),
        "target_date_label": date_label(project.target_date, project.target_date_resolution),
        "counts": project.counts.model_dump(),
        "status_counts": project.status_counts,
        "last_update_at": project.last_update_at.isoformat() if project.last_update_at else None,
        "update_interval_days": project.update_interval_days,
        "update_interval_inherited": project.update_interval_inherited,
        "next_update_due_at": project.next_update_due_at.isoformat() if project.next_update_due_at else None,
        "update_due_state": project.update_due_state,
        "blocked_by_project_ids": project.blocked_by_project_ids,
        "blocking_project_ids": project.blocking_project_ids,
        **({} if project.open_issue_count is None else {"open_issue_count": project.open_issue_count}),
        **(
            {} if project.customer_request_count is None else {"customer_request_count": project.customer_request_count}
        ),
        **(
            {}
            if project.customer_important_count is None
            else {"customer_important_count": project.customer_important_count}
        ),
        **({} if project.customer_revenue is None else {"customer_revenue": project.customer_revenue}),
        **(
            {}
            if project.skipped_template_issues is None
            else {"skipped_template_issues": [row.model_dump() for row in project.skipped_template_issues]}
        ),
        "archived_at": project.archived_at.isoformat() if project.archived_at else None,
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
        "status_counts": milestone.status_counts,
    }


def _project_update_json(update: ProjectUpdateRead) -> dict[str, Any]:
    """One project update as the tools answer it, with whether the caller may change it, its thread and report."""
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
        "comment_count": update.comment_count,
        "reactions": [group.model_dump(mode="json") for group in update.reactions],
        "hide_details": update.hide_details,
        "report": _update_report(update),
    }


def _update_report(update: ProjectUpdateRead) -> list[str]:
    """The update's progress report as plain lines, empty when it has none or its author hid it."""
    if update.hide_details or update.snapshot is None:
        return []
    previous = update.previous_snapshot
    return report_lines(
        ProjectUpdateSnapshot.model_validate(update.snapshot.model_dump()),
        ProjectUpdateSnapshot.model_validate(previous.model_dump()) if previous is not None else None,
    )


def _list_cycles(call: ToolCall) -> Any:
    """One page of a team's cycles by start date, optionally narrowed by status.

    The status is derived from the dates, so it is filtered after the read, as the
    cycles route does, and a page can come back shorter than the limit while
    next_cursor still names more. `include_sub_teams` rolls in the cycles of the
    team's sub-teams this credential may read.
    """
    team_id = _team_id(call)
    wanted = call.optional("status")
    if wanted is not None and wanted not in CYCLE_STATUSES:
        raise ToolError(f"status must be one of: {', '.join(CYCLE_STATUSES)}")
    cycles, next_cursor = list_cycles(
        call.repositories,
        call.context,
        team_id,
        status_filter=str(wanted) if wanted is not None else None,
        cursor=call.optional("cursor"),
        limit=limit(call.optional("limit")),
        include_sub_teams=call.optional("include_sub_teams", False) is True,
    )
    return {"cycles": [_cycle_json(row) for row in cycles], "next_cursor": next_cursor}


def _get_cycle(call: ToolCall) -> Any:
    """One cycle of a visible team, with its counts."""
    team_id = _team_id(call)
    cycle_id = _cycle_id(call, team_id, call.require("cycle_id"))
    cycle = load_readable_cycle(call.repositories, call.context, team_id, cycle_id)
    counted = counts_unestimated(call.repositories, call.context.workspace_id, team_id)
    today = team_today(call.repositories, call.context.workspace_id, team_id).isoformat()
    return _cycle_json(CycleRead.from_row(cycle, today, count_unestimated=counted))


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


def _start_cycle_today(call: ToolCall) -> Any:
    """Start the next upcoming cycle today, ending the current one and rolling its open issues in."""
    team_id = _team_id(call)
    cycle_id = _cycle_id(call, team_id, call.require("cycle_id"))
    result = start_cycle_today_read(call.repositories, call.context, team_id, cycle_id)
    return {
        "cycle": _cycle_json(result.cycle),
        "ended": None if result.ended is None else _cycle_json(result.ended),
        "moved_issues": result.moved_issues,
    }


def _end_cycle_today(call: ToolCall) -> Any:
    """End the current cycle at the close of today; the cycle close rolls its open issues on."""
    team_id = _team_id(call)
    cycle_id = _cycle_id(call, team_id, call.require("cycle_id"))
    return _cycle_json(end_cycle_today(call.repositories, call.context, team_id, cycle_id))


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
    return {
        "cycle_id": cycle_id,
        "issues": [summary_json(call.repositories.teams, issue) for issue in stored],
        "skipped": skipped,
    }


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
    unchanged = [current(call.repositories.teams, issue).key for issue in issues if issue.cycle_id != cycle_id]
    stored, skipped = _bulk_cycle(call, inside, None) if inside else ([], [])
    return {
        "cycle_id": cycle_id,
        "issues": [summary_json(call.repositories.teams, issue) for issue in stored],
        "not_in_cycle": unchanged,
        "skipped": skipped,
    }


def _list_projects(call: ToolCall) -> Any:
    """One page of the projects on teams this credential can see."""
    team_id = _team_id(call) if call.optional("team_id") is not None else None
    status_filter = call.optional("status")
    initiative = call.optional("initiative_id")
    sort = call.optional("sort")
    labels = filter_values(call.optional("label_id"))
    rows, next_cursor = list_projects(
        call.repositories,
        call.context,
        team_id=team_id,
        initiative_id=initiative_id_ref(call, initiative) if initiative is not None else None,
        status_filter=status_filter_value(call, status_filter) if status_filter else None,
        cursor=call.optional("cursor"),
        limit=limit(call.optional("limit")),
        include_sub_teams=call.optional("include_sub_teams", False) is True,
        is_blocked=_optional_flag(call, "is_blocked"),
        is_blocking=_optional_flag(call, "is_blocking"),
        customer_id=filter_values(call.optional("customer_id")),
        customer_id_not=filter_values(call.optional("customer_id_not")),
        sort=str(sort) if sort else None,
        label_id=project_label_ids(call, labels, allow_none=True) if labels is not None else None,
        include_archived=call.optional("include_archived", False) is True,
        properties=parse_property_filter(
            health=filter_values(call.optional("health")),
            priority=filter_values(call.optional("priority")),
            member_id=_member_values(call),
            start_date_before=call.optional("start_date_before"),
            start_date_after=call.optional("start_date_after"),
            target_date_before=call.optional("target_date_before"),
            target_date_after=call.optional("target_date_after"),
            updated_within_days=call.optional("updated_within_days"),
            not_updated_within_days=call.optional("not_updated_within_days"),
        ),
    )
    names = status_names(call)
    return {"projects": [_project_json(row, names) for row in rows], "next_cursor": next_cursor}


def _member_values(call: ToolCall) -> Optional[list[str]]:
    """The member filter with `me` read as the caller, `none` kept for projects with no members."""
    values = filter_values(call.optional("member_id"))
    if values is None:
        return None
    return [value if value == "none" else (resolve_user(call, value) or value) for value in values]


def _optional_flag(call: ToolCall, name: str) -> Optional[bool]:
    """One optional true or false argument, None when absent, refusing anything else."""
    value = call.optional(name)
    if value is None or isinstance(value, bool):
        return value
    raise ToolError(f"{name} must be true or false")


def _get_project(call: ToolCall) -> Any:
    """One project with its milestones and Resources links, when at least one of its teams is visible."""
    project_id = _project_id(call, call.require("project_id"))
    project, visible = load_readable_project(call.repositories, call.context, project_id)
    default_days = workspace_interval(call.repositories.workspaces, call.context.workspace_id)
    read = fill_one(
        call.repositories, call.context, ProjectRead.from_row(project, visible, default_interval_days=default_days)
    )
    body = _project_json(read, status_names(call))
    workspace = call.repositories.workspaces.get(call.context.workspace_id)
    if workspace is not None:
        body["web_url"] = project_web_url(workspace.slug, project.project_id, project.name)
    milestones = call.repositories.planning.list_milestones(call.context.workspace_id, project.project_id)
    body["milestones"] = [_milestone_json(MilestoneRead.from_row(row)) for row in milestones]
    body["links"] = [
        _link_json(link) for link in project_links(call.repositories, call.context.workspace_id, project.project_id)
    ]
    return body


def _project_payload(call: ToolCall, *, nullable_fields: bool) -> dict[str, Any]:
    """The project fields named in a tool call, as the route's body would carry them."""
    payload: dict[str, Any] = {}
    for name in PROJECT_FIELDS:
        if call.optional(name) is not None:
            payload[name] = call.arguments[name]
        elif nullable_fields and call.present(name) and name in CLEARABLE_FIELDS:
            payload[name] = None
    payload.update(project_status_fields(call, call.optional("status"), call.optional("status_id")))
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
    if call.optional("label_ids") is not None:
        labels = call.arguments["label_ids"]
        if not isinstance(labels, list):
            raise ToolError("label_ids must be a list of project labels")
        payload["label_ids"] = project_label_ids(call, labels)
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
    fields = _project_payload(call, nullable_fields=False)
    if call.optional("template_id") is not None:
        teams = fields.get("team_ids") or []
        fields["template_id"] = project_template_ref(call, teams, call.arguments["template_id"]).template_id
    payload = ProjectCreate.model_validate(fields)
    return _project_json(create_project(call.repositories, call.context, payload), status_names(call))


def _convert_issue_to_project(call: ToolCall) -> Any:
    """Turn an issue into a project on its team through the route's own path."""
    issue = issue_ref(call, call.require("issue_id"))
    project, closed, moved = convert_to_project(call.repositories, call.context, issue)
    return {
        "project": _project_json(project, status_names(call)),
        "issue": summary_json(call.repositories.teams, closed),
        "moved_issues": [summary_json(call.repositories.teams, child) for child in moved],
    }


def _open_issues(call: ToolCall) -> Optional[dict[str, Any]]:
    """The `open_issues` choice a tool call names, its move target resolved, or `None`."""
    action = call.optional("open_issues")
    target = call.optional("open_issues_project_id")
    if action is None:
        if target is not None:
            raise ToolError("open_issues_project_id is only taken with open_issues set to move")
        return None
    if action not in OPEN_ISSUE_ACTIONS:
        raise ToolError(f"open_issues must be one of: {', '.join(OPEN_ISSUE_ACTIONS)}")
    if action != "move":
        if target is not None:
            raise ToolError("open_issues_project_id is only taken with open_issues set to move")
        return {"action": action}
    if target is None:
        raise ToolError("open_issues_project_id is required to move the open issues")
    return {"action": action, "project_id": _project_id(call, target)}


def _update_project(call: ToolCall) -> Any:
    """Patch a project's fields or its teams, through the route's own path.

    `base_body_version` guards a new description against overwriting one someone
    else changed since it was read; a stale one is refused with the current
    description and its version.
    """
    project_id = _project_id(call, call.require("project_id"))
    fields = _project_payload(call, nullable_fields=True)
    if call.optional("base_body_version") is not None:
        fields["base_body_version"] = call.arguments["base_body_version"]
    choice = _open_issues(call)
    if choice is not None:
        fields["open_issues"] = choice
    payload = ProjectUpdate.model_validate(fields)
    return _project_json(update_project(call.repositories, call.context, project_id, payload), status_names(call))


def _archive_project(call: ToolCall) -> Any:
    """Archive a project, hiding it from the projects list until it is restored."""
    project_id = _project_id(call, call.require("project_id"))
    return _project_json(set_project_archived(call.repositories, call.context, project_id, True), status_names(call))


def _unarchive_project(call: ToolCall) -> Any:
    """Restore an archived project to the projects list."""
    project_id = _project_id(call, call.require("project_id"))
    return _project_json(set_project_archived(call.repositories, call.context, project_id, False), status_names(call))


def _delete_project(call: ToolCall) -> Any:
    """Delete a project as an administrator of every one of its teams."""
    project_id = _project_id(call, call.require("project_id"))
    delete_project(call.repositories, call.context, project_id)
    return {"deleted": True, "project_id": project_id}


def _project_relation_json(relation: ProjectRelationRead) -> dict[str, Any]:
    """One project dependency as the tools answer it, read from the named project's side."""
    return {
        "relation_id": relation.relation_id,
        "project_id": relation.project_id,
        "type": relation.type,
        "target_project_id": relation.target_project_id,
        "created_at": relation.created_at.isoformat(),
    }


def _list_project_relations(call: ToolCall) -> Any:
    """Every dependency of a visible project whose other end is visible too."""
    project_id = _project_id(call, call.require("project_id"))
    rows = list_relations(call.repositories, call.context, project_id)
    return {"relations": [_project_relation_json(row) for row in rows]}


def _create_project_relation(call: ToolCall) -> Any:
    """Make one project block, or be blocked by, another, idempotently on the same pair."""
    project_id = _project_id(call, call.require("project_id"))
    target_id = _project_id(call, call.require("target_project_id"))
    payload = ProjectRelationCreate.model_validate({"type": call.require("type"), "target_project_id": target_id})
    relation, _ = create_relation(call.repositories, call.context, project_id, payload)
    return _project_relation_json(relation)


def _delete_project_relation(call: ToolCall) -> Any:
    """Remove a dependency of a project, named by its id or by the project at its other end."""
    project_id = _project_id(call, call.require("project_id"))
    relation_id = call.optional("relation_id")
    if not relation_id:
        target = call.optional("target_project_id")
        if target is None:
            raise ToolError("Name the dependency by relation_id or by target_project_id")
        target_id = _project_id(call, target)
        matches = [
            row.relation_id
            for row in list_relations(call.repositories, call.context, project_id)
            if row.target_project_id == target_id
        ]
        if not matches:
            raise ToolError("Those projects are not linked")
        relation_id = matches[0]
    other = delete_relation(call.repositories, call.context, project_id, str(relation_id))
    return {"deleted": True, "relation_id": str(relation_id), "project_id": project_id, "target_project_id": other}


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


def _convert_milestone_to_project(call: ToolCall) -> Any:
    """Turn a milestone into a project of its own through the route's own path."""
    project_id = _project_id(call, call.require("project_id"))
    load_readable_project(call.repositories, call.context, project_id)
    milestone_id = _milestone_id(call, project_id, call.require("milestone_id"))
    project, moved = convert_milestone_to_project(call.repositories, call.context, project_id, milestone_id)
    return {
        "project": _project_json(project, status_names(call)),
        "milestone_id": milestone_id,
        "moved_issues": [summary_json(call.repositories.teams, issue) for issue in moved],
    }


def _create_project_link(call: ToolCall) -> Any:
    """Add a Resources link after a project's last one, through the route's own path."""
    project_id = _project_id(call, call.require("project_id"))
    payload: dict[str, Any] = {"url": call.require("url")}
    if call.optional("title") is not None:
        payload["title"] = call.arguments["title"]
    created = create_link(call.repositories, call.context, project_id, ProjectLinkCreate.model_validate(payload))
    return _link_json(created)


def _update_project_link(call: ToolCall) -> Any:
    """Retitle or repoint a Resources link; a null or blank title clears it."""
    project_id = _project_id(call, call.require("project_id"))
    load_readable_project(call.repositories, call.context, project_id)
    link_id = _link_id(call, project_id, call.require("link_id"))
    payload: dict[str, Any] = {}
    if call.optional("url") is not None:
        payload["url"] = call.arguments["url"]
    if call.present("title"):
        payload["title"] = call.arguments["title"]
    updated = update_link(
        call.repositories, call.context, project_id, link_id, ProjectLinkUpdate.model_validate(payload)
    )
    return _link_json(updated)


def _delete_project_link(call: ToolCall) -> Any:
    """Remove a Resources link from a project."""
    project_id = _project_id(call, call.require("project_id"))
    load_readable_project(call.repositories, call.context, project_id)
    link_id = _link_id(call, project_id, call.require("link_id"))
    delete_link(call.repositories, call.context, project_id, link_id)
    return {"deleted": True, "link_id": link_id, "project_id": project_id}


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


def _list_project_activity(call: ToolCall) -> Any:
    """One page of a visible project's property and milestone changes, newest first."""
    rows, next_cursor = activity_page(
        call.repositories,
        call.context,
        _project_id(call, call.require("project_id")),
        cursor=call.optional("cursor"),
        limit=limit(call.optional("limit")),
    )
    return {"activity": [row.model_dump(mode="json", by_alias=True) for row in rows], "next_cursor": next_cursor}


def _create_project_update(call: ToolCall) -> Any:
    """Post an update on a project the caller may edit, setting the project's health, from a template if named."""
    project_id = _project_id(call, call.require("project_id"))
    fields = {
        "body": call.optional("body"),
        "template_id": call.optional("template_id"),
        "hide_details": call.optional("hide_details"),
    }
    payload = ProjectUpdateCreate.model_validate(
        {"health": call.require("health"), **{name: value for name, value in fields.items() if value is not None}}
    )
    created = create_project_update(call.repositories, call.context, project_id, payload)
    clear_posted_update_draft(
        call.repositories,
        call.context.workspace_id,
        created.author_id,
        "project",
        created.project_id,
        created.created_at,
    )
    return _project_update_json(created)


def _update_project_update(call: ToolCall) -> Any:
    """Edit an update's body or health as its author or an admin, through the route's own path."""
    project_id = _project_id(call, call.require("project_id"))
    payload: dict[str, Any] = {}
    for name in ("body", "health", "hide_details"):
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
    "start_date": nullable("Start date, YYYY-MM-DD; any day in the period when start_date_resolution is coarse"),
    "target_date": nullable("Target date, YYYY-MM-DD; any day in the period when target_date_resolution is coarse"),
    "start_date_resolution": enum(
        DATE_RESOLUTIONS,
        "How wide start_date is: day (the default), or the month, quarter, half or year it opens; "
        "the date moves to that period's first day",
    ),
    "target_date_resolution": enum(
        DATE_RESOLUTIONS,
        "How wide target_date is: day (the default), or the month, quarter, half or year it closes; "
        "the date moves to that period's last day",
    ),
    "status": string(STATUS_HELP),
    "status_id": string("The project status by id or name, as list_project_statuses names it"),
    "team_ids": string_list(
        "Every team the project is on, each an id, key such as ENG, or name; the caller must write in each one added"
    ),
    "health": nullable_enum(PROJECT_HEALTHS, "The project health, or null for none"),
    "priority": enum(PROJECT_PRIORITIES, "The project priority"),
    "icon": nullable_enum(PROJECT_ICONS, "The project icon, or null for the default"),
    "color": nullable("The project colour as #rrggbb, or null"),
    "member_ids": string_list("Every member of the project by user id, 'me' for the caller; replaces the list"),
    "label_ids": string_list("Every project label on the project, each an id or a name; replaces the list"),
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
                "include_sub_teams": {
                    "type": "boolean",
                    "description": "Also list the cycles of that team's sub-teams, default false",
                },
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
            "Only the fields named are written; null clears the goal. "
            "Dates already in the past cannot change and no date may move before today. "
            "Extending a cycle into the next one moves that cycle's start to the day after, "
            "refused when it would leave the next cycle no days. "
            "A name ending in a number renumbers the automatically named cycles after it."
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
        name="start_cycle_today",
        description=(
            "Start a team's next upcoming cycle today. The current cycle ends yesterday and its "
            "unfinished issues move into the started cycle, which keeps its end date. "
            "Refused for any cycle but the next upcoming one."
        ),
        scopes=("cycles:write",),
        schema=object_schema(
            {"team_id": string(TEAM_HELP), "cycle_id": string(CYCLE_HELP)},
            required=("team_id", "cycle_id"),
        ),
        handler=_start_cycle_today,
    ),
    Tool(
        name="end_cycle_today",
        description=(
            "End a team's current cycle at the close of today in the team's timezone. "
            "The next cycle keeps its dates, and unfinished issues roll into it when the cycle closes. "
            "Refused for any cycle but the current one."
        ),
        scopes=("cycles:write",),
        schema=object_schema(
            {"team_id": string(TEAM_HELP), "cycle_id": string(CYCLE_HELP)},
            required=("team_id", "cycle_id"),
        ),
        handler=_end_cycle_today,
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
                "status": string(
                    "Only projects in this project status, by id or name, or every status of a category "
                    "(backlog, planned, in_progress or started, paused, completed, canceled)"
                ),
                "initiative_id": string(f"Only projects in this initiative. {INITIATIVE_HELP}"),
                "include_sub_teams": {
                    "type": "boolean",
                    "description": "With team_id, also list the projects of that team's sub-teams, default false",
                },
                "include_archived": {
                    "type": "boolean",
                    "description": "Also list archived projects, default false",
                },
                "is_blocked": {
                    "type": "boolean",
                    "description": "true for projects an open project blocks, false for the rest",
                },
                "is_blocking": {
                    "type": "boolean",
                    "description": "true for open projects that block another project, false for the rest",
                },
                "customer_id": one_or_many(
                    "Only projects any of these customers asked for; 'none' is projects no customer asked for, "
                    "'important' projects with an important request"
                ),
                "customer_id_not": one_or_many("Only projects none of these customers asked for"),
                "label_id": one_or_many(
                    "Only projects carrying any of these project labels, by id or name; 'none' is projects with none"
                ),
                "health": one_or_many(
                    "Only projects in any of these healths: on_track, at_risk, off_track, or 'none' for no health"
                ),
                "priority": one_or_many("Only projects at any of these priorities: none, urgent, high, medium, low"),
                "member_id": one_or_many(
                    "Only projects with any of these members, by user id or 'me'; 'none' is projects with no members"
                ),
                "start_date_before": string(
                    "Only projects starting before this day, YYYY-MM-DD or relative to today such as +2w or -1m"
                ),
                "start_date_after": string(
                    "Only projects starting after this day, YYYY-MM-DD or relative to today such as +2w or -1m"
                ),
                "target_date_before": string(
                    "Only projects targeting a day before this one, YYYY-MM-DD or relative to today such as +2w or -1m"
                ),
                "target_date_after": string(
                    "Only projects targeting a day after this one, YYYY-MM-DD or relative to today such as +2w or -1m"
                ),
                "updated_within_days": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Only projects with a project update posted in the last this many days",
                },
                "not_updated_within_days": {
                    "type": "integer",
                    "minimum": 1,
                    "description": (
                        "Only projects with no project update in the last this many days, never updated ones included"
                    ),
                },
                "sort": enum(
                    PROJECT_SORTS,
                    "The order, defaulting to target_asc; customer_requests_desc puts the most customer requests "
                    "first, customer_important_desc the most important ones and customer_revenue_desc the highest "
                    "summed revenue of the customers asking",
                ),
                **page_properties(),
            }
        ),
        handler=_list_projects,
    ),
    Tool(
        name="get_project",
        description=(
            "One project with its teams, lead, members, dates, status, health, priority, counts, milestones, "
            "Resources links and its update cadence and due state."
        ),
        scopes=("projects:read",),
        schema=object_schema({"project_id": string(PROJECT_HELP)}, required=("project_id",)),
        handler=_get_project,
    ),
    Tool(
        name="create_project",
        description=(
            "Create a project on one or more teams. The status defaults to backlog. template_id names a project "
            "template one of the teams offers: it fills every field not given, dates counted from today, and "
            "adds its milestones and issues. A template issue the issue rules refuse is left out and listed in "
            "skipped_template_issues."
        ),
        scopes=("projects:write",),
        schema=object_schema(
            {**PROJECT_PROPERTIES, "template_id": string("A project template: its id or its name")},
            required=("name", "team_ids"),
        ),
        handler=_create_project,
    ),
    Tool(
        name="convert_issue_to_project",
        description=(
            "Turn an issue into a project on its team. The project takes the issue's title, body, priority, "
            "assignee as lead and dates; the issue's sub-issues leave it and join the project; the issue is "
            "put in the project and closed in the team's first completed status, or cancelled without one."
        ),
        scopes=("issues:write", "projects:write"),
        schema=object_schema(
            {"issue_id": string("The issue's id, or its key such as ABC-123")}, required=("issue_id",)
        ),
        handler=_convert_issue_to_project,
    ),
    Tool(
        name="update_project",
        description=(
            "Change a project's fields or its teams. Only the fields named are written; "
            "null clears the description, lead, dates, icon, colour, health and initiative, and returns the update "
            "cadence to the workspace default. Completing or canceling a project answers open_issue_count, the "
            "issues still open in it; open_issues keeps them, moves them to open_issues_project_id, or cancels "
            "them, and moving or canceling also needs issues:write."
        ),
        scopes=("projects:write",),
        schema=object_schema(
            {
                "project_id": string(PROJECT_HELP),
                **PROJECT_PROPERTIES,
                "base_body_version": string(
                    "The body_version the new description was written against; when the description changed "
                    "since, the update is refused with the current description and version instead of overwriting it"
                ),
                "open_issues": enum(
                    OPEN_ISSUE_ACTIONS,
                    "When the status is completed or canceled, what to do with the issues still open: keep them, "
                    "move them to open_issues_project_id, or cancel them; omitted keeps them",
                ),
                "open_issues_project_id": string(f"{PROJECT_HELP} the open issues move to, with open_issues move"),
            },
            required=("project_id",),
        ),
        handler=_update_project,
    ),
    Tool(
        name="archive_project",
        description=(
            "Archive a project: it leaves the projects list but keeps its issues, milestones and updates, "
            "and can be restored. Archiving an archived project answers it unchanged."
        ),
        scopes=("projects:write",),
        schema=object_schema({"project_id": string(PROJECT_HELP)}, required=("project_id",)),
        handler=_archive_project,
    ),
    Tool(
        name="unarchive_project",
        description="Restore an archived project to the projects list. Restoring a live project answers it unchanged.",
        scopes=("projects:write",),
        schema=object_schema({"project_id": string(PROJECT_HELP)}, required=("project_id",)),
        handler=_unarchive_project,
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
        name="list_project_relations",
        description=(
            "Every dependency of a project, read from its side: blocks when it holds the other project up, "
            "blocked_by when it waits on it."
        ),
        scopes=("projects:read",),
        schema=object_schema({"project_id": string(PROJECT_HELP)}, required=("project_id",)),
        handler=_list_project_relations,
    ),
    Tool(
        name="create_project_relation",
        description=(
            "Make a project block, or be blocked by, another project. Linking a pair already linked the same way "
            "answers the stored link; a link to itself or one that closes a loop is refused."
        ),
        scopes=("projects:write",),
        schema=object_schema(
            {
                "project_id": string(PROJECT_HELP),
                "type": enum(("blocks", "blocked_by"), "blocks when project_id holds the target up"),
                "target_project_id": string(f"{PROJECT_HELP} at the other end"),
            },
            required=("project_id", "type", "target_project_id"),
        ),
        handler=_create_project_relation,
    ),
    Tool(
        name="delete_project_relation",
        description="Remove a dependency between two projects, named by its relation_id or by the other project.",
        scopes=("projects:write",),
        schema=object_schema(
            {
                "project_id": string(PROJECT_HELP),
                "relation_id": string("The dependency, from list_project_relations"),
                "target_project_id": string(f"{PROJECT_HELP} at the other end, instead of relation_id"),
            },
            required=("project_id",),
        ),
        handler=_delete_project_relation,
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
        name="convert_milestone_to_project",
        description=(
            "Turn a milestone into a project of its own. The project takes the milestone's name, description "
            "and target date, and the source project's teams, lead and priority; every issue on the milestone "
            "moves into it with no milestone, and the milestone is deleted."
        ),
        scopes=("milestones:write", "projects:write", "issues:write"),
        schema=object_schema(
            {"project_id": string(PROJECT_HELP), "milestone_id": string(MILESTONE_HELP)},
            required=("project_id", "milestone_id"),
        ),
        handler=_convert_milestone_to_project,
    ),
    Tool(
        name="create_project_link",
        description=(
            "Add an external link to a project's Resources section, after its last one. "
            "Without a title the link reads as its hostname; the linked page is never fetched."
        ),
        scopes=("projects:write",),
        schema=object_schema(
            {
                "project_id": string(PROJECT_HELP),
                "url": string("An absolute http or https URL"),
                "title": string("What the link reads as; its hostname when left out"),
            },
            required=("project_id", "url"),
        ),
        handler=_create_project_link,
    ),
    Tool(
        name="update_project_link",
        description=(
            "Change the URL or title of a link in a project's Resources section. "
            "Only the fields named are written; a null title clears it so the link reads as its hostname."
        ),
        scopes=("projects:write",),
        schema=object_schema(
            {
                "project_id": string(PROJECT_HELP),
                "link_id": string(LINK_HELP),
                "url": string("An absolute http or https URL"),
                "title": nullable("What the link reads as, or null for its hostname"),
            },
            required=("project_id", "link_id"),
        ),
        handler=_update_project_link,
    ),
    Tool(
        name="delete_project_link",
        description="Remove a link from a project's Resources section.",
        scopes=("projects:write",),
        schema=object_schema(
            {"project_id": string(PROJECT_HELP), "link_id": string(LINK_HELP)},
            required=("project_id", "link_id"),
        ),
        handler=_delete_project_link,
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
        name="list_project_activity",
        description=(
            "One page of a project's activity, newest first: who changed its status, health, priority, lead, "
            "members, dates, teams or milestones, with the old and new value."
        ),
        scopes=("projects:read",),
        schema=object_schema(
            {"project_id": string(PROJECT_HELP), **page_properties()},
            required=("project_id",),
        ),
        handler=_list_project_activity,
    ),
    Tool(
        name="create_project_update",
        description=(
            "Post a status update on a project, in Markdown, with its health. "
            "Posting sets the project's health and notifies its lead and members. "
            "Give template_id instead of body to post a document template's body. "
            "The update records a report of what changed since the last one."
        ),
        scopes=("projects:write",),
        schema=object_schema(
            {
                "project_id": string(PROJECT_HELP),
                "body": string("The update, in Markdown. Required unless template_id is given"),
                "health": enum(PROJECT_HEALTHS, "How the project stands"),
                "template_id": string(
                    "A document template whose body the update takes when body is left out: id or name"
                ),
                "hide_details": _boolean("true hides the progress report the update carries"),
            },
            required=("project_id", "health"),
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
                "hide_details": _boolean("true hides the update's progress report, false shows it"),
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
