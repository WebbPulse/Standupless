"""The planning rollup consumer: keeps each cycle's and project's counts current.

The `issues` table streams `NEW_AND_OLD_IMAGES` into this route. A record matters
only when it moved an issue between cycles or projects, or moved it between
status categories while attached to one, so most records are read and dropped.

Counts move through an atomic `ADD` rather than a recount, because a recount would
need a query per planning row on every status change and there is no index from a
cycle back to its issues. `ADD` is not idempotent, so each record claims its own
`eventID` in the `idempotency` table first: a record redelivered after a partial
batch failure finds its claim taken and does nothing, which is what keeps a retry
from double counting.

Nothing here writes to the `issues` table. The counters live on the planning row
and the issue's own attributes are the consumer's input, never its output, which is
what keeps this off the second write path the design forbids.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

from fastapi import APIRouter
from webbpulse.events import deserialize_image, record_id, register_stream_consumer

from app.common.api.dependencies.repositories import Repositories, build_bundle
from app.common.db.dynamo.planning import (
    CATEGORY_BUCKETS,
    cycle_key,
    project_key,
)

_log = logging.getLogger(__name__)

IDEMPOTENCY_SCOPE = "planning-rollup"
"""What a claim in the shared `idempotency` table is namespaced under."""

CLAIM_TTL_SECONDS = 24 * 60 * 60
"""How long a consumed record's claim is remembered.

Comfortably longer than a stream's own 24 hour retention would let a record be
redelivered for, so a claim never expires while the record it guards can still
arrive again.
"""


def _text(image: Mapping[str, Any], name: str) -> str:
    """One attribute of a stream image as a string, empty when it is absent or null."""
    value = image.get(name)
    return str(value).strip() if value is not None else ""


def _bucket(repositories: Repositories, workspace_id: str, team_id: str, status_id: str) -> str | None:
    """Which count bucket one status of one team folds into, or `None`.

    Read through the team's own statuses because a category is a team setting
    rather than something the issue row carries, and an unknown status counts into
    nothing rather than into a default bucket that would then be wrong.
    """
    if not status_id:
        return None
    row = repositories.team_config.get_status(workspace_id, team_id, status_id)
    if row is None:
        return None
    return CATEGORY_BUCKETS.get(row.category)


def _attachments(image: Mapping[str, Any]) -> list[tuple[str, str]]:
    """The planning rows one image is attached to, as `(kind, id)` pairs."""
    pairs: list[tuple[str, str]] = []
    cycle_id = _text(image, "cycle_id")
    if cycle_id:
        pairs.append(("cycle", cycle_id))
    project_id = _text(image, "project_id")
    if project_id:
        pairs.append(("project", project_id))
    return pairs


def _planning_key(kind: str, team_id: str, entity_id: str) -> str:
    """The sort key of the planning row one attachment names."""
    if kind == "cycle":
        return cycle_key(team_id, entity_id)
    return project_key(team_id, entity_id)


def deltas_for(
    repositories: Repositories,
    workspace_id: str,
    record: Mapping[str, Any],
) -> dict[str, dict[str, int]]:
    """Every counter move one record implies, keyed by planning sort key.

    Built by subtracting the old image's contribution from the new one's, so an
    issue that changed neither attachment nor category produces an empty result and
    one that moved between cycles decrements the cycle it left in the same pass that
    increments the one it joined.
    """
    removed = str(record.get("eventName", "")).upper() == "REMOVE"
    new_image = {} if removed else deserialize_image(record, "NewImage")
    old_image = deserialize_image(record, "OldImage")

    moves: dict[str, dict[str, int]] = {}

    for image, sign in ((old_image, -1), (new_image, 1)):
        team_id = _text(image, "team_id")
        if not team_id:
            continue
        bucket = _bucket(repositories, workspace_id, team_id, _text(image, "status_id"))
        if bucket is None:
            continue
        for kind, entity_id in _attachments(image):
            key = _planning_key(kind, team_id, entity_id)
            counts = moves.setdefault(key, {})
            counts[bucket] = counts.get(bucket, 0) + sign

    return {key: {bucket: delta for bucket, delta in counts.items() if delta} for key, counts in moves.items()}


def workspace_of(record: Mapping[str, Any]) -> str:
    """The workspace a record belongs to, from whichever image carries it.

    A REMOVE record has no `NewImage`, so the old one is read as the fallback rather
    than the record being skipped: a deleted issue still has to leave its cycle's
    counts.
    """
    for image in ("NewImage", "OldImage"):
        workspace_id = _text(deserialize_image(record, image), "workspace_id")
        if workspace_id:
            return workspace_id
    return ""


def handle_record(repositories: Repositories, record: Mapping[str, Any]) -> None:
    """Move every counter one stream record made stale, once.

    Raising puts this record alone into `batchItemFailures`, so a transient failure
    retries the record rather than the whole batch. The claim is released when no
    counter moved, so a record whose work was skipped does not hold a key that a
    genuine redelivery would then find taken.
    """
    workspace_id = workspace_of(record)
    if not workspace_id:
        return

    moves = deltas_for(repositories, workspace_id, record)
    if not moves:
        return

    event_id = record_id(record)
    if not event_id:
        return
    if not repositories.idempotency.claim(
        workspace_id,
        IDEMPOTENCY_SCOPE,
        event_id,
        ttl_seconds=CLAIM_TTL_SECONDS,
    ):
        return

    try:
        moved = 0
        for planning_key in sorted(moves):
            if repositories.planning.move_counts(workspace_id, planning_key, moves[planning_key]):
                moved += 1
    except Exception:
        repositories.idempotency.release(workspace_id, IDEMPOTENCY_SCOPE, event_id)
        raise

    _log.info(
        "Moved planning rollup counts.",
        extra={"event": "planning.rollup", "workspace_id": workspace_id, "rows": moved},
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
        repositories
        if repositories is not None
        else build_bundle(DOMAINS["planning"].all_repositories, name="planning")
    )
    router = APIRouter()

    def consume(record: Mapping[str, Any]) -> None:
        """Handle one record against this domain's bundle."""
        handle_record(bundle, record)

    register_stream_consumer(router, consume, log_event="planning.rollup.batch")
    return router
