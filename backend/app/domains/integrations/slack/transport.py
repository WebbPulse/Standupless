"""Posting one rendered channel message through the workspace's Slack bot.

The answer is shaped as the `WebhookResponse` an incoming webhook gives, so the
channel delivery loop retries, records and auto-disables a bot destination
exactly as it does a webhook one: a channel that is gone or the bot was removed
from reads as a 404, a revoked or missing installation as a 410, rate limiting
as a 429, and an unreachable Slack as a transport failure.
"""

from __future__ import annotations

import json

from webbpulse.events.webhooks import WebhookResponse

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.channels import ChannelDestination
from app.domains.integrations.slack import install
from app.domains.integrations.slack.api import SlackError

GONE_CHANNEL_ERRORS = frozenset({"channel_not_found", "is_archived", "not_in_channel"})

REVOKED_ERRORS = frozenset(
    {"invalid_auth", "account_inactive", "token_revoked", "not_authed", "team_access_not_granted", "token_expired"}
)


def status_for(error: SlackError) -> WebhookResponse:
    """The webhook style answer one Slack refusal amounts to."""
    if error.code in GONE_CHANNEL_ERRORS:
        return WebhookResponse(status_code=404, error=f"Slack answered {error.code}")
    if error.code in REVOKED_ERRORS:
        return WebhookResponse(status_code=410, error=f"Slack answered {error.code}")
    if error.code == "ratelimited":
        return WebhookResponse(status_code=429, error="Slack is rate limiting the App")
    if error.code == "unreachable":
        return WebhookResponse(status_code=0, error="Slack could not be reached")
    return WebhookResponse(status_code=400, error=f"Slack answered {error.code}"[:200])


def post(repositories: Repositories, destination: ChannelDestination, body: str) -> WebhookResponse:
    """Post one rendered Slack message to the destination's channel as the bot."""
    installation = repositories.github.slack.get(destination.workspace_id)
    if installation is None or installation.slack_team_id != destination.slack_team_id:
        return WebhookResponse(status_code=410, error="The Slack App is no longer installed")
    try:
        message = json.loads(body)
    except ValueError:
        return WebhookResponse(status_code=400, error="The message could not be read")
    if not isinstance(message, dict):
        return WebhookResponse(status_code=400, error="The message could not be read")
    payload = {**message, "channel": destination.slack_channel_id, "unfurl_links": False, "unfurl_media": False}
    try:
        install.call(installation, "chat.postMessage", payload)
    except install.BotUnavailable:
        return WebhookResponse(status_code=0, error="Blocked: the stored Slack token could not be read")
    except SlackError as error:
        return status_for(error)
    return WebhookResponse(status_code=200)
