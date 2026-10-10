"""Binding a Slack install to a workspace, calling Slack as its bot, and forgetting it.

One workspace holds at most one Slack team, and one Slack team serves at most one
workspace, because every request Slack sends names only the Slack team and has to
resolve to exactly one tenant. A second workspace trying to install into a Slack
team another workspace holds is refused rather than silently moving it.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

from webbpulse.identity.crypto import EnvelopeDecryptionFailed

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.slack import SlackInstallation, slack_install_key
from app.domains.integrations.chat.destinations import turn_off
from app.domains.integrations.slack import api
from app.domains.integrations.slack.tokens import TokenKeyMissing, open_token, sealed_fields

_log = logging.getLogger(__name__)

STATE_AUDIENCE = "standupless.slack-install"

NONCE_SCOPE = "slack-install-state"

MAX_CHANNEL_PAGES = 10

UNINSTALLED_REASON = "The Slack App was removed from the Slack workspace."

DISCONNECTED_REASON = "Slack was disconnected from this workspace."


class InstallRejected(Exception):
    """An OAuth answer that cannot be bound, with the outcome code the settings page shows."""

    def __init__(self, reason: str) -> None:
        """Carry the outcome code."""
        super().__init__(reason)
        self.reason = reason


class BotUnavailable(Exception):
    """The workspace has no installation, or its token will not open."""


def bind(repositories: Repositories, workspace_id: str, user_id: str, answer: Mapping[str, Any]) -> SlackInstallation:
    """Record the `oauth.v2.access` answer as this workspace's installation, or `InstallRejected`."""
    if answer.get("is_enterprise_install"):
        raise InstallRejected("enterprise_unsupported")
    team = answer.get("team") or {}
    slack_team_id = str(team.get("id", "") if isinstance(team, Mapping) else "")
    token = str(answer.get("access_token", ""))
    if not slack_team_id or not token or answer.get("token_type", "bot") != "bot":
        raise InstallRejected("error")
    store = repositories.github.slack
    holder = store.bound_workspace(slack_team_id)
    if holder and holder != workspace_id:
        raise InstallRejected("slack_team_taken")
    try:
        sealed = sealed_fields(workspace_id, slack_team_id, token)
    except TokenKeyMissing as error:
        raise InstallRejected("not_configured") from error
    now = utc_now()
    previous = store.get(workspace_id)
    installation = SlackInstallation(
        workspace_id=workspace_id,
        github_key=slack_install_key(slack_team_id),
        slack_team_id=slack_team_id,
        slack_team_name=str(team.get("name", "")),
        bot_user_id=str(answer.get("bot_user_id", "")),
        app_id=str(answer.get("app_id", "")),
        scopes=[scope for scope in str(answer.get("scope", "")).split(",") if scope],
        installed_by=user_id,
        installed_at=previous.installed_at if previous and previous.slack_team_id == slack_team_id else now,
        updated_at=now,
        **sealed,
    )
    return store.put(installation)


def token_for(installation: SlackInstallation) -> str:
    """The bot token of an installation, or `BotUnavailable` when it will not open."""
    try:
        return open_token(installation)
    except (EnvelopeDecryptionFailed, TokenKeyMissing, UnicodeDecodeError) as error:
        raise BotUnavailable("the bot token could not be read") from error


def call(installation: SlackInstallation, method: str, payload: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Call one Web API method as this installation's bot."""
    return api.call(method, token_for(installation), payload)


def list_channels(installation: SlackInstallation) -> list[dict[str, Any]]:
    """The channels the bot can post in: every public one, and the private ones it was invited to."""
    found: list[dict[str, Any]] = []
    cursor = ""
    for _ in range(MAX_CHANNEL_PAGES):
        payload: dict[str, Any] = {
            "types": "public_channel,private_channel",
            "exclude_archived": "true",
            "limit": 200,
        }
        if cursor:
            payload["cursor"] = cursor
        answer = call(installation, "conversations.list", payload)
        for channel in answer.get("channels") or []:
            if isinstance(channel, Mapping) and channel.get("id"):
                private = bool(channel.get("is_private"))
                if private and not channel.get("is_member"):
                    continue
                found.append({"id": str(channel["id"]), "name": str(channel.get("name", "")), "is_private": private})
        cursor = str((answer.get("response_metadata") or {}).get("next_cursor", "") or "")
        if not cursor:
            break
    return sorted(found, key=lambda channel: channel["name"])


def _turn_off_destinations(repositories: Repositories, workspace_id: str, reason: str, *, notify: bool) -> int:
    """Disable every destination that posts through the bot, which can no longer post."""
    return turn_off(repositories, workspace_id, "slack_app", reason, notify=notify)


def disconnect(repositories: Repositories, workspace_id: str) -> bool:
    """Revoke the bot token and forget the installation, at an admin's request."""
    installation = repositories.github.slack.get(workspace_id)
    if installation is None:
        return False
    try:
        call(installation, "auth.revoke")
    except (api.SlackError, BotUnavailable) as error:
        _log.info(
            "Revoking the Slack bot token did not succeed; forgetting it anyway.",
            extra={"event": "integrations.slack.revoke_failed", "reason": getattr(error, "code", "unreadable")},
        )
    repositories.github.slack.delete(workspace_id)
    _turn_off_destinations(repositories, workspace_id, DISCONNECTED_REASON, notify=False)
    return True


def forget_team(repositories: Repositories, slack_team_id: str) -> bool:
    """Forget the installation of a Slack team that removed the App or revoked its token."""
    workspace_id = repositories.github.slack.bound_workspace(slack_team_id)
    if not workspace_id:
        return False
    repositories.github.slack.delete(workspace_id)
    _turn_off_destinations(repositories, workspace_id, UNINSTALLED_REASON, notify=True)
    _log.info("Forgot a Slack installation Slack removed.", extra={"event": "integrations.slack.uninstalled"})
    return True
