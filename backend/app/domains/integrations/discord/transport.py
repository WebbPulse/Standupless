"""Posting one rendered channel message through the App's Discord bot.

The answer is shaped as the `WebhookResponse` an incoming webhook gives, so the
channel delivery loop retries, records and auto-disables a bot destination
exactly as it does a webhook one: a channel that is gone or the bot can no longer
see reads as a 404, a server the bot left as a 410, rate limiting as a 429, and an
unreachable Discord as a transport failure. The bot token is the App's own rather
than the install's, so Discord refusing it is a fault of this environment's keys
and is retried rather than read as the workspace uninstalling.
"""

from __future__ import annotations

import json

from webbpulse.events.webhooks import WebhookResponse

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.channels import ChannelDestination
from app.domains.integrations.discord import api, install

GONE_CHANNEL_CODES = frozenset({api.UNKNOWN_CHANNEL, api.MISSING_ACCESS, api.MISSING_PERMISSIONS})


def status_for(error: api.DiscordError) -> WebhookResponse:
    """The webhook style answer one Discord refusal amounts to."""
    if error.code == api.UNKNOWN_GUILD:
        return WebhookResponse(status_code=410, error="The Discord App is no longer in the server")
    if error.code in GONE_CHANNEL_CODES or error.status_code == 404:
        return WebhookResponse(status_code=404, error=f"Discord answered {error.status_code} ({error.code})")
    if error.status_code == 429:
        return WebhookResponse(status_code=429, error="Discord is rate limiting the App")
    if error.status_code == 401:
        return WebhookResponse(status_code=0, error="Blocked: Discord refused this environment's bot token")
    if error.status_code == 0 or error.status_code >= 500:
        return WebhookResponse(status_code=0, error="Discord could not be reached")
    return WebhookResponse(status_code=400, error=f"Discord answered {error.status_code} ({error.code})"[:200])


def post(repositories: Repositories, destination: ChannelDestination, body: str) -> WebhookResponse:
    """Post one rendered Discord message to the destination's channel as the bot."""
    installation = repositories.github.discord.get(destination.workspace_id)
    if installation is None or installation.guild_id != destination.discord_guild_id:
        return WebhookResponse(status_code=410, error="The Discord App is no longer installed")
    try:
        message = json.loads(body)
    except ValueError:
        return WebhookResponse(status_code=400, error="The message could not be read")
    if not isinstance(message, dict):
        return WebhookResponse(status_code=400, error="The message could not be read")
    payload = {**message, "allowed_mentions": {"parse": []}}
    try:
        api.bot("POST", f"/channels/{destination.discord_channel_id}/messages", payload)
    except api.DiscordError as error:
        answer = status_for(error)
        if answer.status_code == 410:
            install.forget_guild(repositories, installation.guild_id)
        return answer
    return WebhookResponse(status_code=200)
