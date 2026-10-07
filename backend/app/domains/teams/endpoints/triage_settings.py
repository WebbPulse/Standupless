"""A team's triage switch: read by anyone who can see the team, changed by a team admin."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from app.common import issue_triage, team_writes
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.teams import TriageSettingsRead, TriageSettingsUpdate

router = APIRouter()


@router.get("/{workspace_id}/teams/{team_id}/triage-settings", response_model=TriageSettingsRead)
def read_triage_settings(
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TriageSettingsRead:
    """Whether the team routes issues filed from outside it into its triage inbox, off by default."""
    team = team_writes.load_team(repositories, context.workspace_id, str(context.team_id))
    return TriageSettingsRead.from_row(issue_triage.triage_settings(repositories, context.workspace_id, team.team_id))


@router.patch("/{workspace_id}/teams/{team_id}/triage-settings", response_model=TriageSettingsRead)
def update_triage_settings(
    payload: TriageSettingsUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TriageSettingsRead:
    """Turn the team's triage inbox on or off; issues already waiting stay until someone works them."""
    team = team_writes.load_team(repositories, context.workspace_id, str(context.team_id))
    saved = issue_triage.update_triage_settings(repositories, context.workspace_id, team.team_id, payload)
    return TriageSettingsRead.from_row(saved)
