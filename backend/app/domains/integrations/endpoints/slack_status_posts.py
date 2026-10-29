"""A team's Slack status posts switch, under `/{workspace_id}/teams/{team_id}/webhooks/slack-status-posts`.

It sits beside the emoji intake setting in the team webhooks subtree, which the
gateway already routes to this function, and the router is included before the
webhooks router so the literal segment wins over a `{webhook_id}`. Anyone who can
read the team sees the switch, and only a team admin flips it.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path

from app.common import audit
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.core.config import settings
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.slack_status import SlackStatusSetting, setting_key
from app.domains.integrations.schemas.slack_status import SlackStatusPostsRead, SlackStatusPostsWrite
from app.domains.integrations.service import not_found, require_team_content

router = APIRouter()

TeamId = Annotated[str, Path(min_length=1)]

Bundle = Annotated[Repositories, Depends(get_repositories)]

PATH = "/{workspace_id}/teams/{team_id}/webhooks/slack-status-posts"


def _team(repositories: Repositories, context: AuthzContext, team_id: str) -> Any:
    """The team in this workspace whose content the caller can read, or a 404 or 403."""
    team = repositories.teams.get(context.workspace_id, team_id)
    if team is None:
        raise not_found()
    require_team_content(context, team_id)
    return team


def _read(repositories: Repositories, workspace_id: str, team_id: str) -> SlackStatusPostsRead:
    """The switch as the settings page shows it."""
    installed = settings.slack_configured and repositories.github.slack.get(workspace_id) is not None
    setting = repositories.github.slack_status.get_setting(workspace_id, team_id)
    return SlackStatusPostsRead(
        configured=settings.slack_configured,
        installed=installed,
        enabled=setting is None or setting.enabled,
        private_asks=setting is not None and setting.private_asks,
        updated_at=setting.updated_at if setting is not None else None,
    )


@router.get(PATH, response_model=SlackStatusPostsRead)
def get_slack_status_posts(
    team_id: TeamId,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Bundle,
) -> SlackStatusPostsRead:
    """Whether this team posts status changes into the Slack threads its issues came from."""
    _team(repositories, context, team_id)
    return _read(repositories, context.workspace_id, team_id)


@router.put(PATH, response_model=SlackStatusPostsRead)
def put_slack_status_posts(
    team_id: TeamId,
    payload: SlackStatusPostsWrite,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Bundle,
) -> SlackStatusPostsRead:
    """Turn status posts into paired Slack threads, or private asks from Slack, on or off for this team."""
    team = _team(repositories, context, team_id)
    store = repositories.github.slack_status
    current = store.get_setting(context.workspace_id, team_id)
    before = {
        "enabled": current is None or current.enabled,
        "private_asks": current is not None and current.private_asks,
    }
    after = {
        "enabled": before["enabled"] if payload.enabled is None else payload.enabled,
        "private_asks": before["private_asks"] if payload.private_asks is None else payload.private_asks,
    }
    store.put_setting(
        SlackStatusSetting(
            workspace_id=context.workspace_id,
            github_key=setting_key(team_id),
            team_id=team_id,
            enabled=after["enabled"],
            private_asks=after["private_asks"],
            updated_by=context.user_id,
            updated_at=utc_now(),
        )
    )
    audit.record(
        repositories,
        context,
        "slack_status_posts.updated",
        target_type="team",
        target_id=team.team_id,
        target_label=team.name,
        before=before,
        after=after,
    )
    return _read(repositories, context.workspace_id, team_id)
