"""Recurring issue routes: a team's schedules that create an issue from a template.

Any team member may keep the team's schedules, as with its templates. A patch
pauses or resumes one through `paused`, and resuming sets the next run from now.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Response, status

from app.common import recurring_issues
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.recurring import RecurringCreate, RecurringListRead, RecurringRead, RecurringUpdate

router = APIRouter()


@router.get("/{workspace_id}/teams/{team_id}/recurring-issues", response_model=RecurringListRead)
def list_recurring_issues(
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> RecurringListRead:
    """Every recurring issue of the team, oldest first, and the timezone new ones default to."""
    rows, names, zone = recurring_issues.list_recurring(repositories, context, str(context.team_id))
    return RecurringListRead(
        recurring_issues=[
            RecurringRead.from_row(row, names.get(row.template_id), recurring_issues.preview(row)) for row in rows
        ],
        default_timezone=zone,
    )


@router.post(
    "/{workspace_id}/teams/{team_id}/recurring-issues",
    response_model=RecurringRead,
    status_code=status.HTTP_201_CREATED,
)
def create_recurring_issue(
    payload: RecurringCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> RecurringRead:
    """Schedule an issue from one of the team's templates."""
    row = recurring_issues.create_recurring(repositories, context, str(context.team_id), payload)
    return recurring_issues.read(repositories, context, row)


@router.get("/{workspace_id}/teams/{team_id}/recurring-issues/{recurring_id}", response_model=RecurringRead)
def read_recurring_issue(
    recurring_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> RecurringRead:
    """One recurring issue of the team, with its next runs."""
    row = recurring_issues.get_recurring(repositories, context, str(context.team_id), recurring_id)
    return recurring_issues.read(repositories, context, row)


@router.patch("/{workspace_id}/teams/{team_id}/recurring-issues/{recurring_id}", response_model=RecurringRead)
def update_recurring_issue(
    payload: RecurringUpdate,
    recurring_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> RecurringRead:
    """Change, pause or resume one recurring issue."""
    row = recurring_issues.update_recurring(repositories, context, str(context.team_id), recurring_id, payload)
    return recurring_issues.read(repositories, context, row)


@router.delete(
    "/{workspace_id}/teams/{team_id}/recurring-issues/{recurring_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_recurring_issue(
    recurring_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Delete one recurring issue; issues it already created stay."""
    recurring_issues.delete_recurring(repositories, context, str(context.team_id), recurring_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
