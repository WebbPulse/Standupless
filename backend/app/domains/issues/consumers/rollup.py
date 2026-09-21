"""The rollup consumer: keeps each parent's `progress` matching its children.

The `issues` table streams `NEW_AND_OLD_IMAGES` into this route. A record matters
only when it changed which parent an issue hangs off, or moved it between a
finished status and an unfinished one, so most records are read and dropped.

It recounts from `ws_parent-created_at-index` rather than incrementing, which is
what makes it idempotent: a record redelivered after a partial batch produces the
same counts rather than double counting. Both the old and the new parent are
recounted, because a move leaves the one it came from wrong as well.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

from fastapi import APIRouter
from webbpulse.events import deserialize_image, register_stream_consumer

from app.common.api.dependencies.repositories import Repositories, build_bundle
from app.domains.issues.service import COMPLETED_CATEGORIES

_log = logging.getLogger(__name__)


def _text(image: Mapping[str, Any], name: str) -> str:
    """One attribute of a stream image as a string, empty when it is absent or null."""
    value = image.get(name)
    return str(value).strip() if value is not None else ""


def parents_to_recount(record: Mapping[str, Any]) -> set[str]:
    """Which parents this record made stale, empty when it changed nothing relevant.

    A create or delete touches the one parent it hangs off. A modify touches both
    when the parent moved, and the new one when the status moved; comparing the
    status ids rather than their categories keeps this from reading the team's
    statuses for every record, and a same-category move only costs a recount that
    lands on the same numbers.
    """
    new_image = deserialize_image(record, "NewImage")
    old_image = deserialize_image(record, "OldImage")

    new_parent = _text(new_image, "parent_id")
    old_parent = _text(old_image, "parent_id")

    stale: set[str] = set()
    if new_parent != old_parent:
        stale.update(parent for parent in (new_parent, old_parent) if parent)
        return stale

    if not new_parent:
        return stale
    if _text(new_image, "status_id") != _text(old_image, "status_id"):
        stale.add(new_parent)
    return stale


def workspace_of(record: Mapping[str, Any]) -> str:
    """The workspace a record belongs to, from whichever image carries it.

    A REMOVE record has no `NewImage`, so the old one is read as the fallback rather
    than the record being skipped: a deleted child still leaves its parent stale.
    """
    for image in ("NewImage", "OldImage"):
        workspace_id = _text(deserialize_image(record, image), "workspace_id")
        if workspace_id:
            return workspace_id
    return ""


def recount(repositories: Any, workspace_id: str, parent_id: str) -> None:
    """Write one parent's counts from the children the index reports right now.

    Nothing is written when the parent is gone: a delete removes the parent before
    its children are reparented, and a recount then has nothing to correct.
    """
    parent = repositories.issues.get(workspace_id, parent_id)
    if parent is None:
        return

    children = repositories.issues.iter_children(workspace_id, parent_id)
    categories = {
        row.status_id: row.category
        for row in repositories.team_config.list_statuses(workspace_id, parent.team_id)
    }
    total = len(children)
    completed = sum(1 for child in children if categories.get(child.status_id) in COMPLETED_CATEGORIES)
    if parent.progress.total == total and parent.progress.completed == completed:
        return
    repositories.issues.set_progress(workspace_id, parent_id, total, completed)


def handle_record(repositories: Repositories, record: Mapping[str, Any]) -> None:
    """Recount every parent one stream record made stale.

    Raising puts this record alone into `batchItemFailures`, so a transient failure
    retries the record rather than the whole batch.
    """
    stale = parents_to_recount(record)
    if not stale:
        return

    workspace_id = workspace_of(record)
    if not workspace_id:
        return

    for parent_id in sorted(stale):
        recount(repositories, workspace_id, parent_id)

    _log.info(
        "Recounted issue progress.",
        extra={"event": "issues.rollup", "workspace_id": workspace_id, "parents": len(stale)},
    )


def build_router(repositories: Repositories | None = None) -> APIRouter:
    """The consumer's router, mounted at the root with no API prefix.

    Unprefixed because the Lambda Web Adapter posts the invocation to its own
    pass-through path, which is not under `/api`. The bundle is closed over rather
    than taken as a FastAPI dependency, because the route is registered by the
    shared package and its signature is not this domain's to extend; passing one in
    is what lets a test drive the consumer against moto's tables.
    """
    from app.common.composition.domains import DOMAINS

    bundle = (
        repositories if repositories is not None else build_bundle(DOMAINS["issues"].all_repositories, name="issues")
    )
    router = APIRouter()

    def consume(record: Mapping[str, Any]) -> None:
        """Handle one record against this domain's bundle."""
        handle_record(bundle, record)

    register_stream_consumer(router, consume, log_event="issues.rollup.batch")
    return router
