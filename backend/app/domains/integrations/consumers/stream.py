"""The stream consumer that turns product writes into outbound work.

Issue, comment, cycle, project and label changes each become a delivery for every
enabled webhook subscribed to that resource type and team. Issue and comment writes
may also queue a job carrying the change to GitHub, for a team whose issues sync
with a repository.

This exists so that the product domains never call the integrations domain. A
synchronous call would make a workspace's webhook configuration a dependency of
creating an issue, which means a slow receiver slows the product and a bug in
delivery fails a write that had already succeeded. Reading the stream inverts that:
the write commits, the stream carries it here, and this decides whether anybody is
subscribed.

Nothing is sent for a workspace that is scheduled for deletion or being purged, or
for a team that is being deleted, so a purge does not announce every row it removes.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Mapping

from fastapi import APIRouter
from webbpulse.dynamodb import table_name
from webbpulse.events import deserialize_image, register_stream_consumer, source_table

from app.common.api.dependencies.repositories import Repositories, build_bundle
from app.common.core.config import settings
from app.common.db.dynamo.github import WebhookEndpoint
from app.common.db.dynamo.planning import CYCLE, PROJECT
from app.domains.integrations.outbound import payloads
from app.domains.integrations.outbound.delivery import epoch_to_datetime, schedule

_log = logging.getLogger(__name__)

LABEL_MARKER = "#label#"
"""What a `team_config` sort key contains when the row is a label."""


def _subscribed(repositories: Repositories, workspace_id: str, resource_type: str) -> list[WebhookEndpoint]:
    """The enabled webhooks in this workspace that want this resource type.

    Checked before anything else, because the common case is a workspace with no
    webhooks at all, and describing a change nobody wants would be pure cost.
    """
    if not workspace_id or not settings.WEBHOOK_DISPATCH_QUEUE_URL:
        return []
    return [
        endpoint
        for endpoint in repositories.github.list_endpoints(workspace_id)
        if endpoint.active and resource_type in endpoint.resource_types
    ]


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


def publish(repositories: Repositories, kind: payloads.Kind, record: Mapping[str, Any]) -> int:
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
    endpoints = _subscribed(repositories, workspace_id, kind.resource_type)
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
    scheduled = 0
    for endpoint in endpoints:
        if endpoint.matches(kind.resource_type, teams) and schedule(repositories, endpoint, event, seed=seed, at=at):
            scheduled += 1
    return scheduled


def _planning_kind(record: Mapping[str, Any]) -> payloads.Kind | None:
    """Whether a planning row is a cycle or a project, which are the two worth sending."""
    image = deserialize_image(record, "NewImage") or deserialize_image(record, "OldImage")
    row_kind = str(image.get("kind", "")) if image else ""
    if row_kind == CYCLE:
        return payloads.CYCLE
    if row_kind == PROJECT:
        return payloads.PROJECT
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


def handle_record(repositories: Repositories, record: Mapping[str, Any]) -> None:
    """Route one record to the handlers for the table it came from."""
    physical = source_table(record)
    prefix = settings.dynamodb_table_prefix

    if physical == table_name("issues", prefix):
        publish(repositories, payloads.ISSUE, record)
        queue_issue_sync(repositories, record)
    elif physical == table_name("comments", prefix):
        publish(repositories, payloads.COMMENT, record)
        queue_comment_sync(repositories, record)
    elif physical == table_name("planning", prefix):
        kind = _planning_kind(record)
        if kind is not None:
            publish(repositories, kind, record)
    elif physical == table_name("team_config", prefix):
        if _is_label(record):
            publish(repositories, payloads.LABEL, record)
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

    def consume(record: Mapping[str, Any]) -> None:
        """Handle one record against this domain's bundle."""
        handle_record(bundle, record)

    register_stream_consumer(router, consume, log_event="integrations.stream.batch")
    return router
