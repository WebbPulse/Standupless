"""Team channel destinations: Slack and Discord incoming webhooks a team posts to.

Team admins manage them under `/{workspace_id}/teams/{team_id}/webhooks/channels`, and the
path decides the team. They sit inside the team webhooks subtree because the gateway
already routes that prefix to this function, and this router is included before the
webhooks router so the literal `channels` segment wins over a `{webhook_id}`. The URL
is a bearer credential for the channel, so it is accepted on create and on an update
that replaces it and never returned: reads carry only its masked tail. A channel can
instead post through the workspace's installed Slack or Discord App, picked from the
list `slack-channels` or `discord-channels` answers, and then has no URL at all.

Workspace owners and admins manage the workspace's own channels under
`/{workspace_id}/webhooks/channels`. Those always post through an installed App and
follow every open team or a chosen few, and their pickers are `/{workspace_id}/slack/channels`
and `/{workspace_id}/discord/channels`. A team route never reads or changes a
workspace channel, and a workspace route never a team's.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.domains.integrations.channels import manage
from app.domains.integrations.discord import install as discord_install
from app.domains.integrations.discord.api import DiscordError
from app.domains.integrations.schemas.channels import (
    ChannelCreate,
    ChannelRead,
    ChannelTestRead,
    ChannelUpdate,
    WorkspaceChannelCreate,
    WorkspaceChannelUpdate,
)
from app.domains.integrations.schemas.discord import DiscordChannelRead
from app.domains.integrations.schemas.slack import SlackChannelRead
from app.domains.integrations.service import not_found, require_team_content, unavailable, unprocessable
from app.domains.integrations.slack import install as slack_install
from app.domains.integrations.slack.api import SlackError

router = APIRouter()

TeamAdmin = Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))]

WorkspaceAdmin = Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))]

Bundle = Annotated[Repositories, Depends(get_repositories)]

TeamId = Annotated[str, Path(min_length=1)]

ChannelId = Annotated[str, Path(min_length=1)]


def _require_team(repositories: Repositories, workspace_id: str, team_id: str) -> None:
    """Answer a team that is gone or going with a 404."""
    if repositories.teams.get(workspace_id, team_id) is None:
        raise not_found()


def _http(exc: Exception) -> HTTPException:
    """The HTTP answer for a management error."""
    if isinstance(exc, manage.ChannelError) and exc.code == "PRIVATE_TEAM":
        return HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail={"error_code": exc.code, "message": exc.message}
        )
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


def _slack_channels(repositories: Repositories, workspace_id: str) -> list[SlackChannelRead]:
    """The Slack channels the workspace's Slack App can post to, or a 404 before it is installed."""
    installation = repositories.github.slack.get(workspace_id)
    if installation is None:
        raise not_found()
    try:
        channels = slack_install.list_channels(installation)
    except (SlackError, slack_install.BotUnavailable) as exc:
        raise unavailable("Slack did not list the channels. Try again.") from exc
    return [SlackChannelRead.model_validate(channel) for channel in channels]


def _discord_channels(repositories: Repositories, workspace_id: str) -> list[DiscordChannelRead]:
    """The Discord channels the workspace's Discord App can post to, or a 404 before it is installed."""
    installation = repositories.github.discord.get(workspace_id)
    if installation is None:
        raise not_found()
    try:
        channels = discord_install.list_channels(repositories, installation)
    except discord_install.BotUnavailable as exc:
        raise not_found() from exc
    except DiscordError as exc:
        raise unavailable("Discord did not list the channels. Try again.") from exc
    return [DiscordChannelRead.model_validate(channel) for channel in channels]


@router.get("/{workspace_id}/teams/{team_id}/webhooks/slack-channels", response_model=list[SlackChannelRead])
def list_slack_channels(team_id: TeamId, context: TeamAdmin, repositories: Bundle) -> list[SlackChannelRead]:
    """The Slack channels the workspace's Slack App can post to, for the add channel picker."""
    _require_team(repositories, context.workspace_id, team_id)
    require_team_content(context, team_id)
    return _slack_channels(repositories, context.workspace_id)


@router.get("/{workspace_id}/teams/{team_id}/webhooks/discord-channels", response_model=list[DiscordChannelRead])
def list_discord_channels(team_id: TeamId, context: TeamAdmin, repositories: Bundle) -> list[DiscordChannelRead]:
    """The Discord channels the workspace's Discord App can post to, for the add channel picker."""
    _require_team(repositories, context.workspace_id, team_id)
    require_team_content(context, team_id)
    return _discord_channels(repositories, context.workspace_id)


@router.post(
    "/{workspace_id}/teams/{team_id}/webhooks/channels", response_model=ChannelRead, status_code=status.HTTP_201_CREATED
)
def create_team_channel(
    team_id: TeamId, payload: ChannelCreate, context: TeamAdmin, repositories: Bundle
) -> ChannelRead:
    """Add a Slack or Discord channel to a team."""
    _require_team(repositories, context.workspace_id, team_id)
    require_team_content(context, team_id)
    try:
        return manage.create(repositories, context, team_id, payload)
    except (manage.ChannelError, manage.ChannelUnavailable) as exc:
        raise _http(exc) from exc


@router.patch("/{workspace_id}/teams/{team_id}/webhooks/channels/{channel_id}", response_model=ChannelRead)
def update_team_channel(
    team_id: TeamId, channel_id: ChannelId, payload: ChannelUpdate, context: TeamAdmin, repositories: Bundle
) -> ChannelRead:
    """Change one of a team's channels."""
    _require_team(repositories, context.workspace_id, team_id)
    if payload.enabled is not False:
        require_team_content(context, team_id)
    try:
        return manage.update(repositories, context, team_id, channel_id, payload)
    except (manage.ChannelError, manage.ChannelUnavailable, manage.ChannelNotFound) as exc:
        raise _http(exc) from exc


@router.delete("/{workspace_id}/teams/{team_id}/webhooks/channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_team_channel(team_id: TeamId, channel_id: ChannelId, context: TeamAdmin, repositories: Bundle) -> Response:
    """Remove one of a team's channels."""
    _require_team(repositories, context.workspace_id, team_id)
    try:
        manage.delete(repositories, context, team_id, channel_id)
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


@router.get("/{workspace_id}/slack/channels", response_model=list[SlackChannelRead])
def list_workspace_slack_channels(context: WorkspaceAdmin, repositories: Bundle) -> list[SlackChannelRead]:
    """The Slack channels the Slack App can post to, for the workspace channel picker."""
    return _slack_channels(repositories, context.workspace_id)


@router.get("/{workspace_id}/discord/channels", response_model=list[DiscordChannelRead])
def list_workspace_discord_channels(context: WorkspaceAdmin, repositories: Bundle) -> list[DiscordChannelRead]:
    """The Discord channels the Discord App can post to, for the workspace channel picker."""
    return _discord_channels(repositories, context.workspace_id)


@router.get("/{workspace_id}/webhooks/channels", response_model=list[ChannelRead])
def list_workspace_channels(context: WorkspaceAdmin, repositories: Bundle) -> list[ChannelRead]:
    """The Slack and Discord channels that follow the whole workspace."""
    return manage.list_for_workspace(repositories, context.workspace_id)


@router.post("/{workspace_id}/webhooks/channels", response_model=ChannelRead, status_code=status.HTTP_201_CREATED)
def create_workspace_channel(
    payload: WorkspaceChannelCreate, context: WorkspaceAdmin, repositories: Bundle
) -> ChannelRead:
    """Add a Slack or Discord channel that follows every open team, or the teams it names."""
    try:
        return manage.create(repositories, context, None, payload)
    except (manage.ChannelError, manage.ChannelUnavailable) as exc:
        raise _http(exc) from exc


@router.patch("/{workspace_id}/webhooks/channels/{channel_id}", response_model=ChannelRead)
def update_workspace_channel(
    channel_id: ChannelId, payload: WorkspaceChannelUpdate, context: WorkspaceAdmin, repositories: Bundle
) -> ChannelRead:
    """Change one of the workspace's channels."""
    try:
        return manage.update(repositories, context, None, channel_id, payload)
    except (manage.ChannelError, manage.ChannelUnavailable, manage.ChannelNotFound) as exc:
        raise _http(exc) from exc


@router.delete("/{workspace_id}/webhooks/channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workspace_channel(channel_id: ChannelId, context: WorkspaceAdmin, repositories: Bundle) -> Response:
    """Remove one of the workspace's channels."""
    try:
        manage.delete(repositories, context, None, channel_id)
    except manage.ChannelNotFound as exc:
        raise _http(exc) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{workspace_id}/webhooks/channels/{channel_id}/test", response_model=ChannelTestRead)
def test_workspace_channel(channel_id: ChannelId, context: WorkspaceAdmin, repositories: Bundle) -> ChannelTestRead:
    """Post a test message to one of the workspace's channels and report what it answered."""
    try:
        return manage.send_test_message(repositories, context.workspace_id, None, channel_id, context.user_id)
    except manage.ChannelNotFound as exc:
        raise _http(exc) from exc
