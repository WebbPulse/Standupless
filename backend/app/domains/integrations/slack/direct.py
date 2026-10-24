"""Personal notifications as Slack direct messages: linking a member and sending their batch.

A member links themselves from their account settings. The bot looks their
Standupless address up in the installed Slack team, and only a confirmed address
on a live, full member of that team becomes the route, the same identity rule
the slash command and the shortcuts already act on. The route remembers the
Slack team, so a reinstall into a different team cannot deliver to a stranger.

Sending posts with `chat.postMessage` to the Slack user id, which lands in the
App's Messages tab. A refusal a retry cannot fix marks the route broken and the
member sees that in settings; a rate limit or an outage raises, so the queue
retries a bounded number of times and the dead-letter queue takes the rest.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

from app.common.api.dependencies.repositories import Repositories
from app.common.chat_digests import ChatDigest
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.chat_routes import ChatRoute
from app.common.db.dynamo.slack import SlackInstallation
from app.domains.integrations.channels.messages import TITLE_LIMIT, clip, slack_escape
from app.domains.integrations.slack import install
from app.domains.integrations.slack.api import SlackError
from app.domains.integrations.slack.people import email_of

_log = logging.getLogger(__name__)

PROVIDER = "slack"

IDEMPOTENCY_SCOPE = "chat-digest-slack"

LINE_LIMIT = 300

BROKEN_CODES = frozenset(
    {
        "account_inactive",
        "user_not_found",
        "user_disabled",
        "channel_not_found",
        "not_in_channel",
        "is_archived",
        "cannot_dm_bot",
        "messages_tab_disabled",
        "invalid_auth",
        "not_authed",
        "token_revoked",
        "token_expired",
        "missing_scope",
        "team_access_not_granted",
        "restricted_action",
    }
)
"""Slack refusals that mean the route will not work again until the member links anew."""

RETRY_CODES = frozenset(
    {
        "ratelimited",
        "unreachable",
        "invalid_response",
        "internal_error",
        "fatal_error",
        "service_unavailable",
        "request_timeout",
    }
)
"""Slack answers a later attempt may get past, raised so the queue redelivers the job."""

UNINSTALLED = "slack_uninstalled"

TEAM_CHANGED = "slack_team_changed"

BOT_UNREADABLE = "bot_unavailable"


class LinkRefused(Exception):
    """A link the member asked for that cannot be made, with the code the settings page shows."""

    def __init__(self, code: str) -> None:
        """Carry the outcome code."""
        super().__init__(code)
        self.code = code


def link(repositories: Repositories, installation: SlackInstallation, user_id: str) -> ChatRoute:
    """Link one member to the Slack user holding their confirmed address, or `LinkRefused`."""
    user = repositories.users.get(user_id)
    if user is None or not user.email_verified:
        raise LinkRefused("email_unverified")
    try:
        answer = install.call(installation, "users.lookupByEmail", {"email": user.email_lower})
    except SlackError as error:
        if error.code == "users_not_found":
            raise LinkRefused("slack_user_not_found") from error
        if error.code in RETRY_CODES:
            raise LinkRefused("slack_unavailable") from error
        raise LinkRefused("slack_refused") from error
    except install.BotUnavailable as error:
        raise LinkRefused("slack_unavailable") from error
    slack_user = answer.get("user") or {}
    slack_user_id = str(slack_user.get("id", "")) if isinstance(slack_user, Mapping) else ""
    if not slack_user_id or email_of(answer) != user.email_lower:
        raise LinkRefused("slack_user_not_found")
    return repositories.inbox.chat_routes.put(
        ChatRoute(
            workspace_id=installation.workspace_id,
            user_id=user_id,
            provider=PROVIDER,
            external_user_id=slack_user_id,
            external_team_id=installation.slack_team_id,
            linked_at=utc_now(),
        )
    )


def route_problem(route: ChatRoute, installation: SlackInstallation | None) -> str:
    """Why a route cannot deliver right now, or an empty string when it can."""
    if route.broken_at is not None:
        return route.broken_reason or "broken"
    if installation is None:
        return UNINSTALLED
    if route.external_team_id and route.external_team_id != installation.slack_team_id:
        return TEAM_CHANGED
    return ""


SECTION_LIMIT = 3000
"""Slack's ceiling on a section block's text."""


def clip_block(text: str) -> str:
    """A section's text cut to Slack's ceiling, keeping its line breaks."""
    return text if len(text) <= SECTION_LIMIT else text[: SECTION_LIMIT - 1] + "…"


def _line(text: str) -> str:
    """One notification sentence as inert mrkdwn."""
    return slack_escape(clip(text, LINE_LIMIT))


def render(digest: ChatDigest) -> dict[str, Any]:
    """The `chat.postMessage` body, without the channel, for one batch.

    One section per issue, project or initiative, its label linking to it and
    its lines beneath. Every piece of member written text is entity escaped, so
    a title cannot open a link or a mention.
    """
    blocks: list[dict[str, Any]] = []
    for group in digest.groups:
        label = slack_escape(clip(group.label, TITLE_LIMIT))
        heading = f"*<{group.url}|{label}>*" if group.url else f"*{label}*"
        body = "\n".join(f"• {_line(line)}" for line in group.lines)
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": clip_block(f"{heading}\n{body}")}})
    footer = f"<{digest.inbox_url}|Open your inbox>" if digest.inbox_url else "Open your inbox"
    if digest.more:
        footer = f"{digest.more} more in your inbox. {footer}"
    if digest.workspace_name:
        footer = f"{slack_escape(clip(digest.workspace_name, TITLE_LIMIT))} · {footer}"
    blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": footer}]})
    count = digest.line_count + digest.more
    if count == 1 and digest.groups:
        group = digest.groups[0]
        text = f"{group.label}: {group.lines[0]}"
    else:
        text = f"{count} Standupless notifications"
    return {"text": clip(text, LINE_LIMIT), "blocks": blocks, "unfurl_links": False, "unfurl_media": False}


def _break(repositories: Repositories, digest: ChatDigest, reason: str) -> None:
    """Stop delivery on the member's Slack route, logging the reason code alone."""
    repositories.inbox.chat_routes.mark_broken(digest.workspace_id, digest.recipient_id, PROVIDER, reason)
    _log.info(
        "Stopped Slack direct messages for a member.",
        extra={"event": "integrations.slack.dm_broken", "workspace_id": digest.workspace_id, "reason": reason},
    )


def send(repositories: Repositories, digest: ChatDigest) -> bool:
    """Send one batch to the member's Slack direct messages, answering whether it was posted.

    A route that is missing or broken sends nothing. The window is claimed before
    the post, so a job delivered twice posts once, and the claim is released when
    the post raises for a reason a retry may get past.
    """
    route = repositories.inbox.chat_routes.get(digest.workspace_id, digest.recipient_id, PROVIDER)
    if route is None or not route.active:
        return False
    installation = repositories.github.slack.get(digest.workspace_id)
    problem = route_problem(route, installation)
    if problem or installation is None:
        _break(repositories, digest, problem or UNINSTALLED)
        return False
    if not repositories.idempotency.claim(digest.workspace_id, IDEMPOTENCY_SCOPE, digest.job_id):
        return False
    try:
        install.call(installation, "chat.postMessage", {"channel": route.external_user_id, **render(digest)})
    except install.BotUnavailable:
        _break(repositories, digest, BOT_UNREADABLE)
        return False
    except SlackError as error:
        if error.code in BROKEN_CODES:
            _break(repositories, digest, error.code)
            return False
        if error.code in RETRY_CODES or error.status_code >= 500:
            repositories.idempotency.release(digest.workspace_id, IDEMPOTENCY_SCOPE, digest.job_id)
            raise
        _log.warning(
            "Slack refused a direct message.",
            extra={"event": "integrations.slack.dm_refused", "workspace_id": digest.workspace_id, "code": error.code},
        )
        return False
    return True
