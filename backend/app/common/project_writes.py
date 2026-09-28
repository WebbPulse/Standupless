"""Project list, create, patch and delete, shared by the project routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and a project an agent creates or edits must pass the same team, lead and
date rules a person's does.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import decode_offset_cursor, encode_offset_cursor
from app.common.api.schemas.planning import ProjectCreate, ProjectRead, ProjectUpdate
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import Project, new_planning_id, normalise_project_status, project_key
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

NOT_NULLABLE = ("name", "status", "team_ids", "priority", "member_ids")
"""Patch fields that may be omitted but never cleared, because every project has one."""

STATUS_VALUES = ("backlog", "planned", "in_progress", "paused", "completed", "canceled", "done")
"""What the list's status filter accepts, including the legacy `done`."""


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
) -> tuple[list[ProjectRead], Optional[str]]:
    """One page of the workspace's projects the caller can see, and the next cursor.

    A project is listed when the caller can see at least one of its teams, and
    `team_id` narrows to the projects that team is on. The rows are read whole
    and paged over the filtered order, so a page is never left short by projects
    the caller cannot see.
    """
    wanted_status = None if status_filter is None else normalise_project_status(status_filter)
    if status_filter is not None and status_filter not in STATUS_VALUES:
        raise unprocessable(f"Unknown project status: {status_filter}")
    if team_id is not None:
        require_team_reader(repositories, context, team_id)

    visible = set(visible_team_ids(repositories, context))
    bodies: list[ProjectRead] = []
    for row in repositories.planning.list_projects(context.workspace_id):
        teams = visible_project_teams(row, visible)
        if not teams:
            continue
        if team_id is not None and team_id not in teams:
            continue
        if wanted_status is not None and row.status != wanted_status:
            continue
        bodies.append(ProjectRead.from_row(row, teams))

    scope = f"projects:{context.workspace_id}:{team_id or 'all'}:{wanted_status or 'all'}"
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
        created_by=context.user_id,
    )
    try:
        created = repositories.planning.create_project(project)
    except ConditionFailed as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error_code": "CONFLICT", "message": "That project already exists"},
        ) from exc
    return ProjectRead.from_row(created, teams)


def update_project(
    repositories: Repositories, context: AuthzContext, project_id: str, payload: ProjectUpdate
) -> ProjectRead:
    """Patch a project's fields or its teams.

    Any writer on one of the project's visible teams may edit its fields. Changing
    `team_ids` also needs write access to every team added or removed. Setting a
    date, the lead or the description to null clears it. The row is read first and
    written whole, so the counters the consumer maintains ride along untouched.
    Only members newly added are checked against the workspace, so a patch that
    keeps someone who has since left does not fail on them.
    """
    existing, teams = load_readable_project(repositories, context, project_id, payload.team_id)
    require_project_editor(repositories, context, teams)

    fields: dict[str, Any] = payload.model_dump(exclude_unset=True, exclude={"team_id"})
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

    updated = existing.model_copy(update={**fields, "updated_at": utc_now()})
    check_project_dates(updated.start_date, updated.target_date)

    try:
        stored = repositories.planning.replace_project(updated)
    except ConditionFailed as exc:
        raise not_found() from exc
    return ProjectRead.from_row(stored, visible_project_teams(stored, visible))


def delete_project(
    repositories: Repositories, context: AuthzContext, project_id: str, team_id: Optional[str] = None
) -> None:
    """Delete a project with its milestones and updates, leaving every issue that pointed at it in place.

    Takes an administrator of every one of the project's teams, because the
    delete detaches issues in each of them.
    """
    project, _ = load_readable_project(repositories, context, project_id, team_id)
    require_project_admin(repositories, context, project)
    repositories.planning.delete_project_milestones(context.workspace_id, project_id)
    repositories.planning.delete_project_updates(context.workspace_id, project_id)
    repositories.planning.delete(context.workspace_id, project_key(project_id))
