"""A team's Slack emoji reaction intake, under `/{workspace_id}/teams/{team_id}/webhooks/slack-intake`.

It sits inside the team webhooks subtree because the gateway already routes that
prefix to this function, and the router is included before the webhooks router so
the literal `slack-intake` segment wins over a `{webhook_id}`. Anyone who can read
the team sees the setting, and only a team admin changes it, since reactions then
file issues as that admin whenever the person reacting has no Standupless account.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Response, status

from app.common import audit
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.core.config import settings
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.slack import SlackInstallation
from app.common.db.dynamo.slack_intake import SlackReactionIntake, intake_key
from app.domains.integrations.schemas.slack import SlackIntakeRead, SlackIntakeWrite
from app.domains.integrations.service import conflict, not_configured, not_found, require_team_content, unprocessable
from app.domains.integrations.slack import install, reactions
from app.domains.integrations.slack.api import SlackError

_log = logging.getLogger(__name__)

router = APIRouter()

TeamId = Annotated[str, Path(min_length=1)]

Bundle = Annotated[Repositories, Depends(get_repositories)]


def _team(repositories: Repositories, context: AuthzContext, team_id: str) -> Any:
    """The team in this workspace whose content the caller can read, or a 404 or 403."""
    team = repositories.teams.get(context.workspace_id, team_id)
    if team is None:
        raise not_found()
    require_team_content(context, team_id)
    return team


def _installation(repositories: Repositories, workspace_id: str) -> SlackInstallation | None:
    """The workspace's Slack App installation, or `None` where this environment has no App."""
    if not settings.slack_configured:
        return None
    return repositories.github.slack.get(workspace_id)


def _read(repositories: Repositories, workspace_id: str, team_id: str) -> SlackIntakeRead:
    """The setting as the settings page shows it."""
    installation = _installation(repositories, workspace_id)
    intake = repositories.github.slack_intake.get(workspace_id, team_id)
    live = intake is not None and installation is not None and intake.slack_team_id == installation.slack_team_id
    return SlackIntakeRead(
        configured=settings.slack_configured,
        installed=installation is not None,
        enabled=live,
        reinstall=reactions.needs_reinstall(installation),
        emoji=intake.emoji if intake is not None and live else None,
        channel_ids=list(intake.channel_ids) if intake is not None and live else [],
        updated_at=intake.updated_at if intake is not None and live else None,
    )


def _join(installation: SlackInstallation, channel_ids: list[str]) -> None:
    """Have the bot join each chosen public channel, so Slack sends it the reactions there.

    A private channel refuses the join, and the bot has to be invited to it instead.
    """
    for channel_id in channel_ids:
        if not channel_id.startswith("C"):
            continue
        try:
            install.call(installation, "conversations.join", {"channel": channel_id})
        except (SlackError, install.BotUnavailable):
            _log.info(
                "Slack refused the join for an intake channel.",
                extra={"event": "integrations.slack.intake_join_failed"},
            )


@router.get("/{workspace_id}/teams/{team_id}/webhooks/slack-intake", response_model=SlackIntakeRead)
def get_slack_intake(
    team_id: TeamId,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Bundle,
) -> SlackIntakeRead:
    """The emoji and channels that file Slack messages into this team, if any."""
    _team(repositories, context, team_id)
    return _read(repositories, context.workspace_id, team_id)


@router.put("/{workspace_id}/teams/{team_id}/webhooks/slack-intake", response_model=SlackIntakeRead)
def put_slack_intake(
    team_id: TeamId,
    payload: SlackIntakeWrite,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Bundle,
) -> SlackIntakeRead:
    """Turn emoji reaction intake on, or change its emoji or channels.

    The same emoji in the same channel can file into only one team, so a reaction
    never splits one message across teams by accident.
    """
    team = _team(repositories, context, team_id)
    if not settings.slack_configured:
        raise not_configured("Slack App")
    installation = repositories.github.slack.get(context.workspace_id)
    if installation is None:
        raise conflict("Connect Slack to this workspace first.")
    emoji = reactions.normalize_emoji(payload.emoji)
    if not reactions.valid_emoji(emoji):
        raise unprocessable("Use an emoji name such as ticket or :ticket:.")
    channel_ids = list(dict.fromkeys(payload.channel_ids))
    store = repositories.github.slack_intake
    for other in store.list_workspace(context.workspace_id):
        if other.team_id == team_id or other.slack_team_id != installation.slack_team_id or other.emoji != emoji:
            continue
        if set(other.channel_ids) & set(channel_ids):
            raise conflict("Another team already files messages with this emoji in one of these channels.")
    current = store.get(context.workspace_id, team_id)
    now = utc_now()
    intake = SlackReactionIntake(
        workspace_id=context.workspace_id,
        github_key=intake_key(team_id),
        team_id=team_id,
        emoji=emoji,
        channel_ids=channel_ids,
        slack_team_id=installation.slack_team_id,
        enabled_by=context.user_id,
        created_at=current.created_at if current is not None else now,
        updated_at=now,
    )
    store.put(intake)
    _join(installation, channel_ids)
    audit.record(
        repositories,
        context,
        "slack_intake.updated",
        target_type="team",
        target_id=team.team_id,
        target_label=team.name,
        before={"emoji": current.emoji, "channel_ids": current.channel_ids} if current is not None else None,
        after={"emoji": emoji, "channel_ids": channel_ids},
    )
    return _read(repositories, context.workspace_id, team_id)


@router.delete("/{workspace_id}/teams/{team_id}/webhooks/slack-intake", status_code=status.HTTP_204_NO_CONTENT)
def delete_slack_intake(
    team_id: TeamId,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Bundle,
) -> Response:
    """Turn emoji reaction intake off, or 404 when it was not on."""
    team = _team(repositories, context, team_id)
    removed = repositories.github.slack_intake.delete(context.workspace_id, team_id)
    if removed is None:
        raise not_found()
    audit.record(
        repositories,
        context,
        "slack_intake.disabled",
        target_type="team",
        target_id=team.team_id,
        target_label=team.name,
        before={"emoji": removed.emoji, "channel_ids": removed.channel_ids},
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
