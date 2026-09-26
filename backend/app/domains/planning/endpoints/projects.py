"""Project routes: list, create, read, patch and delete.

A project is workspace level and belongs to one or more teams, as in Linear, so
every route reaches it by its own id and decides visibility against its whole team
list through the service helpers. Its status is stored rather than derived, because
its dates are a plan and a plan says nothing about whether the work has started.

The single-team parameters an older client sends, `team_id` in the query or the
body, are still accepted: they must name one of the project's visible teams and
narrow nothing else.
"""

from __future__ import annotations

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from webbpulse.dynamodb import ConditionFailed
from webbpulse.http import CursorPage

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.pagination import decode_offset_cursor, encode_offset_cursor
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import Project, new_planning_id, normalise_project_status, project_key
from app.domains.planning.schemas.planning import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    ProjectCreate,
    ProjectListRead,
    ProjectRead,
    ProjectUpdate,
)
from app.domains.planning.service import (
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

router = APIRouter()

NOT_NULLABLE = ("name", "status", "team_ids")
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


@router.get("/{workspace_id}/projects", response_model=ProjectListRead)
def list_projects(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    team_id: Annotated[Optional[str], Query()] = None,
    status_filter: Annotated[Optional[str], Query(alias="status")] = None,
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> CursorPage[ProjectRead]:
    """One page of the workspace's projects the caller can see, by target date, undated last.

    A project is listed when the caller can see at least one of its teams, and
    `team_id` narrows to the projects that team is on. The rows are read whole
    and paged over the filtered order, so a page is never left short by projects
    the caller cannot see. Undated projects sort last, because an absent target is
    a project nobody has committed to yet.
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
    return ProjectListRead(items=window, next_cursor=next_cursor)


@router.post("/{workspace_id}/projects", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
def create_project(
    payload: ProjectCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
) -> ProjectRead:
    """Create a project on one or more teams.

    The caller must be able to write in every team named, since a project put on a
    team appears in that team's planning.
    """
    teams = payload.teams
    require_team_changes(repositories, context, teams)
    if payload.lead_id is not None:
        require_workspace_member(repositories, context, payload.lead_id)

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


@router.get("/{workspace_id}/projects/{project_id}", response_model=ProjectRead)
def read_project(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
    team_id: Annotated[Optional[str], Query()] = None,
) -> ProjectRead:
    """One project, or a 404 when the caller can see none of its teams."""
    project, teams = load_readable_project(repositories, context, project_id, team_id)
    return ProjectRead.from_row(project, teams)


@router.patch("/{workspace_id}/projects/{project_id}", response_model=ProjectRead)
def update_project(
    payload: ProjectUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
) -> ProjectRead:
    """Patch a project's fields or its teams.

    Any writer on one of the project's visible teams may edit its fields. Changing
    `team_ids` also needs write access to every team added or removed. Setting a
    date, the lead or the description to null clears it. The row is read first and
    written whole, so the counters the consumer maintains ride along untouched.
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

    updated = existing.model_copy(update={**fields, "updated_at": utc_now()})
    check_project_dates(updated.start_date, updated.target_date)

    try:
        stored = repositories.planning.replace_project(updated)
    except ConditionFailed as exc:
        raise not_found() from exc
    return ProjectRead.from_row(stored, visible_project_teams(stored, visible))


@router.delete("/{workspace_id}/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
    team_id: Annotated[Optional[str], Query()] = None,
) -> Response:
    """Delete a project, leaving every issue that pointed at it in place.

    Takes an administrator of every one of the project's teams, because the
    delete detaches issues in each of them.
    """
    project, _ = load_readable_project(repositories, context, project_id, team_id)
    require_project_admin(repositories, context, project)
    repositories.planning.delete(context.workspace_id, project_key(project_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
