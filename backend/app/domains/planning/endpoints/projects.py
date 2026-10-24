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
    ProjectRelationCreate,
    ProjectRelationListRead,
    ProjectRelationRead,
    ProjectSortField,
    ProjectUpdate,
)
from app.common.planning_rules import load_readable_project
from app.common.project_cadence import workspace_interval
from app.common.project_relations import create_relation, delete_relation, fill_one, list_relations
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
    is_blocked: Annotated[Optional[bool], Query()] = None,
    is_blocking: Annotated[Optional[bool], Query()] = None,
    customer_id: Annotated[Optional[list[str]], Query()] = None,
    customer_id_not: Annotated[Optional[list[str]], Query()] = None,
    sort: Annotated[Optional[ProjectSortField], Query()] = None,
    label_id: Annotated[Optional[list[str]], Query()] = None,
) -> CursorPage[ProjectRead]:
    """One page of the workspace's projects the caller can see, by target date, undated last.

    A project is listed when the caller can see at least one of its teams, and
    `team_id` narrows to the projects that team is on and `initiative_id` to the
    ones in that initiative. The rows are read whole and paged over the filtered
    order, so a page is never left short by projects the caller cannot see.
    Undated projects sort last, because an absent target is a project nobody has
    committed to yet. `include_sub_teams` with `team_id` also lists the projects
    of the team's sub-teams the caller may read, so a private sub-team stays out
    for outsiders. `is_blocked` keeps the projects an open blocker holds up and
    `is_blocking` the open projects holding another up, each false for the rest.

    `customer_id` keeps the projects any named customer asked for and
    `customer_id_not` drops them, `none` standing for no customer request.
    `sort=customer_requests_desc` puts the most requested projects first and
    `customer_revenue_desc` the highest summed customer revenue, target date
    breaking ties; both fill `customer_request_count`. Guests may use neither.
    `label_id` keeps the projects carrying any named project label, `none`
    standing for a project with none.
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
        is_blocked=is_blocked,
        is_blocking=is_blocking,
        customer_id=customer_id,
        customer_id_not=customer_id_not,
        sort=sort,
        label_id=label_id,
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
    return fill_one(repositories, context, ProjectRead.from_row(project, teams, default_interval_days=default_days))


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


@router.get("/{workspace_id}/projects/{project_id}/relations", response_model=ProjectRelationListRead)
def list_project_relations(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
) -> CursorPage[ProjectRelationRead]:
    """Every dependency of one project, read from its side, whose other end the caller may see.

    A project holds few dependencies, so the list is answered whole and never pages.
    """
    return ProjectRelationListRead(items=list_relations(repositories, context, project_id), next_cursor=None)


@router.post(
    "/{workspace_id}/projects/{project_id}/relations",
    response_model=ProjectRelationRead,
    status_code=status.HTTP_201_CREATED,
)
def create_project_relation(
    payload: ProjectRelationCreate,
    response: Response,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
) -> ProjectRelationRead:
    """Make the project block, or be blocked by, another project.

    A pair already linked the same way answers the stored link with a 200, and a
    link back to the project itself or one that closes a loop is a 422.
    """
    relation, created = create_relation(repositories, context, project_id, payload)
    if not created:
        response.status_code = status.HTTP_200_OK
    return relation


@router.delete("/{workspace_id}/projects/{project_id}/relations/{relation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project_relation(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
    relation_id: Annotated[str, Path()],
) -> Response:
    """Remove one dependency of the project, from either side."""
    delete_relation(repositories, context, project_id, relation_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
