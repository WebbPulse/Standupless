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

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Path, Query, Response, status
from webbpulse.http import CursorPage

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.planning import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    ProjectCreate,
    ProjectListRead,
    ProjectRead,
    ProjectUpdate,
)
from app.common.planning_rules import load_readable_project
from app.common.project_cadence import workspace_interval
from app.common.project_writes import create_project as create_project_row
from app.common.project_writes import delete_project as delete_project_row
from app.common.project_writes import list_projects as list_project_page
from app.common.project_writes import update_project as update_project_row

router = APIRouter()


@router.get("/{workspace_id}/projects", response_model=ProjectListRead)
def list_projects(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    team_id: Annotated[Optional[str], Query()] = None,
    status_filter: Annotated[Optional[str], Query(alias="status")] = None,
    initiative_id: Annotated[Optional[str], Query()] = None,
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    include_sub_teams: Annotated[bool, Query()] = False,
) -> CursorPage[ProjectRead]:
    """One page of the workspace's projects the caller can see, by target date, undated last.

    A project is listed when the caller can see at least one of its teams, and
    `team_id` narrows to the projects that team is on and `initiative_id` to the
    ones in that initiative. The rows are read whole and paged over the filtered
    order, so a page is never left short by projects the caller cannot see.
    Undated projects sort last, because an absent target is a project nobody has
    committed to yet. `include_sub_teams` with `team_id` also lists the projects
    of the team's sub-teams the caller may read, so a private sub-team stays out
    for outsiders.
    """
    window, next_cursor = list_project_page(
        repositories,
        context,
        team_id=team_id,
        status_filter=status_filter,
        cursor=cursor,
        limit=limit,
        initiative_id=initiative_id,
        include_sub_teams=include_sub_teams,
    )
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
    return create_project_row(repositories, context, payload)


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
    default_days = workspace_interval(repositories.workspaces, context.workspace_id)
    return ProjectRead.from_row(project, teams, default_interval_days=default_days)


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
    return update_project_row(repositories, context, project_id, payload)


@router.delete("/{workspace_id}/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
    team_id: Annotated[Optional[str], Query()] = None,
) -> Response:
    """Delete a project and its milestones, leaving every issue that pointed at it in place.

    Takes an administrator of every one of the project's teams, because the
    delete detaches issues in each of them.
    """
    delete_project_row(repositories, context, project_id, team_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
