"""Team channel destinations: Slack and Discord incoming webhooks a team posts to.

Team admins manage them under `/{workspace_id}/teams/{team_id}/webhooks/channels`, and the
path decides the team. They sit inside the team webhooks subtree because the gateway
already routes that prefix to this function, and this router is included before the
webhooks router so the literal `channels` segment wins over a `{webhook_id}`. The URL is a bearer credential for the channel, so it is
accepted on create and on an update that replaces it and never returned: reads
carry only its masked tail.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.domains.integrations.channels import manage
from app.domains.integrations.schemas.channels import ChannelCreate, ChannelRead, ChannelTestRead, ChannelUpdate
from app.domains.integrations.service import not_found, unavailable, unprocessable

router = APIRouter()

TeamAdmin = Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))]

Bundle = Annotated[Repositories, Depends(get_repositories)]

TeamId = Annotated[str, Path(min_length=1)]

ChannelId = Annotated[str, Path(min_length=1)]


def _require_team(repositories: Repositories, workspace_id: str, team_id: str) -> None:
    """Answer a team that is gone or going with a 404."""
    if repositories.teams.get(workspace_id, team_id) is None:
        raise not_found()


def _http(exc: Exception) -> HTTPException:
    """The HTTP answer for a management error."""
    if isinstance(exc, manage.ChannelError):
        return unprocessable(exc.message, exc.code)
    if isinstance(exc, manage.ChannelUnavailable):
        return unavailable(str(exc))
    return not_found()


@router.get("/{workspace_id}/teams/{team_id}/webhooks/channels", response_model=list[ChannelRead])
def list_team_channels(team_id: TeamId, context: TeamAdmin, repositories: Bundle) -> list[ChannelRead]:
    """The Slack and Discord channels a team posts to."""
    _require_team(repositories, context.workspace_id, team_id)
    return manage.list_for_team(repositories, context.workspace_id, team_id)


@router.post(
    "/{workspace_id}/teams/{team_id}/webhooks/channels", response_model=ChannelRead, status_code=status.HTTP_201_CREATED
)
def create_team_channel(
    team_id: TeamId, payload: ChannelCreate, context: TeamAdmin, repositories: Bundle
) -> ChannelRead:
    """Add a Slack or Discord channel to a team."""
    _require_team(repositories, context.workspace_id, team_id)
    try:
        return manage.create(repositories, context.workspace_id, team_id, context.user_id, payload)
    except (manage.ChannelError, manage.ChannelUnavailable) as exc:
        raise _http(exc) from exc


@router.patch("/{workspace_id}/teams/{team_id}/webhooks/channels/{channel_id}", response_model=ChannelRead)
def update_team_channel(
    team_id: TeamId, channel_id: ChannelId, payload: ChannelUpdate, context: TeamAdmin, repositories: Bundle
) -> ChannelRead:
    """Change one of a team's channels."""
    _require_team(repositories, context.workspace_id, team_id)
    try:
        return manage.update(repositories, context.workspace_id, team_id, channel_id, payload)
    except (manage.ChannelError, manage.ChannelUnavailable, manage.ChannelNotFound) as exc:
        raise _http(exc) from exc


@router.delete("/{workspace_id}/teams/{team_id}/webhooks/channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_team_channel(team_id: TeamId, channel_id: ChannelId, context: TeamAdmin, repositories: Bundle) -> Response:
    """Remove one of a team's channels."""
    _require_team(repositories, context.workspace_id, team_id)
    try:
        manage.delete(repositories, context.workspace_id, team_id, channel_id)
    except manage.ChannelNotFound as exc:
        raise _http(exc) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{workspace_id}/teams/{team_id}/webhooks/channels/{channel_id}/test", response_model=ChannelTestRead)
def test_team_channel(
    team_id: TeamId, channel_id: ChannelId, context: TeamAdmin, repositories: Bundle
) -> ChannelTestRead:
    """Post a test message to one of a team's channels and report what it answered."""
    _require_team(repositories, context.workspace_id, team_id)
    try:
        return manage.send_test_message(repositories, context.workspace_id, team_id, channel_id, context.user_id)
    except manage.ChannelNotFound as exc:
        raise _http(exc) from exc
