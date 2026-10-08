"""Initiative routes: list, create, read, patch, delete, project membership and the update feed.

An initiative is workspace level and groups projects across teams, as in Linear.
Every rule lives in `app.common.initiative_writes`, which the MCP tools share: a
guest is refused, any other member reads and edits, and the rollup counts only
the projects the caller can see.
"""

from __future__ import annotations

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, Path, Query, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.planning import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    UPDATES_DEFAULT_LIMIT,
    InitiativeCreate,
    InitiativeListRead,
    InitiativeRead,
    InitiativeUpdate,
    InitiativeUpdateCreate,
    InitiativeUpdateListRead,
    InitiativeUpdatePatch,
    InitiativeUpdateRead,
    ProjectRead,
)
from app.common.initiative_writes import (
    add_project_to_initiative,
    create_initiative,
    create_initiative_update,
    delete_initiative,
    delete_initiative_update,
    get_initiative,
    list_initiative_updates,
    list_initiatives,
    remove_project_from_initiative,
    update_initiative,
    update_initiative_update,
)

router = APIRouter()


@router.get("/{workspace_id}/initiatives", response_model=InitiativeListRead)
def list_initiative_page(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    status_filter: Annotated[Optional[str], Query(alias="status")] = None,
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> Any:
    """One page of the workspace's initiatives by target date, undated last, each rolled up."""
    rows, next_cursor = list_initiatives(
        repositories, context, status_filter=status_filter, cursor=cursor, limit=limit
    )
    return InitiativeListRead(items=rows, next_cursor=next_cursor)


@router.post("/{workspace_id}/initiatives", response_model=InitiativeRead, status_code=status.HTTP_201_CREATED)
def create_initiative_row(
    payload: InitiativeCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
) -> InitiativeRead:
    """Create an initiative with no projects yet."""
    return create_initiative(repositories, context, payload)


@router.get("/{workspace_id}/initiatives/{initiative_id}", response_model=InitiativeRead)
def read_initiative_row(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
) -> InitiativeRead:
    """One initiative, rolled up from the projects the caller can see."""
    return get_initiative(repositories, context, initiative_id)


@router.patch("/{workspace_id}/initiatives/{initiative_id}", response_model=InitiativeRead)
def update_initiative_row(
    payload: InitiativeUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
) -> InitiativeRead:
    """Patch an initiative's fields; null clears the description, owner, health, date or cadence."""
    return update_initiative(repositories, context, initiative_id, payload)


@router.delete("/{workspace_id}/initiatives/{initiative_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_initiative_row(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
) -> Response:
    """Delete an initiative and its updates; its projects stay, outside any initiative."""
    delete_initiative(repositories, context, initiative_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/{workspace_id}/initiatives/{initiative_id}/projects/{project_id}", response_model=ProjectRead)
def add_project(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
) -> ProjectRead:
    """Put a project in an initiative, moving it out of any other; needs editor rights on the project."""
    return add_project_to_initiative(repositories, context, initiative_id, project_id)


@router.delete("/{workspace_id}/initiatives/{initiative_id}/projects/{project_id}", response_model=ProjectRead)
def remove_project(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
) -> ProjectRead:
    """Take a project out of an initiative; needs editor rights on the project."""
    return remove_project_from_initiative(repositories, context, initiative_id, project_id)


@router.get("/{workspace_id}/initiatives/{initiative_id}/updates", response_model=InitiativeUpdateListRead)
def list_updates(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = UPDATES_DEFAULT_LIMIT,
) -> Any:
    """One page of an initiative's updates, newest first."""
    rows, next_cursor = list_initiative_updates(repositories, context, initiative_id, cursor=cursor, limit=limit)
    return InitiativeUpdateListRead(items=rows, next_cursor=next_cursor)


@router.post(
    "/{workspace_id}/initiatives/{initiative_id}/updates",
    response_model=InitiativeUpdateRead,
    status_code=status.HTTP_201_CREATED,
)
def create_update(
    payload: InitiativeUpdateCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
) -> InitiativeUpdateRead:
    """Post an update, which sets the initiative's health to the one it reports."""
    return create_initiative_update(repositories, context, initiative_id, payload)


@router.patch(
    "/{workspace_id}/initiatives/{initiative_id}/updates/{update_id}", response_model=InitiativeUpdateRead
)
def update_update(
    payload: InitiativeUpdatePatch,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
    update_id: Annotated[str, Path()],
) -> InitiativeUpdateRead:
    """Edit an update's body or health, as its author, the initiative's owner or a workspace admin."""
    return update_initiative_update(repositories, context, initiative_id, update_id, payload)


@router.delete(
    "/{workspace_id}/initiatives/{initiative_id}/updates/{update_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_update(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    initiative_id: Annotated[str, Path()],
    update_id: Annotated[str, Path()],
) -> Response:
    """Delete an update, as its author, the initiative's owner or a workspace admin."""
    delete_initiative_update(repositories, context, initiative_id, update_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
