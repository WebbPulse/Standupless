"""A team's create by email addresses: read them, turn one on, regenerate it, turn it off.

Read under the team because the toggle lives on the team's settings, and a
template's address is named by `template_id` in the body or query rather than a
path of its own, so the whole surface sits under one gateway prefix.
"""

from __future__ import annotations

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, Path, Query, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.domains.integrations.email_intake import (
    disable_intake,
    enable_intake,
    read_team_intake,
    regenerate_intake,
)
from app.domains.integrations.schemas.integrations import EmailIntakeList, EmailIntakeRead, EmailIntakeWrite
from app.domains.integrations.service import not_found, require_team_content

router = APIRouter()


def _team(repositories: Repositories, context: AuthzContext, team_id: str) -> Any:
    """The team in this workspace whose content the caller can read, or a 404 or 403."""
    team = repositories.teams.get(context.workspace_id, team_id)
    if team is None:
        raise not_found()
    require_team_content(context, team_id)
    return team


@router.get("/{workspace_id}/teams/{team_id}/email-intake", response_model=EmailIntakeList)
def get_email_intake(
    team_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> EmailIntakeList:
    """The team's live create by email addresses, its own and its templates'."""
    team = _team(repositories, context, team_id)
    return read_team_intake(repositories, context.workspace_id, team)


@router.put("/{workspace_id}/teams/{team_id}/email-intake", response_model=EmailIntakeRead)
def put_email_intake(
    team_id: Annotated[str, Path(min_length=1)],
    payload: EmailIntakeWrite,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> EmailIntakeRead:
    """Turn the team's address, or one template's, on; an address already on is answered unchanged.

    Mail to it files issues as the admin who turned it on, so the 409 for a
    deployment without an intake domain and the 404 for an unknown template
    come before anything is written.
    """
    team = _team(repositories, context, team_id)
    return enable_intake(repositories, context, team, payload.template_id)


@router.post("/{workspace_id}/teams/{team_id}/email-intake/regenerate", response_model=EmailIntakeRead)
def regenerate_email_intake(
    team_id: Annotated[str, Path(min_length=1)],
    payload: EmailIntakeWrite,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> EmailIntakeRead:
    """Give a live address a fresh token, revoking the old address at once."""
    team = _team(repositories, context, team_id)
    return regenerate_intake(repositories, context, team, payload.template_id)


@router.delete("/{workspace_id}/teams/{team_id}/email-intake", status_code=status.HTTP_204_NO_CONTENT)
def delete_email_intake(
    team_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    template_id: Annotated[Optional[str], Query(min_length=1)] = None,
) -> Response:
    """Turn the team's address, or one template's, off, or 404 when it was not on."""
    team = _team(repositories, context, team_id)
    disable_intake(repositories, context, team, template_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
