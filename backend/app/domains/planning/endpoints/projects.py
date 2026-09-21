"""Project routes: list, create, read, patch and delete.

A project's status is stored rather than derived, because its one date is a
target and a target says nothing about whether the work has started. Everything
else mirrors the cycle routes, including that the team travels in the query or
the body rather than the path.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from webbpulse.dynamodb import ConditionFailed
from webbpulse.http import CursorPage

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.pagination import decode_cursor, encode_cursor
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import Project, new_planning_id, project_key
from app.domains.planning.schemas.planning import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    ProjectCreate,
    ProjectListRead,
    ProjectRead,
    ProjectStatusField,
    ProjectUpdate,
)
from app.domains.planning.service import (
    load_readable_project,
    not_found,
    require_team_admin,
    require_team_member,
    require_team_reader,
)

router = APIRouter()


@router.get("/{workspace_id}/projects", response_model=ProjectListRead)
def list_projects(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    team_id: Annotated[str, Query()],
    status_filter: Annotated[Optional[ProjectStatusField], Query(alias="status")] = None,
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> CursorPage[ProjectRead]:
    """One page of a team's projects, by target date ascending, undated last.

    Undated projects sort last rather than first, because an absent target is a
    project nobody has committed to yet and putting it ahead of dated work would
    read as the most urgent thing on the list.
    """
    require_team_reader(repositories, context, team_id)
    scope = f"projects:{context.workspace_id}:{team_id}"
    start_key = decode_cursor(cursor, scope)
    rows, last_key = repositories.planning.list_projects(
        context.workspace_id,
        team_id,
        limit=limit,
        start_key=start_key,
    )
    if status_filter is not None:
        rows = [row for row in rows if row.status == status_filter]
    bodies = [ProjectRead.from_row(row) for row in rows]
    return ProjectListRead(items=bodies, next_cursor=encode_cursor(last_key, scope))


@router.post("/{workspace_id}/projects", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
def create_project(
    payload: ProjectCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
) -> ProjectRead:
    """Create a project in one team."""
    require_team_member(repositories, context, payload.team_id)
    if repositories.teams.get(context.workspace_id, payload.team_id) is None:
        raise not_found()

    project_id = new_planning_id()
    project = Project(
        workspace_id=context.workspace_id,
        planning_key=project_key(payload.team_id, project_id),
        project_id=project_id,
        team_id=payload.team_id,
        name=payload.name,
        description=payload.description,
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
    return ProjectRead.from_row(created)


@router.get("/{workspace_id}/projects/{project_id}", response_model=ProjectRead)
def read_project(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
    team_id: Annotated[str, Query()],
) -> ProjectRead:
    """One project, or a 404 when the caller cannot see its team."""
    return ProjectRead.from_row(load_readable_project(repositories, context, team_id, project_id))


@router.patch("/{workspace_id}/projects/{project_id}", response_model=ProjectRead)
def update_project(
    payload: ProjectUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
) -> ProjectRead:
    """Patch a project's name, description, target date or status.

    Setting `target_date` to null clears it, which takes the row out of the roadmap
    index rather than leaving it indexed under an empty date.
    """
    existing = load_readable_project(repositories, context, payload.team_id, project_id)
    require_team_member(repositories, context, payload.team_id)

    fields = payload.model_dump(exclude_unset=True, exclude={"team_id"})
    updated = existing.model_copy(update={**fields, "updated_at": utc_now()})

    try:
        stored = repositories.planning.replace_project(updated)
    except ConditionFailed as exc:
        raise not_found() from exc
    return ProjectRead.from_row(stored)


@router.delete("/{workspace_id}/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
    team_id: Annotated[str, Query()],
) -> Response:
    """Delete a project, leaving every issue that pointed at it in place."""
    load_readable_project(repositories, context, team_id, project_id)
    require_team_admin(repositories, context, team_id)
    repositories.planning.delete(context.workspace_id, project_key(team_id, project_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
