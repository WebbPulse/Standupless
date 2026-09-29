"""Sending outbound webhooks and keeping their delivery log.

Every delivery is a row in the `github` table, written before the first attempt and
updated after each one, so the log shows a delivery that is still being retried as
well as one that is finished. A stream change becomes one row per matching endpoint
and one queued job per attempt:

- Each job makes exactly one attempt. A failure that another attempt could fix
  queues the next attempt with an SQS delay from `BACKOFF_SECONDS`, so a receiver
  that is down is retried over about half an hour without a Lambda waiting on it.
- Every failed attempt counts towards the endpoint's run of failures, which is its
  circuit breaker. `CIRCUIT_BREAKER_THRESHOLD` failed attempts in a row open it: the
  endpoint is disabled with a reason and a time the settings page shows, and any
  delivered attempt resets the run. Re-enabling the endpoint closes the breaker.
- An open breaker fails fast. A queued attempt for a disabled endpoint ends its
  delivery without a request, so the backlog a dead receiver leaves drains in
  milliseconds rather than one timeout at a time.
- A workspace holds at most `WORKSPACE_IN_FLIGHT_LIMIT` attempts in flight at once,
  leased through one row per workspace. An attempt that finds every slot held goes
  back on the queue after a short jittered delay without calling anybody, so one
  workspace's slow or hanging receivers can occupy only a fixed share of the
  consumer's concurrency and every other workspace keeps the rest.
- A test ping and a redelivery are one synchronous attempt made from the request,
  so the caller sees the result at once. Neither moves the failure run, because an
  admin probing a broken endpoint should not be what disables it.

Deliveries are signed with the endpoint's secret exactly as it was shown, using the
upstream `webbpulse.events.webhooks` scheme: `X-Webhook-Signature` is `sha256=` and
the hex HMAC-SHA256 of `"<X-Webhook-Timestamp>.<body>"`.
"""

from __future__ import annotations

import hashlib
import json
import logging
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Mapping

from webbpulse.events import EventEnvelope, enqueue
from webbpulse.events.webhooks import RetryPolicy, WebhookDispatcher, WebhookResponse, WebhookSender

from app.common.api.dependencies.repositories import Repositories
from app.common.core.config import settings
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.github import (
    DELIVERY_RETENTION_SECONDS,
    DeliveryAttempt,
    WebhookDelivery,
    WebhookEndpoint,
    delivery_key,
)
from app.domains.integrations.outbound.payloads import OutboundEvent
from app.domains.integrations.outbound.ssrf import BLOCKED_PREFIX, DELIVERY_TIMEOUT_SECONDS, PinnedHttpsSender
from app.domains.integrations.service import mint_secret

_log = logging.getLogger(__name__)

ATTEMPT_JOB = "webhook.attempt"

MAX_ATTEMPTS = 5

BACKOFF_SECONDS: tuple[int, ...] = (60, 300, 900, 900)
"""The wait before attempts two to five, each inside SQS's 900 second delay ceiling."""

CIRCUIT_BREAKER_THRESHOLD = 10
"""How many failed attempts in a row open an endpoint's circuit breaker and disable it."""

DISABLED_REASON = "Disabled after {count} failed attempts in a row."

WORKSPACE_IN_FLIGHT_LIMIT = 3
"""How many attempts one workspace may have in flight at once, out of the consumer's concurrency of 10."""

SLOT_LEASE_SECONDS = DELIVERY_TIMEOUT_SECONDS + 10
"""How long a slot is held before it frees itself, longer than any attempt runs."""

DEFER_SECONDS = 10
"""The least an attempt waits when its workspace has every slot in use."""

DEFER_JITTER_SECONDS = 20
"""The most added to `DEFER_SECONDS`, so deferred attempts do not come back together."""

USER_AGENT = "Standupless-Webhooks/1.0"

DELIVERY_HEADER = "X-Webhook-Delivery"

EVENT_HEADER = "X-Webhook-Event"

_POLICY = RetryPolicy(attempts=1, timeout=DELIVERY_TIMEOUT_SECONDS)
"""One attempt per call: retries are queued jobs, never a Lambda sleeping in process."""

type Enqueue = Callable[..., Any]


def new_delivery_id(seed: str | None = None, *, at: datetime | None = None) -> str:
    """A delivery id that sorts by time, derived from `seed` when one is given.

    The stream consumer seeds it with the stream record and endpoint, so a stream batch
    that is delivered twice names the same delivery both times.
    """
    moment = at or utc_now()
    head = f"{int(moment.timestamp() * 1000):012x}"
    tail = hashlib.sha256(seed.encode()).hexdigest()[:16] if seed else secrets.token_hex(8)
    return head + tail


def canonical(body: Mapping[str, Any]) -> str:
    """The exact JSON text a body is signed and sent as: compact with sorted keys."""
    return json.dumps(body, separators=(",", ":"), sort_keys=True, default=str)


def signing_secret(endpoint: WebhookEndpoint) -> bytes:
    """The HMAC key for one endpoint, which is its secret exactly as it was shown."""
    return mint_secret(endpoint.webhook_id, endpoint.secret_salt).encode()


def retryable(response: WebhookResponse) -> bool:
    """Whether another attempt could plausibly succeed, which a refused destination cannot."""
    if response.error and response.error.startswith(BLOCKED_PREFIX):
        return False
    return response.retryable


def open_delivery(
    endpoint: WebhookEndpoint,
    event: OutboundEvent,
    *,
    delivery_id: str,
    is_test: bool = False,
    redelivery_of: str | None = None,
) -> WebhookDelivery:
    """A new, unattempted delivery row of `event` to `endpoint`."""
    now = utc_now()
    body = event.body(webhook_id=endpoint.webhook_id, delivery_id=delivery_id, timestamp_ms=int(now.timestamp() * 1000))
    return WebhookDelivery(
        workspace_id=endpoint.workspace_id,
        github_key=delivery_key(endpoint.webhook_id, delivery_id),
        delivery_id=delivery_id,
        webhook_id=endpoint.webhook_id,
        event_type=event.event_type,
        action=event.action,
        is_test=is_test,
        redelivery_of=redelivery_of,
        body=canonical(body),
        created_at=now,
        updated_at=now,
        expires_at=int(now.timestamp()) + DELIVERY_RETENTION_SECONDS,
    )


def attempt(
    endpoint: WebhookEndpoint,
    delivery: WebhookDelivery,
    *,
    sender: WebhookSender | None = None,
) -> tuple[WebhookDelivery, WebhookResponse]:
    """Make one signed attempt at a delivery and return it with that attempt recorded.

    Nothing is stored here, so a caller decides what the outcome means before writing.
    """
    dispatcher = WebhookDispatcher(sender or PinnedHttpsSender(), secret=signing_secret(endpoint), policy=_POLICY)
    started = time.monotonic()
    result = dispatcher.send(
        endpoint.url,
        delivery.body.encode(),
        event=delivery.event_type,
        headers={
            "User-Agent": USER_AGENT,
            DELIVERY_HEADER: delivery.delivery_id,
            EVENT_HEADER: delivery.event_type,
        },
    )
    latency_ms = int((time.monotonic() - started) * 1000)
    response = result.last_response or WebhookResponse(status_code=0, error="No attempt was made")
    now = utc_now()
    record = DeliveryAttempt(
        attempt=len(delivery.attempts) + 1,
        at=now,
        status_code=response.status_code,
        latency_ms=latency_ms,
        error=response.error,
        response_body=response.body[:2048],
    )
    updated = delivery.model_copy(update={"attempts": [*delivery.attempts, record], "updated_at": now})
    return updated, response


def _note_status(repositories: Repositories, endpoint: WebhookEndpoint, response: WebhookResponse) -> None:
    """Record the latest status on the endpoint row, which the settings list shows."""
    repositories.github.update_endpoint(
        endpoint.workspace_id,
        endpoint.webhook_id,
        last_status=response.status_code,
        last_delivery_at=utc_now().isoformat(),
    )


def _queue(
    workspace_id: str, webhook_id: str, delivery_id: str, number: int, *, delay: int = 0, send: Enqueue | None
) -> None:
    """Queue attempt `number` of one delivery, after `delay` seconds.

    `send` defaults to the module's `enqueue`, looked up at call time so a test can
    replace it in one place.
    """
    (send or enqueue)(
        settings.WEBHOOK_DISPATCH_QUEUE_URL,
        EventEnvelope(
            name=ATTEMPT_JOB,
            payload={
                "kind": ATTEMPT_JOB,
                "workspace_id": workspace_id,
                "webhook_id": webhook_id,
                "delivery_id": delivery_id,
                "attempt": number,
            },
            scope=workspace_id,
        ),
        delay_seconds=delay or None,
    )


def schedule(
    repositories: Repositories,
    endpoint: WebhookEndpoint,
    event: OutboundEvent,
    *,
    seed: str,
    at: datetime | None = None,
    send: Enqueue | None = None,
) -> bool:
    """Log a delivery of `event` to `endpoint` and queue its first attempt.

    A delivery already logged under the same seed is queued again only while it has
    never been attempted, which covers a first run that wrote the row and then failed
    to enqueue; the attempt handler drops the duplicate if both jobs arrive.
    """
    delivery = open_delivery(endpoint, event, delivery_id=new_delivery_id(f"{seed}#{endpoint.webhook_id}", at=at))
    if not repositories.github.create_delivery(delivery):
        existing = repositories.github.get_delivery(endpoint.workspace_id, endpoint.webhook_id, delivery.delivery_id)
        if existing is None or existing.attempts or existing.state != "pending":
            return False
    _queue(endpoint.workspace_id, endpoint.webhook_id, delivery.delivery_id, 1, send=send)
    return True


def _fail(repositories: Repositories, delivery: WebhookDelivery) -> None:
    """Close a delivery as failed."""
    repositories.github.put_delivery(delivery.model_copy(update={"state": "failed", "next_attempt_at": None}))


def _count_failure(repositories: Repositories, endpoint: WebhookEndpoint) -> bool:
    """Add a failed attempt to the endpoint's run and open its breaker at the threshold.

    Returns whether the breaker is now open, so the caller stops retrying at once.
    """
    failures = repositories.github.count_failure(endpoint.workspace_id, endpoint.webhook_id)
    if failures < CIRCUIT_BREAKER_THRESHOLD:
        return False
    if endpoint.active:
        repositories.github.update_endpoint(
            endpoint.workspace_id,
            endpoint.webhook_id,
            active=False,
            disabled_reason=DISABLED_REASON.format(count=failures),
            disabled_at=utc_now().isoformat(),
        )
        _log.warning(
            "Opened a webhook endpoint's circuit breaker after repeated failures.",
            extra={"event": "integrations.webhook.auto_disabled", "failures": failures},
        )
    return True


@dataclass(frozen=True, slots=True)
class _Slot:
    """One leased in-flight slot of a workspace."""

    workspace_id: str
    slot: int
    until: int


def _acquire_slot(repositories: Repositories, workspace_id: str) -> _Slot | None:
    """Lease one of the workspace's in-flight slots, or `None` when all are held."""
    leased = repositories.github.acquire_dispatch_slot(
        workspace_id,
        limit=WORKSPACE_IN_FLIGHT_LIMIT,
        lease_seconds=SLOT_LEASE_SECONDS,
        now_ms=int(time.time() * 1000),
    )
    return _Slot(workspace_id, *leased) if leased is not None else None


def _defer_delay() -> int:
    """A jittered wait for an attempt whose workspace is at its in-flight limit."""
    return DEFER_SECONDS + secrets.randbelow(DEFER_JITTER_SECONDS + 1)


def run_attempt(
    repositories: Repositories,
    job: Mapping[str, Any],
    *,
    sender: WebhookSender | None = None,
    send: Enqueue | None = None,
) -> str:
    """Handle one queued attempt and return what became of the delivery.

    A job for an attempt that is already recorded is dropped, so a queue redelivery
    never posts twice. An endpoint deleted or disabled since the job was queued ends
    the delivery without an attempt, and a workspace at its in-flight limit puts the
    same attempt back on the queue for later.
    """
    workspace_id = str(job.get("workspace_id", ""))
    webhook_id = str(job.get("webhook_id", ""))
    delivery_id = str(job.get("delivery_id", ""))
    number = int(job.get("attempt", 1) or 1)

    endpoint = repositories.github.get_endpoint(workspace_id, webhook_id)
    delivery = repositories.github.get_delivery(workspace_id, webhook_id, delivery_id)
    if endpoint is None or delivery is None:
        return "missing"
    if delivery.state in ("delivered", "failed") or len(delivery.attempts) >= number:
        return "duplicate"
    if not endpoint.active:
        repositories.github.put_delivery(
            delivery.model_copy(update={"state": "failed", "next_attempt_at": None, "updated_at": utc_now()})
        )
        return "skipped"

    slot = _acquire_slot(repositories, workspace_id)
    if slot is None:
        _queue(workspace_id, webhook_id, delivery_id, number, delay=_defer_delay(), send=send)
        return "deferred"
    try:
        updated, response = attempt(endpoint, delivery, sender=sender)
    finally:
        repositories.github.release_dispatch_slot(slot.workspace_id, slot.slot, slot.until)
    _note_status(repositories, endpoint, response)

    if response.delivered:
        repositories.github.put_delivery(updated.model_copy(update={"state": "delivered", "next_attempt_at": None}))
        if endpoint.consecutive_failures:
            repositories.github.update_endpoint(workspace_id, webhook_id, consecutive_failures=0)
        return "delivered"

    if _count_failure(repositories, endpoint):
        _fail(repositories, updated)
        return "failed"

    if retryable(response) and number < MAX_ATTEMPTS:
        delay = BACKOFF_SECONDS[min(number, len(BACKOFF_SECONDS)) - 1]
        retry_at = utc_now() + timedelta(seconds=delay)
        repositories.github.put_delivery(updated.model_copy(update={"state": "retrying", "next_attempt_at": retry_at}))
        _queue(workspace_id, webhook_id, delivery_id, number + 1, delay=delay, send=send)
        return "retrying"

    _fail(repositories, updated)
    return "failed"


def send_now(
    repositories: Repositories,
    endpoint: WebhookEndpoint,
    delivery: WebhookDelivery,
    *,
    sender: WebhookSender | None = None,
) -> WebhookDelivery:
    """Make one attempt at a new delivery from a request and store the outcome.

    Used by the test ping and by redeliver. The failure run is left alone either way.
    """
    updated, response = attempt(endpoint, delivery, sender=sender)
    final = updated.model_copy(update={"state": "delivered" if response.delivered else "failed"})
    repositories.github.put_delivery(final)
    _note_status(repositories, endpoint, response)
    return final


def redelivery(endpoint: WebhookEndpoint, original: WebhookDelivery) -> WebhookDelivery:
    """A new delivery row carrying the original body under a fresh id and timestamp."""
    now = utc_now()
    delivery_id = new_delivery_id(at=now)
    try:
        body = json.loads(original.body)
    except ValueError:
        body = None
    if isinstance(body, dict):
        body["webhookDeliveryId"] = delivery_id
        body["webhookTimestamp"] = int(now.timestamp() * 1000)
        text = canonical(body)
    else:
        text = original.body
    return WebhookDelivery(
        workspace_id=endpoint.workspace_id,
        github_key=delivery_key(endpoint.webhook_id, delivery_id),
        delivery_id=delivery_id,
        webhook_id=endpoint.webhook_id,
        event_type=original.event_type,
        action=original.action,
        is_test=original.is_test,
        redelivery_of=original.delivery_id,
        body=text,
        created_at=now,
        updated_at=now,
        expires_at=int(now.timestamp()) + DELIVERY_RETENTION_SECONDS,
    )


def epoch_to_datetime(value: float) -> datetime:
    """A stream record's approximate creation time as an aware datetime."""
    return datetime.fromtimestamp(value, tz=timezone.utc)
