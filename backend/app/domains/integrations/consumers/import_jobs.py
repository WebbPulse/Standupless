"""The issue import consumer: writes one page of a queued import per message.

The route that starts an import writes its job object and source file first and
sends only the ids and the cursor, so a message carries no requester state that
could disagree with the job. A message whose cursor the job has moved past is
dropped, and a page that raises is left on the queue to run again, which the
deterministic issue ids make safe.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Mapping

from fastapi import APIRouter
from webbpulse.events import register_stream_consumer

from app.common import issue_import
from app.common.api.dependencies.repositories import Repositories, build_bundle

_log = logging.getLogger(__name__)


def _page(record: Mapping[str, Any]) -> Mapping[str, Any]:
    """The payload inside one SQS record, or an empty mapping when it will not parse."""
    raw = record.get("body")
    if not isinstance(raw, str):
        return {}
    try:
        envelope = json.loads(raw)
    except ValueError:
        _log.warning("An import record would not parse.", extra={"event": "issue.import.unparseable"})
        return {}
    payload = envelope.get("payload") if isinstance(envelope, Mapping) else None
    return payload if isinstance(payload, Mapping) else {}


def handle_record(repositories: Repositories, record: Mapping[str, Any]) -> None:
    """Write the page one record names."""
    page = _page(record)
    workspace_id = str(page.get("workspace_id", ""))
    import_id = str(page.get("import_id", ""))
    cursor = page.get("cursor")
    if not workspace_id or not import_id or not isinstance(cursor, int):
        return
    issue_import.handle_page(repositories, workspace_id, import_id, cursor)


def build_router(repositories: Repositories | None = None) -> APIRouter:
    """The import consumer's router, mounted at the root with no API prefix."""
    bundle = (
        repositories
        if repositories is not None
        else build_bundle(
            (*issue_import.IMPORT_REPOSITORIES, *issue_import.IMPORT_READ_REPOSITORIES),
            name="integrations-import",
            read_only=issue_import.IMPORT_READ_REPOSITORIES,
        )
    )
    router = APIRouter()

    def consume(record: Mapping[str, Any]) -> None:
        """Handle one record against the import's bundle."""
        handle_record(bundle, record)

    register_stream_consumer(router, consume, log_event="issue.import.batch")
    return router
