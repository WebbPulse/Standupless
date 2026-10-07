"""The team standup digest: the digest itself, its settings and each member's note.

Served by the integrations image because it is the one function that reads every
table a digest is built from, activity, comments, issues and project updates, and
it is where the MCP tool that returns the same digest already lives.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.standup import StandupDigest, StandupWindowError
from app.domains.integrations import standup_service
from app.domains.integrations.schemas.standup import (
    DigestCadenceField,
    StandupNoteRead,
    StandupNoteWrite,
    StandupSettingsRead,
    StandupSettingsUpdate,
)
from app.domains.integrations.service import not_found, unprocessable

router = APIRouter()

DATE_PATTERN = r"^\d{4}-\d{2}-\d{2}$"


def _require_team(repositories: Repositories, context: AuthzContext, team_id: str) -> None:
    """Hold that the team exists in this workspace, or 404."""
    if repositories.teams.get(context.workspace_id, team_id) is None:
        raise not_found()


@router.get("/{workspace_id}/teams/{team_id}/standup", response_model=StandupDigest)
def get_standup(
    team_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    date: Annotated[str | None, Query(pattern=DATE_PATTERN)] = None,
    cadence: Annotated[DigestCadenceField | None, Query()] = None,
) -> StandupDigest:
    """The team's digest for one local date, today when left out, grouped by person."""
    _require_team(repositories, context, team_id)
    try:
        return standup_service.digest(repositories, context.workspace_id, team_id, date, cadence)
    except StandupWindowError as exc:
        raise unprocessable(str(exc)) from exc


@router.get("/{workspace_id}/teams/{team_id}/standup/settings", response_model=StandupSettingsRead)
def get_standup_settings(
    team_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> StandupSettingsRead:
    """When the team's digest is cut, and the date of the next one."""
    _require_team(repositories, context, team_id)
    return standup_service.settings_read(standup_service.settings_of(repositories, context.workspace_id, team_id))


@router.patch("/{workspace_id}/teams/{team_id}/standup/settings", response_model=StandupSettingsRead)
def update_standup_settings(
    team_id: Annotated[str, Path(min_length=1)],
    payload: StandupSettingsUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> StandupSettingsRead:
    """Change the team's digest cadence, send time, timezone or weekly day."""
    _require_team(repositories, context, team_id)
    try:
        return standup_service.update_settings(repositories, context.workspace_id, team_id, payload)
    except StandupWindowError as exc:
        raise unprocessable(str(exc)) from exc


@router.get("/{workspace_id}/teams/{team_id}/standup/note", response_model=StandupNoteRead)
def get_standup_note(
    team_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    date: Annotated[str | None, Query(pattern=DATE_PATTERN)] = None,
) -> StandupNoteRead:
    """The caller's own note for one digest date, the next digest when left out."""
    _require_team(repositories, context, team_id)
    try:
        return standup_service.read_note(repositories, context.workspace_id, team_id, context.user_id, date)
    except StandupWindowError as exc:
        raise unprocessable(str(exc)) from exc


@router.put("/{workspace_id}/teams/{team_id}/standup/note", response_model=StandupNoteRead)
def put_standup_note(
    team_id: Annotated[str, Path(min_length=1)],
    payload: StandupNoteWrite,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> StandupNoteRead:
    """Write the caller's note for one digest date, replacing an earlier one."""
    _require_team(repositories, context, team_id)
    try:
        return standup_service.write_note(repositories, context.workspace_id, team_id, context.user_id, payload)
    except StandupWindowError as exc:
        raise unprocessable(str(exc)) from exc


@router.delete("/{workspace_id}/teams/{team_id}/standup/note", status_code=status.HTTP_204_NO_CONTENT)
def delete_standup_note(
    team_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    date: Annotated[str | None, Query(pattern=DATE_PATTERN)] = None,
) -> Response:
    """Remove the caller's note for one digest date, 404 when there was none."""
    _require_team(repositories, context, team_id)
    try:
        removed = standup_service.delete_note(repositories, context.workspace_id, team_id, context.user_id, date)
    except StandupWindowError as exc:
        raise unprocessable(str(exc)) from exc
    if not removed:
        raise not_found()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
