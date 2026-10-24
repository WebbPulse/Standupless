"""Workspace status, label and display default routes: what every team of the workspace inherits.

Reads are open to any member, because every team's pickers draw on the set.
Writes are workspace admin, because one change reaches every team at once. A
team adjusts an inherited record for itself through the team override routes,
and sets a projects display default of its own through the team display
defaults route.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Response, status

from app.common import label_merge, team_workflow, team_writes
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.teams import (
    LabelCreate,
    LabelListRead,
    LabelMerge,
    LabelMergeRead,
    LabelRead,
    LabelUpdate,
    StatusCreate,
    StatusListRead,
    StatusRead,
    StatusUpdate,
    WorkspaceDisplayDefaultsRead,
    WorkspaceDisplayDefaultsUpdate,
)

router = APIRouter()


@router.get("/{workspace_id}/statuses", response_model=StatusListRead)
def list_workspace_statuses(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> StatusListRead:
    """Every workspace status, ordered by position."""
    ordered = team_workflow.ordered_workspace_statuses(repositories, context.workspace_id)
    return StatusListRead(statuses=[StatusRead.from_row(row) for row in ordered])


@router.post("/{workspace_id}/statuses", response_model=StatusRead, status_code=status.HTTP_201_CREATED)
def create_workspace_status(
    payload: StatusCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> StatusRead:
    """Add a status every team inherits, defaulting its position to the end."""
    return StatusRead.from_row(team_workflow.create_workspace_status(repositories, context.workspace_id, payload))


@router.patch("/{workspace_id}/statuses/{status_id}", response_model=StatusRead)
def update_workspace_status(
    payload: StatusUpdate,
    status_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> StatusRead:
    """Rename, recategorise, recolor or move a workspace status for every team."""
    updated = team_workflow.update_workspace_status(repositories, context.workspace_id, status_id, payload)
    return StatusRead.from_row(updated)


@router.delete("/{workspace_id}/statuses/{status_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workspace_status(
    status_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    replacement_status_id: Annotated[str | None, Query(min_length=1)] = None,
) -> Response:
    """Delete a workspace status, moving every team's issues in it to `replacement_status_id`.

    A 409 when a team would lose its last visible status of the category, when
    issues are in it and no replacement is named, or when a team with issues here
    hides the replacement.
    """
    team_workflow.delete_workspace_status(
        repositories,
        context.workspace_id,
        status_id,
        actor_id=context.user_id,
        source=context.source,
        replacement_status_id=replacement_status_id,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{workspace_id}/labels", response_model=LabelListRead)
def list_workspace_labels(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> LabelListRead:
    """Every workspace label, in name order."""
    ordered = team_workflow.ordered_workspace_labels(repositories, context.workspace_id)
    return LabelListRead(labels=[LabelRead.from_row(row) for row in ordered])


@router.post("/{workspace_id}/labels", response_model=LabelRead, status_code=status.HTTP_201_CREATED)
def create_workspace_label(
    payload: LabelCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> LabelRead:
    """Add a label every team inherits."""
    return LabelRead.from_row(team_workflow.create_workspace_label(repositories, context.workspace_id, payload))


@router.patch("/{workspace_id}/labels/{label_id}", response_model=LabelRead)
def update_workspace_label(
    payload: LabelUpdate,
    label_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> LabelRead:
    """Rename or recolour a workspace label for every team."""
    return LabelRead.from_row(
        team_workflow.update_workspace_label(repositories, context.workspace_id, label_id, payload)
    )


@router.post("/{workspace_id}/labels/{label_id}/merge", response_model=LabelMergeRead)
def merge_workspace_label(
    payload: LabelMerge,
    label_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> LabelMergeRead:
    """Fold a workspace label into another on every team: issues, saved views and templates take the other.

    A large merge answers `complete: false` once it runs out of time, and calling
    again with the same target resumes it. A merge already finished answers its
    result again.
    """
    outcome = label_merge.merge_workspace_label(repositories, context, label_id, payload.target_label_id)
    return label_merge.merge_read(outcome)


@router.delete("/{workspace_id}/labels/{label_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workspace_label(
    label_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Delete a workspace label, every team's override of it, and the label on every issue carrying it."""
    team_workflow.delete_workspace_label(repositories, context.workspace_id, label_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{workspace_id}/display-defaults", response_model=WorkspaceDisplayDefaultsRead)
def read_workspace_display_defaults(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> WorkspaceDisplayDefaultsRead:
    """What the projects page opens with for a member who never arranged it and whose team set no default."""
    return WorkspaceDisplayDefaultsRead.from_row(
        team_writes.workspace_display_defaults(repositories, context.workspace_id)
    )


@router.patch("/{workspace_id}/display-defaults", response_model=WorkspaceDisplayDefaultsRead)
def update_workspace_display_defaults(
    payload: WorkspaceDisplayDefaultsUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> WorkspaceDisplayDefaultsRead:
    """Set or clear the projects arrangement every member opens with until they arrange it themselves.

    A workspace admin's call. A team default, where one is set, wins on that
    team's projects page, and a member's own arrangement wins over both.
    """
    saved = team_writes.update_workspace_display_defaults(repositories, context.workspace_id, context.user_id, payload)
    return WorkspaceDisplayDefaultsRead.from_row(saved)
