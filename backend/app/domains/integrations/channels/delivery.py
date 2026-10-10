"""Posting channel notifications on the webhook dispatch queue, with retries and auto-disable.

Each message is a short lived delivery row and one queued `channel.attempt` job per
attempt, on the same queue and under the same per workspace in-flight slots as the
outbound webhooks, so a slow Slack or Discord costs no more of the consumer than a
slow receiver does. The job carries ids only; the URL is opened from the sealed
destination row inside the attempt and is never queued, stored in the clear or logged.

A failure another attempt could fix is retried on the webhooks' backoff. A 404 or a
410 means the webhook was deleted or its channel archived, so the destination is
turned off at once with a reason, and every admin of its team is told in the inbox.
"""

from __future__ import annotations

import logging
import secrets
import time
from datetime import datetime
from typing import Any, Callable, Mapping

from webbpulse.dynamodb import new_ulid
from webbpulse.events import EventEnvelope, enqueue
from webbpulse.events.webhooks import WebhookResponse, WebhookSender
from webbpulse.identity.crypto import EnvelopeDecryptionFailed

from app.common.api.dependencies.repositories import Repositories
from app.common.core.config import settings
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.channels import (
    CHANNEL_DELIVERY_RETENTION_SECONDS,
    ChannelDelivery,
    ChannelDestination,
    channel_delivery_key,
)
from app.common.db.dynamo.inbox import Notification, inbox_partition, instant
from app.domains.integrations.channels.messages import ChannelMessage, render
from app.domains.integrations.channels.urls import ChannelKeyMissing, open_url
from app.domains.integrations.outbound.delivery import (
    BACKOFF_SECONDS,
    DEFER_JITTER_SECONDS,
    DEFER_SECONDS,
    MAX_ATTEMPTS,
    SLOT_LEASE_SECONDS,
    WORKSPACE_IN_FLIGHT_LIMIT,
    new_delivery_id,
    retryable,
)
from app.domains.integrations.outbound.ssrf import DELIVERY_TIMEOUT_SECONDS, PinnedHttpsSender
from app.domains.integrations.slack import transport as slack_transport

_log = logging.getLogger(__name__)

CHANNEL_ATTEMPT_JOB = "channel.attempt"

GONE_STATUSES = frozenset({404, 410})
"""What Slack and Discord answer once a webhook is deleted or its channel archived."""

GONE_REASON = "The channel answered {status}: the webhook was removed or the channel archived."

DISABLED_KIND = "channel_disabled"
"""The inbox kind that tells a team admin a destination was turned off."""

ADMIN_ROLES = frozenset({"owner", "admin"})

MAX_NOTICE_RECIPIENTS = 50

USER_AGENT = "Standupless-Channels/1.0"

ERROR_LIMIT = 200

type Enqueue = Callable[..., Any]


def _queue(
    workspace_id: str, channel_id: str, delivery_id: str, number: int, *, delay: int = 0, send: Enqueue | None = None
) -> None:
    """Queue attempt `number` of one channel delivery, after `delay` seconds."""
    (send or enqueue)(
        settings.WEBHOOK_DISPATCH_QUEUE_URL,
        EventEnvelope(
            name=CHANNEL_ATTEMPT_JOB,
            payload={
                "kind": CHANNEL_ATTEMPT_JOB,
                "workspace_id": workspace_id,
                "channel_id": channel_id,
                "delivery_id": delivery_id,
                "attempt": number,
            },
            scope=workspace_id,
        ),
        delay_seconds=delay or None,
    )


def schedule(
    repositories: Repositories,
    destination: ChannelDestination,
    event: str,
    message: ChannelMessage,
    *,
    seed: str,
    at: datetime | None = None,
    send: Enqueue | None = None,
) -> bool:
    """Log one message to one destination and queue its first attempt.

    The delivery id is derived from `seed`, so the same stream record or reminder
    handed over twice lands on the same row and queues nothing new, unless the first
    run wrote the row and failed before it queued.
    """
    now = utc_now()
    delivery_id = new_delivery_id(f"{seed}#{destination.channel_id}", at=at)
    delivery = ChannelDelivery(
        workspace_id=destination.workspace_id,
        github_key=channel_delivery_key(destination.channel_id, delivery_id),
        channel_id=destination.channel_id,
        delivery_id=delivery_id,
        event=event,
        body=render(destination.provider, message),
        created_at=now,
        updated_at=now,
        expires_at=int(now.timestamp()) + CHANNEL_DELIVERY_RETENTION_SECONDS,
    )
    store = repositories.github.channels
    if not store.create_delivery(delivery):
        existing = store.get_delivery(destination.workspace_id, destination.channel_id, delivery_id)
        if existing is None or existing.attempts or existing.state != "pending":
            return False
    _queue(destination.workspace_id, destination.channel_id, delivery_id, 1, send=send)
    return True


def post(
    destination: ChannelDestination,
    body: str,
    *,
    sender: WebhookSender | None = None,
    repositories: Repositories | None = None,
) -> WebhookResponse:
    """Make one attempt at posting `body` to a destination, through the SSRF safe sender.

    A URL that will not open, or an environment with no key, is a failed attempt
    with a fixed message rather than an exception, so nothing upstream ever formats
    the URL or the ciphertext into an error. A destination that posts through the
    Slack App goes through the workspace's bot instead, which needs the bundle.
    """
    if destination.transport == "slack_app":
        if repositories is None:
            return WebhookResponse(status_code=0, error="Blocked: the Slack App could not be reached")
        return slack_transport.post(repositories, destination, body)
    try:
        url = open_url(destination)
    except (EnvelopeDecryptionFailed, ChannelKeyMissing, UnicodeDecodeError):
        return WebhookResponse(status_code=0, error="Blocked: the stored webhook URL could not be read")
    return (sender or PinnedHttpsSender()).post(
        url,
        body=body.encode(),
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
        timeout=DELIVERY_TIMEOUT_SECONDS,
    )


def _error(response: WebhookResponse) -> str | None:
    """What went wrong with an attempt, bounded, never including the response body."""
    if response.delivered:
        return None
    if response.error:
        return response.error[:ERROR_LIMIT]
    return f"HTTP {response.status_code}"


def _note(repositories: Repositories, destination: ChannelDestination, response: WebhookResponse) -> None:
    """Record the latest status on the destination, which the settings list shows."""
    repositories.github.channels.update(
        destination.workspace_id,
        destination.channel_id,
        last_status=response.status_code,
        last_delivery_at=utc_now().isoformat(),
    )


def notice_recipients(repositories: Repositories, workspace_id: str, team_id: str) -> list[str]:
    """Everybody who administers the team: its own admins and the workspace's owners and admins."""
    recipients: dict[str, None] = {}
    for membership in repositories.memberships.list_team_members(workspace_id, team_id):
        if membership.role == "admin":
            recipients[membership.user_id] = None
    for membership in repositories.memberships.list_members(workspace_id):
        if membership.role in ADMIN_ROLES:
            recipients[membership.user_id] = None
    return list(recipients)[:MAX_NOTICE_RECIPIENTS]


def notify_disabled(repositories: Repositories, destination: ChannelDestination) -> int:
    """Put a notice in every team admin's inbox that a destination was turned off."""
    team = repositories.teams.get(destination.workspace_id, destination.team_id)
    prefix = team.key_prefix if team is not None else ""
    provider = "Slack" if destination.provider == "slack" else "Discord"
    name = destination.label or destination.url_hint
    now = utc_now()
    sent = 0
    for user_id in notice_recipients(repositories, destination.workspace_id, destination.team_id):
        notification = Notification(
            ws_user=inbox_partition(destination.workspace_id, user_id),
            notification_id=new_ulid(),
            workspace_id=destination.workspace_id,
            kind=DISABLED_KIND,
            issue_key=prefix,
            issue_title=f"{provider} channel {name} was turned off",
            team_id=destination.team_id,
            actor_id="",
            actor_name="",
            recipient_id=user_id,
            created_at=now,
            unread_at=instant(now),
        )
        if repositories.inbox.create(notification):
            sent += 1
    return sent


def _disable(repositories: Repositories, destination: ChannelDestination, status: int) -> None:
    """Turn a gone destination off and tell its team admins, once however many attempts see it."""
    if repositories.github.channels.disable(
        destination.workspace_id, destination.channel_id, reason=GONE_REASON.format(status=status), status=status
    ):
        notify_disabled(repositories, destination)
        _log.warning(
            "Turned off a channel destination whose webhook is gone.",
            extra={"event": "integrations.channel.auto_disabled", "status": status, "provider": destination.provider},
        )


def run_attempt(
    repositories: Repositories,
    job: Mapping[str, Any],
    *,
    sender: WebhookSender | None = None,
    send: Enqueue | None = None,
) -> str:
    """Handle one queued channel attempt and return what became of the delivery."""
    workspace_id = str(job.get("workspace_id", ""))
    channel_id = str(job.get("channel_id", ""))
    delivery_id = str(job.get("delivery_id", ""))
    number = int(job.get("attempt", 1) or 1)
    store = repositories.github.channels

    destination = store.get(workspace_id, channel_id)
    delivery = store.get_delivery(workspace_id, channel_id, delivery_id)
    if destination is None or delivery is None:
        return "missing"
    if delivery.state in ("delivered", "failed") or delivery.attempts >= number:
        return "duplicate"
    if not destination.enabled:
        store.put_delivery(delivery.model_copy(update={"state": "failed", "updated_at": utc_now()}))
        return "skipped"

    leased = repositories.github.acquire_dispatch_slot(
        workspace_id, limit=WORKSPACE_IN_FLIGHT_LIMIT, lease_seconds=SLOT_LEASE_SECONDS, now_ms=int(time.time() * 1000)
    )
    if leased is None:
        delay = DEFER_SECONDS + secrets.randbelow(DEFER_JITTER_SECONDS + 1)
        _queue(workspace_id, channel_id, delivery_id, number, delay=delay, send=send)
        return "deferred"
    try:
        response = post(destination, delivery.body, sender=sender, repositories=repositories)
    finally:
        repositories.github.release_dispatch_slot(workspace_id, *leased)

    attempted = delivery.model_copy(
        update={
            "attempts": number,
            "last_status": response.status_code,
            "last_error": _error(response),
            "updated_at": utc_now(),
        }
    )
    if response.delivered:
        store.put_delivery(attempted.model_copy(update={"state": "delivered"}))
        _note(repositories, destination, response)
        return "delivered"
    if response.status_code in GONE_STATUSES:
        store.put_delivery(attempted.model_copy(update={"state": "failed"}))
        _disable(repositories, destination, response.status_code)
        return "disabled"
    _note(repositories, destination, response)
    if retryable(response) and number < MAX_ATTEMPTS:
        store.put_delivery(attempted.model_copy(update={"state": "retrying"}))
        delay = BACKOFF_SECONDS[min(number, len(BACKOFF_SECONDS)) - 1]
        _queue(workspace_id, channel_id, delivery_id, number + 1, delay=delay, send=send)
        return "retrying"
    store.put_delivery(attempted.model_copy(update={"state": "failed"}))
    return "failed"


def build_test_message(
    destination: ChannelDestination, actor_name: str, team_name: str, team_url: str
) -> ChannelMessage:
    """The message the Send test message button posts."""
    return ChannelMessage(
        event="test",
        subject=f"Standupless test message for {team_name}",
        url=team_url,
        summary=(
            f"This channel will get {team_name}'s notifications. "
            f"{len(destination.events)} event{'s' if len(destination.events) != 1 else ''} selected."
        ),
        actor=actor_name,
        at=utc_now(),
    )


def send_test(
    repositories: Repositories,
    destination: ChannelDestination,
    message: ChannelMessage,
    *,
    sender: WebhookSender | None = None,
) -> WebhookResponse:
    """Post a test message from a request and record its status, without disabling anything.

    An admin probing a destination sees a 404 as the answer rather than having the
    probe itself turn the destination off.
    """
    response = post(destination, render(destination.provider, message), sender=sender, repositories=repositories)
    _note(repositories, destination, response)
    return response


def describe_error(response: WebhookResponse) -> str | None:
    """The error a test result reports, which never carries the URL or the response body."""
    return _error(response)
