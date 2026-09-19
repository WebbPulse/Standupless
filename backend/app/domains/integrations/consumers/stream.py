"""The stream consumer that turns issue and comment writes into outbound webhooks.

This exists so that the issues and discussion domains never call the integrations
domain. A synchronous call would make a workspace's webhook configuration a
dependency of creating an issue, which means a slow endpoint slows the product and
a bug in dispatch fails a write that had already succeeded.

Reading the stream inverts that. The write commits, the stream carries it here, and
this decides whether anybody subscribed. Nothing upstream knows integrations exist.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

from fastapi import APIRouter
from webbpulse.dynamodb import table_name
from webbpulse.events import EventEnvelope, deserialize_image, enqueue, register_stream_consumer, source_table

from app.common.api.dependencies.repositories import Repositories, build_bundle
from app.common.core.config import settings

_log = logging.getLogger(__name__)

ISSUE_FIELDS = ("title", "body", "status_id", "priority", "assignee_id", "label_ids", "due_date", "parent_id")
"""The issue fields whose change is worth an `issue.updated`.

A change to anything else, notably the rollup counters the issues consumer writes,
is machinery rather than news and would deliver a webhook per child status change.
"""


def _queue_ready(repositories: Repositories, workspace_id: str, event: str) -> bool:
    """Whether any enabled endpoint in this workspace wants this event.

    Checked before enqueueing rather than in the dispatcher, because the common case
    is a workspace with no endpoints at all and a queue round trip per issue write
    would be pure cost for every one of them.
    """
    if not workspace_id or not settings.WEBHOOK_DISPATCH_QUEUE_URL:
        return False
    endpoints = repositories.github.list_endpoints(workspace_id)
    return any(endpoint.active and event in endpoint.events for endpoint in endpoints)


def _emit(repositories: Repositories, workspace_id: str, event: str, payload: Mapping[str, Any]) -> bool:
    """Queue one outbound event when somebody is subscribed to it."""
    if not _queue_ready(repositories, workspace_id, event):
        return False
    enqueue(
        settings.WEBHOOK_DISPATCH_QUEUE_URL,
        EventEnvelope(
            name=event,
            payload={"kind": "webhook.deliver", "workspace_id": workspace_id, "event": event, "payload": dict(payload)},
            scope=workspace_id,
        ),
    )
    return True


def _issue_payload(image: Mapping[str, Any]) -> dict[str, Any]:
    """The public shape of an issue in an outbound webhook.

    Deliberately a subset. A webhook body is sent to somebody else's server, so it
    carries what identifies the issue and what changed, not the whole row.
    """
    return {
        "issue_id": str(image.get("issue_id", "")),
        "workspace_id": str(image.get("workspace_id", "")),
        "project_id": str(image.get("project_id", "")),
        "key": str(image.get("key", "")),
        "title": str(image.get("title", "")),
        "status_id": str(image.get("status_id", "")),
        "priority": str(image.get("priority", "none")),
        "assignee_id": image.get("assignee_id"),
        "updated_at": str(image.get("updated_at", "")),
    }


def handle_issue_record(repositories: Repositories, record: Mapping[str, Any]) -> bool:
    """Emit `issue.created`, `issue.updated` or `issue.status_changed`.

    A status change emits both `issue.status_changed` and `issue.updated`, because a
    receiver subscribed only to the general event should still hear about the most
    consequential change an issue can have.
    """
    new_image = deserialize_image(record, "NewImage")
    old_image = deserialize_image(record, "OldImage")
    if not new_image:
        return False

    workspace_id = str(new_image.get("workspace_id", ""))
    payload = _issue_payload(new_image)
    emitted = False

    if not old_image:
        return _emit(repositories, workspace_id, "issue.created", payload)

    previous = str(old_image.get("status_id", ""))
    current = str(new_image.get("status_id", ""))
    if previous and previous != current:
        emitted |= _emit(
            repositories,
            workspace_id,
            "issue.status_changed",
            {**payload, "previous_status_id": previous},
        )

    if any(old_image.get(field) != new_image.get(field) for field in ISSUE_FIELDS):
        emitted |= _emit(repositories, workspace_id, "issue.updated", payload)

    return emitted


def handle_comment_record(repositories: Repositories, record: Mapping[str, Any]) -> bool:
    """Emit `comment.created` for a new comment, and nothing for an edit.

    An edit is deliberately silent: the contract names four outbound events and a
    comment edit is not one of them.
    """
    if record.get("eventName") != "INSERT":
        return False
    new_image = deserialize_image(record, "NewImage")
    if not new_image:
        return False

    workspace_id = str(new_image.get("workspace_id", ""))
    return _emit(
        repositories,
        workspace_id,
        "comment.created",
        {
            "comment_id": str(new_image.get("comment_id", "")),
            "workspace_id": workspace_id,
            "issue_id": str(new_image.get("issue_id", "")),
            "author_id": str(new_image.get("author_id", "")),
            "body": str(new_image.get("body", "")),
            "created_at": str(new_image.get("created_at", "")),
        },
    )


def handle_record(repositories: Repositories, record: Mapping[str, Any]) -> None:
    """Route one record to the handler for the table it came from."""
    physical = source_table(record)
    prefix = settings.dynamodb_table_prefix

    if physical == table_name("issues", prefix):
        handle_issue_record(repositories, record)
    elif physical == table_name("comments", prefix):
        handle_comment_record(repositories, record)
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
