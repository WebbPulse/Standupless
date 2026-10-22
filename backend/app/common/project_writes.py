"""Project list, create, patch and delete, shared by the project routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and a project an agent creates or edits must pass the same team, lead and
date rules a person's does.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common import pulse
from app.common.api.dependencies.authz import AuthzContext, require_scopes_present
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import decode_offset_cursor, encode_offset_cursor
from app.common.api.schemas.planning import ProjectCreate, ProjectOpenIssues, ProjectRead, ProjectUpdate
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.planning import Project, new_planning_id, normalise_project_status, project_key
from app.common.initiative_writes import require_initiative_access, require_initiative_target
from app.common.issue_rules import COMPLETED_CATEGORIES, require_team_member
from app.common.issue_writes import apply_patch, store_patch
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
from app.common.relation_effects import cancelled_status, categories_for
from app.common.sub_teams import listed_teams

NOT_NULLABLE = ("name", "status", "team_ids", "priority", "member_ids")
"""Patch fields that may be omitted but never cleared, because every project has one."""

STATUS_VALUES = ("backlog", "planned", "in_progress", "paused", "completed", "canceled", "done")
"""What the list's status filter accepts, including the legacy `done`."""

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
) -> tuple[list[ProjectRead], Optional[str]]:
    """One page of the workspace's projects the caller can see, and the next cursor.

    A project is listed when the caller can see at least one of its teams, and
    `team_id` narrows to the projects that team is on and `initiative_id` to the
    ones in that initiative, which a guest may not filter by. The rows are read whole
    and paged over the filtered order, so a page is never left short by projects
    the caller cannot see. `include_sub_teams` widens `team_id` to the team and
    its sub-teams the caller may read, as the issue list does.
    """
    wanted_status = None if status_filter is None else normalise_project_status(status_filter)
    if status_filter is not None and status_filter not in STATUS_VALUES:
        raise unprocessable(f"Unknown project status: {status_filter}")
    wanted_teams: set[str] | None = None
    if team_id is not None:
        require_team_reader(repositories, context, team_id)
        wanted_teams = set(listed_teams(repositories, context, team_id, include_sub_teams=include_sub_teams))
    if initiative_id is not None:
        require_initiative_access(context)

    visible = set(visible_team_ids(repositories, context))
    default_days = workspace_interval(repositories.workspaces, context.workspace_id)
    bodies: list[ProjectRead] = []
    for row in repositories.planning.list_projects(context.workspace_id):
        teams = visible_project_teams(row, visible)
        if not teams:
            continue
        if wanted_teams is not None and wanted_teams.isdisjoint(teams):
            continue
        if wanted_status is not None and row.status != wanted_status:
            continue
        if initiative_id is not None and row.initiative_id != initiative_id:
            continue
        bodies.append(ProjectRead.from_row(row, teams, default_interval_days=default_days))

    narrowed = f"{team_id}:subs" if include_sub_teams and team_id is not None else team_id or "all"
    scope = f"projects:{context.workspace_id}:{narrowed}:{wanted_status or 'all'}:{initiative_id or 'all'}"
    offset = decode_offset_cursor(cursor, scope)
    window = bodies[offset : offset + limit]
    next_offset = offset + len(window)
    next_cursor = encode_offset_cursor(next_offset, scope) if next_offset < len(bodies) else None
    return window, next_cursor


def create_project(repositories: Repositories, context: AuthzContext, payload: ProjectCreate) -> ProjectRead:
    """Create a project on one or more teams.

    The caller must be able to write in every team named, since a project put on a
    team appears in that team's planning.
    """
    teams = payload.teams
    require_team_changes(repositories, context, teams)
    if payload.lead_id is not None:
        require_workspace_member(repositories, context, payload.lead_id)
    for member_id in payload.member_ids:
        require_workspace_member(repositories, context, member_id)
    if payload.initiative_id is not None:
        require_initiative_target(repositories, context, payload.initiative_id)

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
        status=payload.status,
        icon=payload.icon,
        color=payload.color,
        health=payload.health,
        priority=payload.priority,
        member_ids=list(payload.member_ids),
        update_interval_days=payload.update_interval_days,
        initiative_id=payload.initiative_id,
        completed_at=utc_now() if payload.status in CLOSED_STATUSES else None,
        created_by=context.user_id,
    )
    try:
        created = repositories.planning.create_project(project)
    except ConditionFailed as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error_code": "CONFLICT", "message": "That project already exists"},
        ) from exc
    return ProjectRead.from_row(
        created, teams, default_interval_days=workspace_interval(repositories.workspaces, context.workspace_id)
    )


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
    if "initiative_id" in fields and fields["initiative_id"] != existing.initiative_id:
        require_initiative_access(context)
        if fields["initiative_id"] is not None:
            require_initiative_target(repositories, context, fields["initiative_id"])

    now = utc_now()
    updated = existing.model_copy(update={**fields, "updated_at": now})
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
    if closed and ("status" in fields or choice is not None):
        body.open_issue_count = len(open_issues) - store_open_issues(repositories, context, planned)
    return body


def delete_project(
    repositories: Repositories, context: AuthzContext, project_id: str, team_id: Optional[str] = None
) -> None:
    """Delete a project with its milestones, updates and documents, leaving every issue that pointed at it in place.

    Takes an administrator of every one of the project's teams, because the
    delete detaches issues in each of them.
    """
    project, _ = load_readable_project(repositories, context, project_id, team_id)
    require_project_admin(repositories, context, project)
    repositories.planning.delete_project_milestones(context.workspace_id, project_id)
    repositories.planning.delete_project_updates(context.workspace_id, project_id)
    repositories.documents.delete_for_parent(context.workspace_id, "project", project_id)
    repositories.planning.delete(context.workspace_id, project_key(project_id))
