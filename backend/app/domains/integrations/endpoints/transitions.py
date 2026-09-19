"""Per-project rules for what a pull request event does to an issue's status.

A project with no stored rules behaves as design section 4 says, and the read
returns those defaults marked `is_default` rather than an empty list, so the
frontend can show what will actually happen without restating the defaults itself.
Writing any rule replaces the defaults entirely, which is what makes "disable the
merge transition" expressible.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.project_config import Transition, new_config_id, transition_key
from app.domains.integrations.schemas.integrations import (
    TransitionCreate,
    TransitionRead,
    TransitionUpdate,
)
from app.domains.integrations.service import (
    conflict,
    effective_transitions,
    not_found,
    transition_read,
    unprocessable,
)

router = APIRouter()


def _require_project(repositories: Repositories, context: AuthzContext, project_id: str) -> None:
    """Hold that the project exists in this workspace, or 404."""
    if repositories.projects.get(context.workspace_id, project_id) is None:
        raise not_found()


def _check_status(repositories: Repositories, context: AuthzContext, project_id: str, status_id: str | None) -> None:
    """Hold that a named status belongs to this project.

    A rule pointing at a status of another project would move an issue into a
    status its board cannot render, so it is refused on write rather than skipped
    at transition time where nobody would see the mistake.
    """
    if status_id is None:
        return
    if repositories.project_config.get_status(context.workspace_id, project_id, status_id) is None:
        raise unprocessable("The status does not belong to this project.")


@router.get("/{workspace_id}/projects/{project_id}/github-transitions", response_model=list[TransitionRead])
def list_transitions(
    project_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.PROJECT_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> list[TransitionRead]:
    """What this project actually does on each pull request event."""
    _require_project(repositories, context, project_id)
    stored = repositories.project_config.list_transitions(context.workspace_id, project_id)
    statuses = repositories.project_config.list_statuses(context.workspace_id, project_id)
    return effective_transitions(project_id, stored, statuses)


@router.post(
    "/{workspace_id}/projects/{project_id}/github-transitions",
    response_model=TransitionRead,
    status_code=status.HTTP_201_CREATED,
)
def create_transition(
    project_id: Annotated[str, Path(min_length=1)],
    payload: TransitionCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.PROJECT_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TransitionRead:
    """Add the rule for one trigger, which must not already have one."""
    _require_project(repositories, context, project_id)
    _check_status(repositories, context, project_id, payload.status_id)

    stored = repositories.project_config.list_transitions(context.workspace_id, project_id)
    if any(row.trigger == payload.trigger for row in stored):
        raise conflict("That trigger already has a rule.")

    transition_id = new_config_id()
    row = Transition(
        workspace_id=context.workspace_id,
        config_key=transition_key(project_id, transition_id),
        project_id=project_id,
        transition_id=transition_id,
        trigger=payload.trigger,
        status_id=payload.status_id or "",
        created_at=utc_now(),
    )
    return transition_read(repositories.project_config.create_transition(row))


@router.patch(
    "/{workspace_id}/projects/{project_id}/github-transitions/{transition_id}",
    response_model=TransitionRead,
)
def update_transition(
    project_id: Annotated[str, Path(min_length=1)],
    transition_id: str,
    payload: TransitionUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.PROJECT_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TransitionRead:
    """Repoint one rule at another status, or at none."""
    _require_project(repositories, context, project_id)
    _check_status(repositories, context, project_id, payload.status_id)
    updated = repositories.project_config.update_transition(
        context.workspace_id,
        project_id,
        transition_id,
        status_id=payload.status_id or "",
    )
    if updated is None:
        raise not_found()
    return transition_read(updated)


@router.delete(
    "/{workspace_id}/projects/{project_id}/github-transitions/{transition_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_transition(
    project_id: Annotated[str, Path(min_length=1)],
    transition_id: str,
    context: Annotated[AuthzContext, Depends(require(Capability.PROJECT_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Remove one rule. Removing the last one restores the defaults."""
    _require_project(repositories, context, project_id)
    if not repositories.project_config.delete_transition(context.workspace_id, project_id, transition_id):
        raise not_found()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
