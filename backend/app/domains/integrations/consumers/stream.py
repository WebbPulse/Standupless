"""The stream consumer that turns product writes into outbound work.

Issue, comment, cycle, project, project update, label, document, initiative,
initiative update, customer and customer request changes each become a delivery
for every enabled webhook subscribed to that resource type and team, and issue, comment and
project update changes a message for every team channel that wants them. Issue and
comment writes may also queue a job carrying the change to GitHub, for a team whose
issues sync with a repository, and an issue whose labels changed queues a label
sync for the open pull requests linked to it. An issue moved to another team
carries its GitHub sync row with it.

This exists so that the product domains never call the integrations domain. A
synchronous call would make a workspace's webhook configuration a dependency of
creating an issue, which means a slow receiver slows the product and a bug in
delivery fails a write that had already succeeded. Reading the stream inverts that:
the write commits, the stream carries it here, and this decides whether anybody is
subscribed.

Nothing is sent for a workspace that is scheduled for deletion or being purged, or
for a team that is being deleted, so a purge does not announce every row it removes.

A document is heard through its summary row and a customer request through its
copy under the issue or project it names. A document moved to another parent and
a request moved to another target are each written as a new row and the removal
of the old one, and the pair is sent as one update: the new row is skipped, and
the removal is described against the row that replaced it.

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

from app.common.api.dependencies.repositories import Repositories
from app.common.bulk_import import from_bulk_import
from app.common.composition.consumers import CONSUMERS
from app.common.core.config import settings
from app.common.db.dynamo.customers import CUSTOMER, CUSTOMER_TARGET, CustomerRequest
from app.common.db.dynamo.documents import DOCUMENT
from app.common.db.dynamo.github import WebhookEndpoint
from app.common.db.dynamo.planning import CYCLE, INITIATIVE, INITIATIVE_UPDATE, PROJECT, PROJECT_UPDATE
from app.common.db.dynamo.team_config import WORKSPACE_LABEL_PREFIX
from app.common.team_privacy import destination_can_carry
from app.common.trash_stream import live_view, touches_trash
from app.domains.integrations.channels import events as channel_events
from app.domains.integrations.channels.events import DestinationCache
from app.domains.integrations.outbound import payloads
from app.domains.integrations.outbound.delivery import epoch_to_datetime, schedule

_log = logging.getLogger(__name__)

_GRANT = CONSUMERS["integrations-stream-consumer"]
"""The tables this consumer's function is granted, which every record is handled within."""

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


type Change = tuple[str, Mapping[str, Any], Mapping[str, Any]]
"""One row change as its stream event name, new image and old image."""

type Resolver = Callable[[Repositories, Change], Change | None]
"""Turn the half of a two row write into the change it stands for, or `None` to send nothing."""


def publish(
    repositories: Repositories,
    kind: payloads.Kind,
    record: Mapping[str, Any],
    cache: EndpointCache | None = None,
    resolve: Resolver | None = None,
) -> int:
    """Schedule a delivery of one row change to every webhook that wants it.

    Returns how many deliveries were scheduled. The delivery ids are derived from
    the stream record, so a batch the stream hands over twice schedules nothing new.
    `resolve`, when given, runs only once some webhook wants the type, so the
    reads it makes cost nothing in a workspace without one.
    """
    new_image: Mapping[str, Any] = deserialize_image(record, "NewImage")
    old_image: Mapping[str, Any] = deserialize_image(record, "OldImage")
    image = new_image or old_image
    if not image:
        return 0
    workspace_id = str(image.get("workspace_id", ""))
    endpoints = _subscribed(repositories, workspace_id, kind.resource_type, cache)
    if not endpoints:
        return 0
    event_name = str(record.get("eventName", ""))
    if resolve is not None:
        change = resolve(repositories, (event_name, new_image, old_image))
        if change is None:
            return 0
        event_name, new_image, old_image = change
    event = payloads.describe(repositories, kind, event_name, new_image, old_image)
    if event is None:
        return 0
    teams = _live_teams(repositories, workspace_id, event.team_ids)
    if teams is None:
        return 0

    stream = record.get("dynamodb")
    created = stream.get("ApproximateCreationDateTime") if isinstance(stream, Mapping) else None
    at = epoch_to_datetime(float(created)) if isinstance(created, (int, float, str)) and created else None
    seed = str(record.get("eventID") or uuid.uuid4().hex)
    private = set(repositories.memberships.list_private_team_ids(workspace_id)) if teams else set()
    private_only = _private_only(teams, private)
    scheduled = 0
    for endpoint in endpoints:
        if endpoint.team_id is None and private_only:
            continue
        if endpoint.team_id is not None and not destination_can_carry(
            repositories, workspace_id, endpoint.team_id, endpoint.created_by, private
        ):
            continue
        if endpoint.matches(kind.resource_type, teams) and schedule(repositories, endpoint, event, seed=seed, at=at):
            scheduled += 1
    return scheduled


def _private_only(team_ids: tuple[str, ...], private: set[str]) -> bool:
    """Whether every team an event is about is private, so a workspace-wide webhook skips it.

    A private team's events reach only a webhook scoped to that team, and only while
    the webhook's creator can still read the team. An event about no team, or about
    at least one open team, still goes to the workspace-wide webhooks.
    """
    if not team_ids:
        return False
    return all(team_id in private for team_id in team_ids)


PLANNING_KINDS: dict[str, payloads.Kind] = {
    CYCLE: payloads.CYCLE,
    PROJECT: payloads.PROJECT,
    PROJECT_UPDATE: payloads.PROJECT_UPDATE,
    DOCUMENT: payloads.DOCUMENT,
    INITIATIVE: payloads.INITIATIVE,
    INITIATIVE_UPDATE: payloads.INITIATIVE_UPDATE,
    CUSTOMER: payloads.CUSTOMER,
    CUSTOMER_TARGET: payloads.CUSTOMER_REQUEST,
}
"""The planning row kinds worth sending, by the type each is sent as.

A customer request is heard through its target copy alone, so each change sends
once, and a merge of two customers, which rewrites that copy in place, reads as
an update rather than a removal and a creation.
"""


def _planning_kind(record: Mapping[str, Any]) -> payloads.Kind | None:
    """The type a planning row is sent as, or `None` for a row no webhook hears."""
    image = deserialize_image(record, "NewImage") or deserialize_image(record, "OldImage")
    return PLANNING_KINDS.get(str(image.get("kind", ""))) if image else None


def resolve_document(repositories: Repositories, change: Change) -> Change | None:
    """Fold a document move's two summary writes into one update.

    A move writes the summary under the new parent and then removes the old one,
    and every other write keeps one summary row. The new row is told apart by a
    creation time older than its update, since a new document starts with the two
    equal. The removal is a move while the body row still stands under another
    parent, and is then described against the summary that replaced it.
    """
    event_name, new_image, old_image = change
    if event_name == "INSERT":
        return None if new_image.get("created_at") != new_image.get("updated_at") else change
    if event_name != "REMOVE":
        return change
    workspace_id = str(old_image.get("workspace_id", ""))
    document_id = str(old_image.get("document_id", ""))
    body = repositories.documents.get_body(workspace_id, document_id)
    if body is None or (body.parent_kind, body.parent_id) == (old_image.get("parent_kind"), old_image.get("parent_id")):
        return change
    moved = repositories.documents.get_summary(workspace_id, body.parent_kind, body.parent_id, document_id)
    if moved is None:
        return change
    return "MODIFY", moved.model_dump(mode="json"), old_image


def _surviving_request(repositories: Repositories, old_image: Mapping[str, Any]) -> CustomerRequest | None:
    """The request a removed target copy belonged to, when the request itself still stands.

    It is looked for under its old customer first, which finds every move to
    another target. A customer that is gone took its requests with it. Only a
    request moved to another customer and another target in one edit needs the
    workspace's request list.
    """
    workspace_id = str(old_image.get("workspace_id", ""))
    customer_id = str(old_image.get("customer_id", ""))
    request_id = str(old_image.get("request_id", ""))
    found = repositories.customers.get_request(workspace_id, customer_id, request_id)
    if found is not None or repositories.customers.get(workspace_id, customer_id) is None:
        return found
    return next(
        (row for row in repositories.customers.list_requests(workspace_id) if row.request_id == request_id), None
    )


def resolve_customer_request(repositories: Repositories, change: Change) -> Change | None:
    """Fold a request's move to another issue or project into one update.

    The move writes a target copy under the new target and removes the old one.
    The new copy is told apart by its update time, which a new request does not
    have yet, and the removal is a move while the request still stands, described
    against the request as it now reads.
    """
    event_name, new_image, old_image = change
    if event_name == "INSERT":
        return None if new_image.get("updated_at") else change
    if event_name != "REMOVE":
        return change
    surviving = _surviving_request(repositories, old_image)
    if surviving is None:
        return change
    return "MODIFY", surviving.as_target_copy().model_dump(mode="json"), old_image


RESOLVERS: dict[str, Resolver] = {
    payloads.DOCUMENT.resource_type: resolve_document,
    payloads.CUSTOMER_REQUEST.resource_type: resolve_customer_request,
}
"""The types whose one change can arrive as two row writes."""


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


def rehome_issue_sync(repositories: Repositories, record: Mapping[str, Any]) -> bool:
    """Carry a moved issue's GitHub sync row to its new team, answering whether it moved.

    The row is keyed by the issue id, so only its `team_id` goes stale on a move,
    and that is what the team's sync listings filter on.
    """
    new_image = deserialize_image(record, "NewImage")
    old_image = deserialize_image(record, "OldImage")
    if not new_image or not old_image:
        return False
    team_id = str(new_image.get("team_id", ""))
    if not team_id or str(old_image.get("team_id", "")) == team_id:
        return False
    return repositories.github.rehome_issue_sync(
        str(new_image.get("workspace_id", "")), str(new_image.get("issue_id", "")), team_id
    )


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
    """Queue a GitHub sync job for a new comment, an edited body, or a thread newly synced.

    One job serves the two way issue sync and a synced thread alike. A change to
    only the link of a thread's opening comment queues nothing, since that is the
    App's own post landing.
    """
    from app.domains.integrations.issue_sync import enqueue_comment_sync

    if record.get("eventName") not in ("INSERT", "MODIFY"):
        return False
    new_image = deserialize_image(record, "NewImage")
    old_image = deserialize_image(record, "OldImage")
    if not new_image:
        return False
    body_changed = not old_image or old_image.get("body") != new_image.get("body")
    workspace_id = str(new_image.get("workspace_id", ""))
    issue_id = str(new_image.get("issue_id", ""))
    wanted = body_changed and _team_writes_back(repositories, workspace_id, str(new_image.get("team_id", "")))
    if not wanted:
        wanted = _thread_changed(repositories, old_image, new_image, body_changed)
    if not wanted:
        return False
    enqueue_comment_sync(workspace_id, issue_id, str(new_image.get("comment_id", "")))
    return True


def _thread_identity(image: Mapping[str, Any] | None) -> tuple[str, int, str] | None:
    """Which synced thread a comment image names, ignoring the link of its opening comment."""
    thread = (image or {}).get("github_thread")
    if not isinstance(thread, Mapping):
        return None
    return str(thread.get("repository_id", "")), int(thread.get("number") or 0), str(thread.get("synced_at", ""))


def _thread_changed(
    repositories: Repositories,
    old_image: Mapping[str, Any] | None,
    new_image: Mapping[str, Any],
    body_changed: bool,
) -> bool:
    """Whether a comment record has something for a synced thread to post."""
    identity = _thread_identity(new_image)
    if identity is not None:
        return body_changed or identity != _thread_identity(old_image)
    parent_id = str(new_image.get("parent_comment_id") or "")
    if not body_changed or not parent_id or str(new_image.get("source") or "") == "github":
        return False
    parent = repositories.comments.get(
        str(new_image.get("workspace_id", "")), str(new_image.get("issue_id", "")), parent_id
    )
    return parent is not None and parent.github_thread is not None


def queue_label_sync(repositories: Repositories, record: Mapping[str, Any]) -> int:
    """Queue a repository label reconcile for every team that syncs labels, when a label definition moved.

    Every syncing team is queued rather than only the label's own, because a
    workspace or parent team label reaches every team that inherits it, and a
    reconcile with nothing to do makes no write. A workspace label also queues
    the workspace label set push, when the workspace has it on, and a label whose
    GitHub name moved queues a sweep of the pull requests the App labelled.
    """
    from app.domains.integrations.label_set import queue_on_change
    from app.domains.integrations.label_sync import definition_changed, queue_for_workspace
    from app.domains.integrations.pr_labels import github_name_moved, queue_sweep

    new_image = deserialize_image(record, "NewImage")
    old_image = deserialize_image(record, "OldImage")
    if not settings.WEBHOOK_DISPATCH_QUEUE_URL or not definition_changed(old_image, new_image):
        return 0
    image = new_image or old_image
    workspace_id = str(image.get("workspace_id", ""))
    queued = queue_for_workspace(repositories, workspace_id)
    if str(image.get("config_key", "")).startswith(WORKSPACE_LABEL_PREFIX) and queue_on_change(
        repositories, workspace_id
    ):
        queued += 1
    if github_name_moved(old_image, new_image) and queue_sweep(repositories, workspace_id):
        queued += 1
    return queued


def handle_record(
    repositories: Repositories,
    record: Mapping[str, Any],
    cache: EndpointCache | None = None,
    channel_cache: DestinationCache | None = None,
) -> None:
    """Route one record to the handlers for the table it came from.

    An issue row a bulk import wrote is carried along on a team move but sends
    no webhook, channel message or GitHub sync, and neither does an imported
    comment or planning row. A move into the trash sends a remove webhook and a
    restore a create one, and neither touches GitHub or a channel.
    """
    repositories = _GRANT.narrow(repositories)
    physical = source_table(record)
    prefix = settings.dynamodb_table_prefix

    if physical == table_name("issues", prefix):
        if touches_trash(record):
            seen = live_view(record)
            if seen is not None:
                publish(repositories, payloads.ISSUE, seen, cache)
            return
        rehome_issue_sync(repositories, record)
        if from_bulk_import(record):
            return
        publish(repositories, payloads.ISSUE, record, cache)
        queue_issue_sync(repositories, record)
        queue_pr_labels(repositories, record)
        channel_events.on_issue(repositories, record, channel_cache)
    elif physical == table_name("comments", prefix):
        if from_bulk_import(record) or _on_document(record):
            return
        publish(repositories, payloads.COMMENT, record, cache)
        queue_comment_sync(repositories, record)
        channel_events.on_comment(repositories, record, channel_cache)
    elif physical == table_name("planning", prefix):
        if from_bulk_import(record):
            return
        kind = _planning_kind(record)
        if kind is not None:
            publish(repositories, kind, record, cache, RESOLVERS.get(kind.resource_type))
        if kind is payloads.PROJECT_UPDATE:
            channel_events.on_planning(repositories, record, channel_cache)
    elif physical == table_name("team_config", prefix):
        if _is_label(record):
            publish(repositories, payloads.LABEL, record, cache)
            queue_label_sync(repositories, record)
    else:
        _log.warning(
            "Ignored a stream record from an unexpected table.",
            extra={"event": "integrations.stream.unknown_source", "table": physical},
        )


def _on_document(record: Mapping[str, Any]) -> bool:
    """Whether a `comments` record is on a document, which has no webhook, GitHub mirror or channel post."""
    image = deserialize_image(record, "NewImage") or deserialize_image(record, "OldImage") or {}
    return bool(image.get("document_id"))


def build_router(repositories: Repositories | None = None) -> APIRouter:
    """The outbound stream consumer's router, mounted at the root."""
    bundle = repositories if repositories is not None else _GRANT.bundle()
    router = APIRouter()
    cache = EndpointCache()
    channel_cache = DestinationCache()

    def consume(record: Mapping[str, Any]) -> None:
        """Handle one record against this domain's bundle."""
        handle_record(bundle, record, cache, channel_cache)

    register_stream_consumer(router, consume, log_event="integrations.stream.batch")
    return router
