"""Project label routes: the workspace's labels for projects and each team's own, as Linear's project labels.

Any reader of the workspace lists them. A workspace admin adds, edits or deletes
a workspace label, and a team admin those of their team, decided in the shared
rules against the label's own scope. The rules live in `app.common.project_labels`, which the MCP tools
share.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Path, Query, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.project_labels import (
    ProjectLabelCreate,
    ProjectLabelListRead,
    ProjectLabelRead,
    ProjectLabelUpdate,
)
from app.common.project_labels import (
    create_project_label,
    delete_project_label,
    list_project_labels,
    update_project_label,
)

router = APIRouter()


@router.get("/{workspace_id}/project-labels", response_model=ProjectLabelListRead)
def list_labels(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    team_id: Annotated[Optional[str], Query(min_length=1)] = None,
) -> ProjectLabelListRead:
    """The workspace's project labels with one team's, or every team's the caller finds, by name.

    Each carries how many projects the caller can see carry it.
    """
    return list_project_labels(repositories, context, team_id)


@router.post("/{workspace_id}/project-labels", response_model=ProjectLabelRead, status_code=status.HTTP_201_CREATED)
def add_label(
    payload: ProjectLabelCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
) -> ProjectLabelRead:
    """Add a workspace project label, or one of `team_id`'s; a taken name answers 409."""
    return create_project_label(repositories, context, payload)


@router.patch("/{workspace_id}/project-labels/{label_id}", response_model=ProjectLabelRead)
def edit_label(
    payload: ProjectLabelUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    label_id: Annotated[str, Path()],
) -> ProjectLabelRead:
    """Rename, recolour or redescribe a project label."""
    return update_project_label(repositories, context, label_id, payload)


@router.delete("/{workspace_id}/project-labels/{label_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_label(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    label_id: Annotated[str, Path()],
) -> Response:
    """Delete a project label and take it off every project."""
    delete_project_label(repositories, context, label_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
