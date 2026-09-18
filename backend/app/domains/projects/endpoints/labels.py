"""Label routes: the free-form tags a project's issues carry.

Labels have no invariant a status has: nothing depends on one existing, so the
delete route is unconditional.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.project_config import Label, label_key, new_config_id
from app.domains.projects.schemas.project import (
    LabelCreate,
    LabelListRead,
    LabelRead,
    LabelUpdate,
)

router = APIRouter()

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}


@router.get("/{workspace_id}/projects/{project_id}/labels", response_model=LabelListRead)
def list_labels(
    context: Annotated[AuthzContext, Depends(require(Capability.PROJECT_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> LabelListRead:
    """Every label of the project, in name order."""
    rows = repositories.project_config.list_labels(context.workspace_id, str(context.project_id))
    ordered = sorted(rows, key=lambda row: row.name.lower())
    return LabelListRead(labels=[LabelRead.from_row(row) for row in ordered])


@router.post(
    "/{workspace_id}/projects/{project_id}/labels",
    response_model=LabelRead,
    status_code=status.HTTP_201_CREATED,
)
def create_label(
    payload: LabelCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.PROJECT_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> LabelRead:
    """Add a label to the project."""
    project_id = str(context.project_id)
    label_id = new_config_id()
    created = repositories.project_config.create_label(
        Label(
            workspace_id=context.workspace_id,
            config_key=label_key(project_id, label_id),
            project_id=project_id,
            label_id=label_id,
            name=payload.name,
            color=payload.color,
        )
    )
    return LabelRead.from_row(created)


@router.patch("/{workspace_id}/projects/{project_id}/labels/{label_id}", response_model=LabelRead)
def update_label(
    payload: LabelUpdate,
    label_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.PROJECT_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> LabelRead:
    """Rename or recolour a label."""
    project_id = str(context.project_id)
    attributes = payload.model_dump(exclude_unset=True, exclude_none=True)
    if not attributes:
        existing = repositories.project_config.get_label(context.workspace_id, project_id, label_id)
        if existing is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
        return LabelRead.from_row(existing)

    updated = repositories.project_config.update_label(context.workspace_id, project_id, label_id, **attributes)
    if updated is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return LabelRead.from_row(updated)


@router.delete(
    "/{workspace_id}/projects/{project_id}/labels/{label_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_label(
    label_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.PROJECT_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Delete a label."""
    repositories.project_config.delete_label(context.workspace_id, str(context.project_id), label_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
