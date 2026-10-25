"""Project Resources link routes: list, create, patch and delete, under one project.

A link is reached through its project, so visibility and edit rights are the
project's own: a caller who can read the project reads its links, and a writer on
one of its visible teams edits them. The write rules live in
`app.common.project_link_writes`, which the MCP tools share.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.planning import (
    ProjectLinkCreate,
    ProjectLinkListRead,
    ProjectLinkRead,
    ProjectLinkUpdate,
)
from app.common.project_link_writes import create_link, delete_link, list_links, update_link

router = APIRouter()


@router.get("/{workspace_id}/projects/{project_id}/links", response_model=ProjectLinkListRead)
def list_project_links(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
) -> Any:
    """Every Resources link of one project, in its manual order.

    A project holds a bounded set, so the list is answered whole and never pages.
    """
    return ProjectLinkListRead(items=list_links(repositories, context, project_id), next_cursor=None)


@router.post(
    "/{workspace_id}/projects/{project_id}/links",
    response_model=ProjectLinkRead,
    status_code=status.HTTP_201_CREATED,
)
def create_project_link(
    payload: ProjectLinkCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
) -> ProjectLinkRead:
    """Add a Resources link to a project, after the last one unless a position is given."""
    return create_link(repositories, context, project_id, payload)


@router.patch("/{workspace_id}/projects/{project_id}/links/{link_id}", response_model=ProjectLinkRead)
def update_project_link(
    payload: ProjectLinkUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
    link_id: Annotated[str, Path()],
) -> ProjectLinkRead:
    """Retitle, repoint or reorder one Resources link."""
    return update_link(repositories, context, project_id, link_id, payload)


@router.delete(
    "/{workspace_id}/projects/{project_id}/links/{link_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_project_link(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[str, Path()],
    link_id: Annotated[str, Path()],
) -> Response:
    """Remove one Resources link; takes the same right as editing the project."""
    delete_link(repositories, context, project_id, link_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
