"""The search consumer: keeps the term projection matching the issues table.

For each record it computes the term set of the new image and of the old one and
writes only the difference, so editing one word of a long body costs two rows
rather than a rewrite of the issue's whole term set. A REMOVE deletes every term of
the old image, because a deleted issue that stayed findable would be worse than one
that was never indexed.

An issue is posted under at most `TERM_CAP` terms, title terms first, with
stopwords left out. Terms that leave the text are also deleted from the wider
`legacy_terms` set, so postings written before the cap and the stopwords existed
are cleaned up as their issue is edited or removed, without a backfill. Each
posting is a single put: nothing is read before a write.

Idempotency needs nothing extra. Writing a term is a put of a row whose whole
content is its key and deleting one tolerates absence, so replaying a record
converges on the same state. Nothing here is incremented.

Postings are filed under the issue's team, so an issue that moved to another
team has every old posting deleted from the old team's partition and its whole
term set written under the new one, rather than a difference.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

from fastapi import APIRouter
from webbpulse.events import deserialize_image, register_stream_consumer

from app.common.api.dependencies.repositories import Repositories, build_bundle
from app.common.db.dynamo.search_index import issue_terms, legacy_terms

_log = logging.getLogger(__name__)


def _text(image: Mapping[str, Any], name: str) -> str:
    """One attribute of a stream image as a string, empty when absent or null."""
    value = image.get(name)
    return str(value).strip() if value is not None else ""


def _identity(new_image: Mapping[str, Any], old_image: Mapping[str, Any]) -> tuple[str, str, str]:
    """The workspace, team and issue a record is about, from either image.

    A REMOVE carries no new image, so the old one is read as the fallback rather
    than the record being skipped: that is exactly the case the projection has to
    clean up after.
    """
    for image in (new_image, old_image):
        workspace_id = _text(image, "workspace_id")
        team_id = _text(image, "team_id")
        issue_id = _text(image, "issue_id")
        if workspace_id and team_id and issue_id:
            return workspace_id, team_id, issue_id
    return "", "", ""


def _move_postings(
    repositories: Repositories,
    workspace_id: str,
    old_team_id: str,
    team_id: str,
    issue_id: str,
    new_image: Mapping[str, Any],
    old_image: Mapping[str, Any],
) -> None:
    """Refile an issue that moved team: every old posting goes, every new term is written under the new team."""
    repositories.search_index.apply(
        workspace_id,
        old_team_id,
        issue_id,
        appeared=set(),
        departed=issue_terms(old_image) | legacy_terms(old_image),
    )
    repositories.search_index.apply(
        workspace_id,
        team_id,
        issue_id,
        appeared=issue_terms(new_image),
        departed=set(),
    )
    _log.info(
        "Refiled a moved issue in the search projection.",
        extra={"event": "views.search.move", "workspace_id": workspace_id, "issue_id": issue_id},
    )


def handle_record(repositories: Repositories, record: Mapping[str, Any]) -> None:
    """Bring one issue's postings in line with what the record says it now holds.

    Raising puts this record alone into `batchItemFailures`, so a transient failure
    retries the record rather than the whole batch.
    """
    new_image = deserialize_image(record, "NewImage")
    old_image = deserialize_image(record, "OldImage")

    workspace_id, team_id, issue_id = _identity(new_image, old_image)
    if not workspace_id or not team_id or not issue_id:
        return

    removed = str(record.get("eventName", "")).upper() == "REMOVE"
    wanted = set() if removed else issue_terms(new_image)
    held = issue_terms(old_image)

    old_team_id = _text(old_image, "team_id")
    if not removed and old_team_id and old_team_id != team_id:
        _move_postings(repositories, workspace_id, old_team_id, team_id, issue_id, new_image, old_image)
        return

    appeared = wanted - held
    departed = (held - wanted) | (legacy_terms(old_image) - (set() if removed else legacy_terms(new_image)))
    if not appeared and not departed:
        return

    repositories.search_index.apply(
        workspace_id,
        team_id,
        issue_id,
        appeared=appeared,
        departed=departed,
    )

    _log.info(
        "Updated the search projection.",
        extra={
            "event": "views.search.index",
            "workspace_id": workspace_id,
            "issue_id": issue_id,
            "added": len(appeared),
            "removed": len(departed),
        },
    )


def build_router(repositories: Repositories | None = None) -> APIRouter:
    """The search consumer's router, mounted at the root with no API prefix.

    Unprefixed for the same reason the notify consumer is: the adapter posts to its
    own pass-through path, outside `/api`.
    """
    from app.common.composition.domains import DOMAINS

    bundle = repositories if repositories is not None else build_bundle(DOMAINS["views"].all_repositories, name="views")
    router = APIRouter()

    def consume(record: Mapping[str, Any]) -> None:
        """Handle one record against this domain's bundle."""
        handle_record(bundle, record)

    register_stream_consumer(router, consume, log_event="views.search.batch")
    return router
