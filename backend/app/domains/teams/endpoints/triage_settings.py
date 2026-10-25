"""A team's triage settings: read by anyone who can see the team, changed by a team admin."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from app.common import issue_triage, team_writes
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.teams import TriageSettingsRead, TriageSettingsUpdate
from app.common.triage_rules import rule_warnings

router = APIRouter()


@router.get("/{workspace_id}/teams/{team_id}/triage-settings", response_model=TriageSettingsRead)
def read_triage_settings(
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TriageSettingsRead:
    """The team's triage switch, who is on duty, whether accepting needs a priority and its ordered rules."""
    team = team_writes.load_team(repositories, context.workspace_id, str(context.team_id))
    settings = issue_triage.triage_settings(repositories, context.workspace_id, team.team_id)
    return TriageSettingsRead.from_row(settings, rule_warnings(repositories, settings))


@router.patch("/{workspace_id}/teams/{team_id}/triage-settings", response_model=TriageSettingsRead)
def update_triage_settings(
    payload: TriageSettingsUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TriageSettingsRead:
    """Change the team's triage settings; issues already waiting stay until someone works them."""
    team = team_writes.load_team(repositories, context.workspace_id, str(context.team_id))
    saved = issue_triage.update_triage_settings(repositories, context, team, payload)
    return TriageSettingsRead.from_row(saved, rule_warnings(repositories, saved))
