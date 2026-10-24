"""Personal notifications as Discord direct messages: sending one member's batch as the bot.

The route is written when a member links their Discord account, from a command
or from their notification settings, and remembers the server the link was made
in, so a reinstall into a different server cannot deliver to a stranger.

Sending opens the member's DM channel with `POST /users/@me/channels`, which
Discord answers with the same channel every time, and posts one embed to it. A
refusal a retry cannot fix, such as closed DMs, no shared server or an unknown
user, marks the route broken and the member sees that in settings; a rate limit,
an outage or a refused bot token raises, so the queue retries a bounded number
of times and the dead-letter queue takes the rest.
"""

from __future__ import annotations

import logging
from typing import Any

from app.common.api.dependencies.repositories import Repositories
from app.common.chat_digests import ChatDigest
from app.common.db.dynamo.chat_routes import ChatRoute
from app.common.db.dynamo.discord import DiscordInstallation
from app.domains.integrations.channels.messages import TITLE_LIMIT, clip, discord_escape
from app.domains.integrations.discord import api

_log = logging.getLogger(__name__)

PROVIDER = "discord"

IDEMPOTENCY_SCOPE = "chat-digest-discord"

LINE_LIMIT = 300

DESCRIPTION_LIMIT = 4096
"""Discord's ceiling on an embed description."""

EMBED_COLOR = 0x5E6AD2

BROKEN_CODES = frozenset({api.UNKNOWN_USER, api.CANNOT_MESSAGE_USER, api.INVALID_RECIPIENT})
"""Discord refusals that mean the route will not work again until the member links anew."""

BROKEN_STATUSES = frozenset({403, 404})
"""Statuses that refuse this one person for good: closed DMs, no shared server, or a user who is gone."""

UNINSTALLED = "discord_uninstalled"

GUILD_CHANGED = "discord_guild_changed"


def route_problem(route: ChatRoute, installation: DiscordInstallation | None) -> str:
    """Why a route cannot deliver right now, or an empty string when it can."""
    if route.broken_at is not None:
        return route.broken_reason or "broken"
    if installation is None:
        return UNINSTALLED
    if route.external_team_id and route.external_team_id != installation.guild_id:
        return GUILD_CHANGED
    return ""


def broken_reason(error: api.DiscordError) -> str:
    """The reason code a permanent refusal is stored under, or `""` when a retry may get past it."""
    if error.code in BROKEN_CODES:
        return f"discord_{error.code}"
    if error.status_code in BROKEN_STATUSES:
        return f"discord_{error.status_code}"
    return ""


def retryable(error: api.DiscordError) -> bool:
    """Whether a later attempt may get past a refusal: a rate limit, an outage, or a refused bot token."""
    return error.status_code in (0, 401, 429) or error.status_code >= 500


def _cut(text: str, limit: int) -> str:
    """A block of lines cut to `limit` characters, keeping its line breaks."""
    return text if len(text) <= limit else text[: limit - 1] + "…"


def render(digest: ChatDigest) -> dict[str, Any]:
    """The message body for one batch: one embed that can mention nobody.

    Each issue, project or initiative is a bold link with its lines beneath, and
    every piece of member written text is Markdown escaped, so a title cannot
    open a link or format the message.
    """
    sections: list[str] = []
    for group in digest.groups:
        label = discord_escape(clip(group.label, TITLE_LIMIT))
        heading = f"**[{label}]({group.url})**" if group.url else f"**{label}**"
        lines = "\n".join(f"• {discord_escape(clip(line, LINE_LIMIT))}" for line in group.lines)
        sections.append(f"{heading}\n{lines}")
    footer = f"[Open your inbox]({digest.inbox_url})" if digest.inbox_url else "Open your inbox"
    if digest.more:
        footer = f"{digest.more} more in your inbox. {footer}"
    body = "\n\n".join(sections)
    description = _cut(body, DESCRIPTION_LIMIT - len(footer) - 2) + "\n\n" + footer
    count = digest.line_count + digest.more
    title = "1 Standupless notification" if count == 1 else f"{count} Standupless notifications"
    embed: dict[str, Any] = {"title": title, "description": description, "color": EMBED_COLOR}
    if digest.workspace_name:
        embed["footer"] = {"text": clip(digest.workspace_name, TITLE_LIMIT)}
    return {"embeds": [embed], "allowed_mentions": {"parse": []}}


def _break(repositories: Repositories, digest: ChatDigest, reason: str) -> None:
    """Stop delivery on the member's Discord route, logging the reason code alone."""
    repositories.inbox.chat_routes.mark_broken(digest.workspace_id, digest.recipient_id, PROVIDER, reason)
    _log.info(
        "Stopped Discord direct messages for a member.",
        extra={"event": "integrations.discord.dm_broken", "workspace_id": digest.workspace_id, "reason": reason},
    )


def _post(route: ChatRoute, digest: ChatDigest) -> None:
    """Open the member's DM channel and post the batch to it, raising `DiscordError` on a refusal."""
    channel = api.bot("POST", "/users/@me/channels", {"recipient_id": route.external_user_id})
    channel_id = str(channel.get("id", "")) if isinstance(channel, dict) else ""
    if not channel_id:
        raise api.DiscordError(502)
    api.bot("POST", f"/channels/{channel_id}/messages", render(digest))


def send(repositories: Repositories, digest: ChatDigest) -> bool:
    """Send one batch to the member's Discord direct messages, answering whether it was posted.

    A route that is missing or broken sends nothing. The window is claimed before
    the post, so a job delivered twice posts once, and the claim is released when
    the post raises for a reason a retry may get past.
    """
    route = repositories.inbox.chat_routes.get(digest.workspace_id, digest.recipient_id, PROVIDER)
    if route is None or not route.active:
        return False
    installation = repositories.github.discord.get(digest.workspace_id)
    problem = route_problem(route, installation)
    if problem:
        _break(repositories, digest, problem)
        return False
    if not repositories.idempotency.claim(digest.workspace_id, IDEMPOTENCY_SCOPE, digest.job_id):
        return False
    try:
        _post(route, digest)
    except api.DiscordError as error:
        reason = broken_reason(error)
        if reason:
            _break(repositories, digest, reason)
            return False
        if retryable(error):
            repositories.idempotency.release(digest.workspace_id, IDEMPOTENCY_SCOPE, digest.job_id)
            raise
        _log.warning(
            "Discord refused a direct message.",
            extra={
                "event": "integrations.discord.dm_refused",
                "workspace_id": digest.workspace_id,
                "status": error.status_code,
                "code": error.code,
            },
        )
        return False
    return True
