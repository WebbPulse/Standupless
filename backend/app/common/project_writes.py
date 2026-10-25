"""Project list, create, patch, archive and delete, shared by the project routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and a project an agent creates or edits must pass the same team, lead and
date rules a person's does.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional, get_args

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common import project_activity, pulse
from app.common.api.dependencies.authz import AuthzContext, require_scopes_present
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import decode_offset_cursor, digest_scope, encode_offset_cursor
from app.common.api.schemas.planning import (
    ProjectCreate,
    ProjectMilestoneMarkerRead,
    ProjectOpenIssues,
    ProjectRead,
    ProjectSortField,
    ProjectUpdate,
)
from app.common.customer_index import (
    CUSTOMER_SORTS,
    IMPORTANT_SORT,
    REVENUE_SORT,
    CustomerIndex,
    customer_match,
    load_customer_index,
    require_customer_list_reader,
)
from app.common.date_resolution import DateEdge, settle_date_fields, stored_resolution
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.planning import Project, new_planning_id, normalise_project_status, project_key
from app.common.db.dynamo.workspaces import WorkspaceFeature
from app.common.initiative_writes import require_initiative_access, require_initiative_target
from app.common.issue_rules import COMPLETED_CATEGORIES, require_team_member
from app.common.issue_writes import apply_patch, store_patch
from app.common.order_keys import order_key_first
from app.common.planning_rules import (
    check_project_dates,
    load_readable_project,
    not_found,
    require_project_admin,
    require_project_editor,
    require_team_changes,
    require_team_reader,
    require_workspace_member,
    unprocessable,
    visible_project_teams,
    visible_team_ids,
)
from app.common.project_cadence import workspace_interval
from app.common.project_filters import ProjectPropertyFilter
from app.common.project_labels import label_match, label_scope, label_values, require_project_labels
from app.common.project_link_writes import with_links
from app.common.project_relations import Dependencies, dependency_map, fill_one, with_dependencies
from app.common.project_statuses import (
    choose_project_status,
    project_in_filter,
    status_filter_match,
    workspace_project_statuses,
)
from app.common.project_templates import add_template_rows, fill_project, find_project_template
from app.common.relation_effects import cancelled_status, categories_for
from app.common.sub_teams import listed_teams
from app.common.workspace_features import refuse_if_disabled

NOT_NULLABLE = (
    "name",
    "status",
    "status_id",
    "team_ids",
    "priority",
    "member_ids",
    "label_ids",
    "sort_order",
)
"""Patch fields that may be omitted but never cleared, because every project has one."""

CLOSED_STATUSES = frozenset({"completed", "canceled"})
"""The project statuses that close a project, after which its open issues are asked about."""


def merged_team_ids(project: Project, visible: list[str], requested: list[str]) -> tuple[list[str], list[str]]:
    """The project's team list after a patch, and the teams the patch changes.

    `requested` replaces only the teams the caller can see; the ones they cannot
    are carried over untouched, so a guest's edit never removes a team it was
    never shown. A requested team already on the project, seen or not, is not a
    change.
    """
    hidden = [team_id for team_id in project.team_ids if team_id not in visible]
    added = [team_id for team_id in requested if team_id not in project.team_ids]
    removed = [team_id for team_id in visible if team_id not in requested]
    merged = list(requested) + [team_id for team_id in hidden if team_id not in requested]
    return merged, added + removed


def milestone_markers(
    repositories: Repositories, workspace_id: str, project_ids: set[str]
) -> dict[str, list[ProjectMilestoneMarkerRead]]:
    """The dated milestones of each listed project, earliest first, from one workspace query.

    Undated milestones are left out, since the timeline has nowhere to mark them.
    """
    if not project_ids:
        return {}
    markers: dict[str, list[ProjectMilestoneMarkerRead]] = {}
    for milestone in repositories.planning.list_workspace_milestones(workspace_id):
        if milestone.project_id not in project_ids or not milestone.target_date:
            continue
        markers.setdefault(milestone.project_id, []).append(ProjectMilestoneMarkerRead.from_row(milestone))
    for rows in markers.values():
        rows.sort(key=lambda marker: (marker.target_date, marker.milestone_id))
    return markers


PROJECT_DEFAULT_SORT = "target_asc"
"""The projects list's own order: by target date, undated last."""

PROJECT_SORTS: frozenset[str] = frozenset(get_args(ProjectSortField))
"""Every order the projects list takes."""


def customer_values(raw: Optional[list[str]]) -> frozenset[Optional[str]]:
    """Customer filter values as a set, `none` standing for no customer request."""
    values: set[Optional[str]] = set()
    for item in raw or []:
        value = str(item).strip()
        if value:
            values.add(None if value == "none" else value)
    return frozenset(values)


def customer_scope(values: frozenset[Optional[str]]) -> str:
    """One customer filter set spelled stably for a cursor scope."""
    return ",".join(sorted("none" if value is None else value for value in values))


def list_projects(
    repositories: Repositories,
    context: AuthzContext,
    *,
    team_id: Optional[str],
    status_filter: Optional[str],
    cursor: Optional[str],
    limit: int,
    initiative_id: Optional[str] = None,
    include_sub_teams: bool = False,
    is_blocked: Optional[bool] = None,
    is_blocking: Optional[bool] = None,
    customer_id: Optional[list[str]] = None,
    customer_id_not: Optional[list[str]] = None,
    sort: Optional[str] = None,
    label_id: Optional[list[str]] = None,
    include_archived: bool = False,
    properties: Optional[ProjectPropertyFilter] = None,
) -> tuple[list[ProjectRead], Optional[str]]:
    """One page of the workspace's projects the caller can see, and the next cursor.

    A project is listed when the caller can see at least one of its teams, and
    `team_id` narrows to the projects that team is on and `initiative_id` to the
    ones in that initiative, which a guest may not filter by. The rows are read whole
    and paged over the filtered order, so a page is never left short by projects
    the caller cannot see. `include_sub_teams` widens `team_id` to the team and
    its sub-teams the caller may read, as the issue list does. `is_blocked` keeps
    the projects an open visible blocker holds up, or with false the rest, and
    `is_blocking` the open projects that hold a visible project up, or with false
    the rest, the same reading as the list's blocked and blocking flags.

    `customer_id` keeps the projects one of the named customers asked for and
    `customer_id_not` drops them, `none` standing for no request and `important`
    for any important one. `sort` set to `customer_requests_desc`,
    `customer_important_desc` or `customer_revenue_desc` orders by request count,
    important request count or the asking customers' summed revenue, highest
    first, target date breaking ties. Each reads the workspace's requests once and
    fills `customer_request_count` and `customer_important_count`,
    and neither is open to a guest. `label_id` keeps the projects carrying any of
    the named project labels, `none` standing for a project with no label.
    Archived projects are left out unless `include_archived` is set, as Linear
    hides them from its lists, though they still count as blockers.
    `status_filter` names a project status, a team's included, or a category to keep
    every status in it, the legacy `done` included. `properties` holds the
    health, priority, member, date and update age filters, update age measured
    back from now.
    """
    statuses = workspace_project_statuses(repositories, context.workspace_id) if status_filter is not None else []
    wanted_status = None if status_filter is None else status_filter_match(statuses, status_filter)
    wanted_teams: set[str] | None = None
    if team_id is not None:
        require_team_reader(repositories, context, team_id)
        wanted_teams = set(listed_teams(repositories, context, team_id, include_sub_teams=include_sub_teams))
    if initiative_id is not None:
        require_initiative_access(context)
    if sort is not None and sort not in PROJECT_SORTS:
        raise unprocessable(f"Unknown project sort: {sort}")
    wanted_customers = customer_values(customer_id)
    wanted_labels = label_values(label_id)
    unwanted_customers = customer_values(customer_id_not)
    filtered = bool(wanted_customers or unwanted_customers)
    require_customer_list_reader(context, filtered, sort)
    index: Optional[CustomerIndex] = None
    if filtered or sort in CUSTOMER_SORTS:
        index = load_customer_index(repositories, context.workspace_id, with_revenue=sort == REVENUE_SORT)

    wanted_properties = properties if properties is not None and properties.active else None
    now = utc_now()
    visible = set(visible_team_ids(repositories, context))
    default_days = workspace_interval(repositories.workspaces, context.workspace_id)
    bodies: list[ProjectRead] = []
    readable: set[str] = set()
    closed: set[str] = set()
    for row in repositories.planning.list_projects(context.workspace_id):
        teams = visible_project_teams(row, visible)
        if not teams:
            continue
        readable.add(row.project_id)
        if normalise_project_status(row.status) in CLOSED_STATUSES:
            closed.add(row.project_id)
        if row.archived_at is not None and not include_archived:
            continue
        if wanted_teams is not None and wanted_teams.isdisjoint(teams):
            continue
        if wanted_status is not None and not project_in_filter(statuses, row, wanted_status):
            continue
        if initiative_id is not None and row.initiative_id != initiative_id:
            continue
        if not label_match(wanted_labels, row.label_ids):
            continue
        if wanted_properties is not None and not wanted_properties.matches(row, now):
            continue
        if index is not None and not customer_match(
            wanted_customers,
            unwanted_customers,
            index.customer_ids("project", row.project_id),
            index.important_count("project", row.project_id),
        ):
            continue
        body = ProjectRead.from_row(row, teams, default_interval_days=default_days)
        if index is not None:
            body.customer_request_count = index.request_count("project", row.project_id)
            body.customer_important_count = index.important_count("project", row.project_id)
            if sort == REVENUE_SORT:
                body.customer_revenue = index.revenue_of("project", row.project_id)
        bodies.append(body)
    if sort == "customer_requests_desc":
        bodies.sort(key=lambda body: -(body.customer_request_count or 0))
    elif sort == IMPORTANT_SORT:
        bodies.sort(key=lambda body: -(body.customer_important_count or 0))
    elif sort == REVENUE_SORT:
        bodies.sort(key=lambda body: -(body.customer_revenue or 0))

    dependencies = dependency_map(repositories.planning.list_project_relations(context.workspace_id), readable)
    if is_blocked is not None or is_blocking is not None:
        bodies = [
            body
            for body in bodies
            if _dependency_flags_match(body.project_id, dependencies, closed, is_blocked, is_blocking)
        ]
    narrowed = f"{team_id}:subs" if include_sub_teams and team_id is not None else team_id or "all"
    customers = f"{customer_scope(wanted_customers)}!{customer_scope(unwanted_customers)}"
    scope = (
        f"projects:{context.workspace_id}:{narrowed}:{':'.join(wanted_status) if wanted_status else 'all'}"
        f":{initiative_id or 'all'}"
        f":{customers}:{sort or PROJECT_DEFAULT_SORT}"
    )
    if wanted_labels:
        scope = f"{scope}:labels={label_scope(wanted_labels)}"
    if wanted_properties is not None:
        scope = f"{scope}:{wanted_properties.scope()}"
    if include_archived:
        scope = f"{scope}:archived"
    if is_blocked is not None or is_blocking is not None:
        scope = f"{scope}:{_flag_scope(is_blocked)}{_flag_scope(is_blocking)}"
    scope = digest_scope(scope)
    offset = decode_offset_cursor(cursor, scope)
    window = [with_dependencies(body, dependencies) for body in bodies[offset : offset + limit]]
    markers = milestone_markers(repositories, context.workspace_id, {body.project_id for body in window})
    for body in window:
        body.milestone_markers = markers.get(body.project_id, [])
    next_offset = offset + len(window)
    next_cursor = encode_offset_cursor(next_offset, scope) if next_offset < len(bodies) else None
    return window, next_cursor


def _flag_scope(flag: Optional[bool]) -> str:
    """One dependency filter as a letter of the cursor scope, so a cursor never crosses filters."""
    return "a" if flag is None else ("y" if flag else "n")


def _dependency_flags_match(
    project_id: str,
    dependencies: Dependencies,
    closed: set[str],
    is_blocked: Optional[bool],
    is_blocking: Optional[bool],
) -> bool:
    """Whether a project's blocked and blocking state is the one each set filter asks for."""
    blockers, held = dependencies.get(project_id, ([], []))
    blocked = any(blocker not in closed for blocker in blockers)
    blocking = project_id not in closed and bool(held)
    if is_blocked is not None and blocked != is_blocked:
        return False
    return is_blocking is None or blocking == is_blocking


def create_project(repositories: Repositories, context: AuthzContext, payload: ProjectCreate) -> ProjectRead:
    """Create a project on one or more teams.

    The caller must be able to write in every team named, since a project put on a
    team appears in that team's planning. A named project template fills the
    fields left out before anything is checked, and its milestones and issues
    are added once the project exists, its dates counted from today. Any
    template issue left out is named in `skipped_template_issues`. The new
    project takes a manual position ahead of every placed one, so it opens the
    manual ordering.
    """
    teams = payload.teams
    require_team_changes(repositories, context, teams)
    template = None
    today = utc_now().date()
    if payload.template_id:
        template = find_project_template(repositories, context, teams, payload.template_id)
        payload = fill_project(repositories, context, payload, template, today)
    if payload.lead_id is not None:
        require_workspace_member(repositories, context, payload.lead_id)
    for member_id in payload.member_ids:
        require_workspace_member(repositories, context, member_id)
    if payload.initiative_id is not None:
        refuse_if_disabled(repositories, context.workspace_id, WorkspaceFeature.INITIATIVES)
        require_initiative_target(repositories, context, payload.initiative_id)
    require_project_labels(repositories, context.workspace_id, payload.label_ids, teams)
    explicit = "status" in payload.model_fields_set or payload.status_id is None
    chosen = choose_project_status(
        repositories,
        context.workspace_id,
        status_value=payload.status if explicit else None,
        status_id=payload.status_id,
        team_ids=teams,
    )
    category, status_id = chosen if chosen is not None else (payload.status, payload.status)

    first = order_key_first(row.sort_order for row in repositories.planning.list_projects(context.workspace_id))
    project_id = new_planning_id()
    project = Project(
        workspace_id=context.workspace_id,
        planning_key=project_key(project_id),
        project_id=project_id,
        team_ids=teams,
        name=payload.name,
        description=payload.description,
        lead_id=payload.lead_id,
        start_date=payload.start_date,
        target_date=payload.target_date,
        start_date_resolution=stored_resolution(payload.start_date_resolution),
        target_date_resolution=stored_resolution(payload.target_date_resolution),
        status=category,
        status_id=status_id,
        icon=payload.icon,
        color=payload.color,
        health=payload.health,
        priority=payload.priority,
        member_ids=list(payload.member_ids),
        label_ids=list(payload.label_ids),
        update_interval_days=payload.update_interval_days,
        initiative_id=payload.initiative_id,
        completed_at=utc_now() if category in CLOSED_STATUSES else None,
        sort_order=first,
        created_by=context.user_id,
    )
    try:
        created = repositories.planning.create_project(project)
    except ConditionFailed as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error_code": "CONFLICT", "message": "That project already exists"},
        ) from exc
    project_activity.record_project_created(repositories, context, created)
    body = ProjectRead.from_row(
        created, teams, default_interval_days=workspace_interval(repositories.workspaces, context.workspace_id)
    )
    if template is not None:
        body.skipped_template_issues = add_template_rows(repositories, context, created, template, today)
    return body


def open_project_issues(
    repositories: Repositories, context: AuthzContext, project_id: str, team_ids: list[str]
) -> list[Issue]:
    """The unarchived issues of the named teams in one project whose status is neither completed nor canceled.

    Only the teams the caller can see are passed, so a count or a sweep never
    reaches an issue in a team hidden from them.
    """
    categories = categories_for(repositories, context.workspace_id, team_ids)
    issues: list[Issue] = []
    for team_id in team_ids:
        for issue in repositories.issues.iter_for_project(context.workspace_id, team_id, project_id):
            if issue.archived_at is None and categories.get(issue.status_id) not in COMPLETED_CATEGORIES:
                issues.append(issue)
    return issues


def plan_open_issues(
    repositories: Repositories,
    context: AuthzContext,
    project_id: str,
    issues: list[Issue],
    choice: ProjectOpenIssues,
) -> list[tuple[Issue, Issue]]:
    """Each open issue beside what a move or a cancel leaves it as, validated and unsaved.

    All or nothing, as a bulk issue patch is: the caller must be able to write
    in every team holding an open issue, a move target must be another project
    on each issue's team, and a cancel needs a canceled status in each team,
    so a refusal leaves the project and every issue as they were. A narrowed
    credential also needs `issues:write`, since the sweep writes issues.
    """
    if not issues:
        return []
    require_scopes_present(context, ("issues:write",))
    teams = list(dict.fromkeys(issue.team_id for issue in issues))
    for team_id in teams:
        require_team_member(repositories, context, team_id)
    attributes: dict[str, dict[str, Any]] = {}
    if choice.action == "move":
        if choice.project_id == project_id:
            raise unprocessable("open_issues.project_id must name another project")
        attributes = {team_id: {"project_id": choice.project_id} for team_id in teams}
    else:
        for team_id in teams:
            target = cancelled_status(repositories, context.workspace_id, team_id)
            if target is None:
                raise unprocessable("A team with open issues in this project has no canceled status")
            attributes[team_id] = {"status_id": target.status_id}
    return [(issue, apply_patch(repositories, context, issue, attributes[issue.team_id])) for issue in issues]


def store_open_issues(repositories: Repositories, context: AuthzContext, planned: list[tuple[Issue, Issue]]) -> int:
    """Write each planned issue through the single patch path, answering how many were written.

    An issue deleted or changed since it was read is skipped rather than failing
    the rest, as the bulk issue patch does, and so stays counted as open.
    """
    written = 0
    for issue, updated in planned:
        try:
            store_patch(repositories, context, issue, updated)
        except HTTPException as exc:
            if exc.status_code not in (status.HTTP_404_NOT_FOUND, status.HTTP_409_CONFLICT):
                raise
            continue
        written += 1
    return written


def closed_since(existing: Project, closed: bool, now: datetime) -> Optional[datetime]:
    """When a patched project closed: now on closing, kept while closed, None once open.

    A project that moves between completed and canceled keeps the time it first
    closed, and one closed before the field existed takes the time of the patch
    that next touches it, so the projects list can always window closed rows.
    """
    if not closed:
        return None
    if normalise_project_status(existing.status) in CLOSED_STATUSES and existing.completed_at is not None:
        return existing.completed_at
    return now


def update_project(
    repositories: Repositories, context: AuthzContext, project_id: str, payload: ProjectUpdate
) -> ProjectRead:
    """Patch a project's fields or its teams.

    Any writer on one of the project's visible teams may edit its fields. Changing
    `team_ids` also needs write access to every team added or removed. Setting a
    date, the lead, the description or the initiative to null clears it. The row
    is read first and written whole, so the counters the consumer maintains ride
    along untouched. Only members newly added are checked against the workspace, so a patch that
    keeps someone who has since left does not fail on them.

    A patch that completes or cancels the project answers `open_issue_count`, the
    issues still open in it, read from the issues rather than the counters the
    consumer has yet to move. `open_issues` then keeps, moves or cancels those
    issues, and is refused on a patch that leaves the project open.
    """
    existing, teams = load_readable_project(repositories, context, project_id, payload.team_id)
    require_project_editor(repositories, context, teams)

    choice = payload.open_issues
    fields: dict[str, Any] = payload.model_dump(exclude_unset=True, exclude={"team_id", "open_issues"})
    for name in NOT_NULLABLE:
        if name in fields and fields[name] is None:
            raise unprocessable(f"{name} must not be null")

    visible = set(visible_team_ids(repositories, context))
    if "team_ids" in fields:
        merged, changed = merged_team_ids(existing, teams, fields["team_ids"])
        require_team_changes(repositories, context, changed)
        if not any(team_id in visible for team_id in merged):
            raise unprocessable("team_ids must keep at least one team you can see")
        fields["team_ids"] = merged
    if fields.get("lead_id") is not None:
        require_workspace_member(repositories, context, fields["lead_id"])
    for member_id in fields.get("member_ids") or []:
        if member_id not in existing.member_ids:
            require_workspace_member(repositories, context, member_id)
    if "label_ids" in fields:
        require_project_labels(
            repositories,
            context.workspace_id,
            [label_id for label_id in fields["label_ids"] if label_id not in existing.label_ids],
            fields.get("team_ids", existing.team_ids),
        )
    if "initiative_id" in fields and fields["initiative_id"] != existing.initiative_id:
        refuse_if_disabled(repositories, context.workspace_id, WorkspaceFeature.INITIATIVES)
        require_initiative_access(context)
        if fields["initiative_id"] is not None:
            require_initiative_target(repositories, context, fields["initiative_id"])
    chosen = choose_project_status(
        repositories,
        context.workspace_id,
        status_value=fields.pop("status", None),
        status_id=fields.pop("status_id", None),
        team_ids=fields.get("team_ids", existing.team_ids),
        current=existing,
    )
    if chosen is not None:
        fields["status"], fields["status_id"] = chosen
    dates: tuple[tuple[str, DateEdge, Optional[str]], ...] = (
        ("start_date", "start", existing.start_date),
        ("target_date", "end", existing.target_date),
    )
    for date_name, edge, current in dates:
        refusal = settle_date_fields(fields, date_name, f"{date_name}_resolution", edge, current)
        if refusal is not None:
            raise unprocessable(refusal)

    now = utc_now()
    updated = existing.model_copy(update={**fields, "updated_at": now, "updated_by": context.user_id})
    check_project_dates(updated.start_date, updated.target_date)

    closed = normalise_project_status(updated.status) in CLOSED_STATUSES
    updated.completed_at = closed_since(existing, closed, now)
    if choice is not None and not closed:
        raise unprocessable("open_issues applies only to a patch that leaves the project completed or canceled")
    open_issues: list[Issue] = []
    planned: list[tuple[Issue, Issue]] = []
    if closed and ("status" in fields or choice is not None):
        swept = list(dict.fromkeys([*teams, *visible_project_teams(updated, visible)]))
        open_issues = open_project_issues(repositories, context, project_id, swept)
        if choice is not None and choice.action != "keep":
            planned = plan_open_issues(repositories, context, project_id, open_issues, choice)

    try:
        stored = repositories.planning.replace_project(updated)
    except ConditionFailed as exc:
        raise not_found() from exc
    project_activity.record_project_changes(repositories, context, existing, stored)
    if "health" in fields:
        pulse.record_health_change(
            repositories,
            context,
            subject_type="project",
            subject_id=stored.project_id,
            health=stored.health,
            previous_health=existing.health,
        )
    body = ProjectRead.from_row(
        stored,
        visible_project_teams(stored, visible),
        default_interval_days=workspace_interval(repositories.workspaces, context.workspace_id),
    )
    fill_one(repositories, context, body)
    with_links(repositories, body)
    if closed and ("status" in fields or choice is not None):
        body.open_issue_count = len(open_issues) - store_open_issues(repositories, context, planned)
    return body


def delete_project(
    repositories: Repositories, context: AuthzContext, project_id: str, team_id: Optional[str] = None
) -> None:
    """Delete a project with its milestones, links, updates, history, documents and dependencies.

    Every issue that pointed at it stays in place.

    Takes an administrator of every one of the project's teams, because the
    delete detaches issues in each of them.
    """
    project, _ = load_readable_project(repositories, context, project_id, team_id)
    require_project_admin(repositories, context, project)
    repositories.planning.delete_project_milestones(context.workspace_id, project_id)
    repositories.planning.delete_project_links(context.workspace_id, project_id)
    repositories.planning.delete_project_updates(context.workspace_id, project_id)
    repositories.planning.update_threads.delete_project_threads(context.workspace_id, project_id)
    repositories.planning.delete_project_activity(context.workspace_id, project_id)
    repositories.planning.delete_project_history(context.workspace_id, project_id)
    repositories.planning.delete_project_relations_for(context.workspace_id, project_id)
    repositories.documents.delete_for_parent(context.workspace_id, "project", project_id)
    repositories.planning.delete(context.workspace_id, project_key(project_id))


def set_project_archived(
    repositories: Repositories,
    context: AuthzContext,
    project_id: str,
    archived: bool,
    team_id: Optional[str] = None,
) -> ProjectRead:
    """Archive or restore one project, recording an `archived` or `unarchived` activity row.

    Any writer on one of the project's visible teams may, as in Linear. Its
    issues, milestones and updates stay as they are. Idempotent: archiving an
    archived project or restoring a live one answers it unchanged and records
    nothing.
    """
    existing, teams = load_readable_project(repositories, context, project_id, team_id)
    require_project_editor(repositories, context, teams)
    stored = existing
    if (existing.archived_at is not None) != archived:
        now = utc_now()
        updated = existing.model_copy(
            update={"archived_at": now if archived else None, "updated_at": now, "updated_by": context.user_id}
        )
        try:
            stored = repositories.planning.replace_project(updated)
        except ConditionFailed as exc:
            raise not_found() from exc
        project_activity.record_project_archive(
            repositories, context, project_id, "archived" if archived else "unarchived"
        )
    body = ProjectRead.from_row(
        stored, teams, default_interval_days=workspace_interval(repositories.workspaces, context.workspace_id)
    )
    fill_one(repositories, context, body)
    return with_links(repositories, body)
