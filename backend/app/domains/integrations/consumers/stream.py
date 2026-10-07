"""The stream consumer that turns product writes into outbound work.

Issue, comment, cycle, project and label changes each become a delivery for every
enabled webhook subscribed to that resource type and team. Issue and comment writes
may also queue a job carrying the change to GitHub, for a team whose issues sync
with a repository, and an issue whose labels changed queues a label sync for the
open pull requests linked to it.

This exists so that the product domains never call the integrations domain. A
synchronous call would make a workspace's webhook configuration a dependency of
creating an issue, which means a slow receiver slows the product and a bug in
delivery fails a write that had already succeeded. Reading the stream inverts that:
the write commits, the stream carries it here, and this decides whether anybody is
subscribed.

Nothing is sent for a workspace that is scheduled for deletion or being purged, or
for a team that is being deleted, so a purge does not announce every row it removes.

A workspace's endpoint list is remembered for `ENDPOINT_CACHE_SECONDS` inside one
consumer process. A stream batch holds up to 100 records and most of them come from
a handful of busy workspaces, so the list Query runs once per workspace per batch
rather than once per record, and a workspace with no webhooks costs one Query per
batch however much it writes.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any, Callable, Mapping

from fastapi import APIRouter
from webbpulse.dynamodb import table_name
from webbpulse.events import deserialize_image, register_stream_consumer, source_table

from app.common.api.dependencies.repositories import Repositories, build_bundle
from app.common.core.config import settings
from app.common.db.dynamo.github import WebhookEndpoint
from app.common.db.dynamo.planning import CYCLE, PROJECT, PROJECT_UPDATE
from app.domains.integrations.outbound import payloads
from app.domains.integrations.outbound.delivery import epoch_to_datetime, schedule

_log = logging.getLogger(__name__)

LABEL_MARKER = "#label#"
"""What a `team_config` sort key contains when the row is a label."""

ENDPOINT_CACHE_SECONDS = 5.0
"""How long one process reuses a workspace's endpoint list, the length of a stream batching window."""

ENDPOINT_CACHE_SIZE = 1024
"""How many workspaces one process remembers before it starts over."""


class EndpointCache:
    """A short lived, per process memory of each workspace's webhook endpoints.

    An endpoint created moments ago can miss a change written within the same few
    seconds, which is the same window the stream's batching already adds. A disabled
    or deleted endpoint that is still remembered costs a delivery row and a queued
    job, and the attempt handler ends that job without a request.
    """

    def __init__(self, *, ttl: float = ENDPOINT_CACHE_SECONDS, clock: Callable[[], float] = time.monotonic) -> None:
        """Start empty, with an injectable clock for tests."""
        self._ttl = ttl
        self._clock = clock
        self._entries: dict[str, tuple[float, list[WebhookEndpoint]]] = {}

    def endpoints(self, repositories: Repositories, workspace_id: str) -> list[WebhookEndpoint]:
        """The workspace's endpoints, read at most once per `ttl`."""
        now = self._clock()
        cached = self._entries.get(workspace_id)
        if cached is not None and now - cached[0] < self._ttl:
            return cached[1]
        rows = repositories.github.list_endpoints(workspace_id, consistent=False)
        if len(self._entries) >= ENDPOINT_CACHE_SIZE:
            self._entries.clear()
        self._entries[workspace_id] = (now, rows)
        return rows


def _subscribed(
    repositories: Repositories, workspace_id: str, resource_type: str, cache: EndpointCache | None = None
) -> list[WebhookEndpoint]:
    """The enabled webhooks in this workspace that want this resource type.

    Checked before anything else, because the common case is a workspace with no
    webhooks at all, and describing a change nobody wants would be pure cost.
    """
    if not workspace_id or not settings.WEBHOOK_DISPATCH_QUEUE_URL:
        return []
    rows = (
        cache.endpoints(repositories, workspace_id)
        if cache is not None
        else repositories.github.list_endpoints(workspace_id)
    )
    return [endpoint for endpoint in rows if endpoint.active and resource_type in endpoint.resource_types]


def _live_teams(repositories: Repositories, workspace_id: str, team_ids: tuple[str, ...]) -> tuple[str, ...] | None:
    """The event's teams that are not being deleted, or `None` when it should not be sent.

    `None` covers a workspace that is gone, scheduled for deletion or purging, and
    an event whose every team is being deleted.
    """
    workspace = repositories.workspaces.get(workspace_id)
    if workspace is None or workspace.deletion_scheduled_at is not None or workspace.purging_at is not None:
        return None
    live = tuple(team_id for team_id in team_ids if not repositories.teams.is_deleting(workspace_id, team_id))
    if team_ids and not live:
        return None
    return live


def publish(
    repositories: Repositories, kind: payloads.Kind, record: Mapping[str, Any], cache: EndpointCache | None = None
) -> int:
    """Schedule a delivery of one row change to every webhook that wants it.

    Returns how many deliveries were scheduled. The delivery ids are derived from
    the stream record, so a batch the stream hands over twice schedules nothing new.
    """
    new_image = deserialize_image(record, "NewImage")
    old_image = deserialize_image(record, "OldImage")
    image = new_image or old_image
    if not image:
        return 0
    workspace_id = str(image.get("workspace_id", ""))
    endpoints = _subscribed(repositories, workspace_id, kind.resource_type, cache)
    if not endpoints:
        return 0
    event = payloads.describe(repositories, kind, str(record.get("eventName", "")), new_image, old_image)
    if event is None:
        return 0
    teams = _live_teams(repositories, workspace_id, event.team_ids)
    if teams is None:
        return 0

    stream = record.get("dynamodb")
    created = stream.get("ApproximateCreationDateTime") if isinstance(stream, Mapping) else None
    at = epoch_to_datetime(float(created)) if isinstance(created, (int, float, str)) and created else None
    seed = str(record.get("eventID") or uuid.uuid4().hex)
    private_only = _private_only(repositories, workspace_id, teams)
    scheduled = 0
    for endpoint in endpoints:
        if endpoint.team_id is None and private_only:
            continue
        if endpoint.matches(kind.resource_type, teams) and schedule(repositories, endpoint, event, seed=seed, at=at):
            scheduled += 1
    return scheduled


def _private_only(repositories: Repositories, workspace_id: str, team_ids: tuple[str, ...]) -> bool:
    """Whether every team an event is about is private, so a workspace-wide webhook skips it.

    A private team's events reach only a webhook scoped to that team, which only
    someone administering the team could have created. An event about no team, or
    about at least one open team, still goes to the workspace-wide webhooks.
    """
    if not team_ids:
        return False
    private = set(repositories.memberships.list_private_team_ids(workspace_id))
    return all(team_id in private for team_id in team_ids)


def _planning_kind(record: Mapping[str, Any]) -> payloads.Kind | None:
    """Whether a planning row is a cycle, a project or a project update, the three worth sending."""
    image = deserialize_image(record, "NewImage") or deserialize_image(record, "OldImage")
    row_kind = str(image.get("kind", "")) if image else ""
    if row_kind == CYCLE:
        return payloads.CYCLE
    if row_kind == PROJECT:
        return payloads.PROJECT
    if row_kind == PROJECT_UPDATE:
        return payloads.PROJECT_UPDATE
    return None


def _is_label(record: Mapping[str, Any]) -> bool:
    """Whether a team configuration row is a label rather than a status or setting."""
    image = deserialize_image(record, "NewImage") or deserialize_image(record, "OldImage")
    return bool(image) and LABEL_MARKER in str(image.get("config_key", ""))


def _team_writes_back(repositories: Repositories, workspace_id: str, team_id: str) -> bool:
    """Whether this team's issues are carried back to a linked GitHub repository."""
    if not workspace_id or not team_id or not settings.WEBHOOK_DISPATCH_QUEUE_URL:
        return False
    config = repositories.github.get_team_sync(workspace_id, team_id)
    return config is not None and config.writes_back


def queue_issue_sync(repositories: Repositories, record: Mapping[str, Any]) -> bool:
    """Queue a GitHub sync job for a new issue or one whose synced fields moved.

    Whether the change is new to GitHub is decided in the job against the sync
    snapshot, so a write the inbound half made queues a job that makes no call.
    """
    from app.domains.integrations.issue_sync import SYNCED_ISSUE_FIELDS, enqueue_issue_sync

    new_image = deserialize_image(record, "NewImage")
    old_image = deserialize_image(record, "OldImage")
    if not new_image:
        return False
    if old_image and not any(old_image.get(field) != new_image.get(field) for field in SYNCED_ISSUE_FIELDS):
        return False
    workspace_id = str(new_image.get("workspace_id", ""))
    if not _team_writes_back(repositories, workspace_id, str(new_image.get("team_id", ""))):
        return False
    enqueue_issue_sync(workspace_id, str(new_image.get("issue_id", "")), created=not old_image)
    return True


def queue_pr_labels(repositories: Repositories, record: Mapping[str, Any]) -> int:
    """Queue a label sync for the open pull requests linked to an issue whose labels changed."""
    from app.domains.integrations.pr_labels import after_issue_labels

    new_image = deserialize_image(record, "NewImage")
    old_image = deserialize_image(record, "OldImage")
    if not new_image or not old_image:
        return 0
    if sorted(old_image.get("label_ids") or []) == sorted(new_image.get("label_ids") or []):
        return 0
    return after_issue_labels(
        repositories,
        str(new_image.get("workspace_id", "")),
        str(new_image.get("issue_id", "")),
        str(new_image.get("team_id", "")),
    )


def queue_comment_sync(repositories: Repositories, record: Mapping[str, Any]) -> bool:
    """Queue a GitHub sync job for a new comment or an edited body."""
    from app.domains.integrations.issue_sync import enqueue_comment_sync

    if record.get("eventName") not in ("INSERT", "MODIFY"):
        return False
    new_image = deserialize_image(record, "NewImage")
    old_image = deserialize_image(record, "OldImage")
    if not new_image or (old_image and old_image.get("body") == new_image.get("body")):
        return False
    workspace_id = str(new_image.get("workspace_id", ""))
    if not _team_writes_back(repositories, workspace_id, str(new_image.get("team_id", ""))):
        return False
    enqueue_comment_sync(workspace_id, str(new_image.get("issue_id", "")), str(new_image.get("comment_id", "")))
    return True


def handle_record(repositories: Repositories, record: Mapping[str, Any], cache: EndpointCache | None = None) -> None:
    """Route one record to the handlers for the table it came from."""
    physical = source_table(record)
    prefix = settings.dynamodb_table_prefix

    if physical == table_name("issues", prefix):
        publish(repositories, payloads.ISSUE, record, cache)
        queue_issue_sync(repositories, record)
        queue_pr_labels(repositories, record)
    elif physical == table_name("comments", prefix):
        publish(repositories, payloads.COMMENT, record, cache)
        queue_comment_sync(repositories, record)
    elif physical == table_name("planning", prefix):
        kind = _planning_kind(record)
        if kind is not None:
            publish(repositories, kind, record, cache)
    elif physical == table_name("team_config", prefix):
        if _is_label(record):
            publish(repositories, payloads.LABEL, record, cache)
    else:
        _log.warning(
            "Ignored a stream record from an unexpected table.",
            extra={"event": "integrations.stream.unknown_source", "table": physical},
        )


def build_router(repositories: Repositories | None = None) -> APIRouter:
    """The outbound stream consumer's router, mounted at the root."""
    from app.common.composition.domains import DOMAINS

    bundle = (
        repositories
        if repositories is not None
        else build_bundle(DOMAINS["integrations"].all_repositories, name="integrations")
    )
    router = APIRouter()
    cache = EndpointCache()

    def consume(record: Mapping[str, Any]) -> None:
        """Handle one record against this domain's bundle."""
        handle_record(bundle, record, cache)

    register_stream_consumer(router, consume, log_event="integrations.stream.batch")
    return router
