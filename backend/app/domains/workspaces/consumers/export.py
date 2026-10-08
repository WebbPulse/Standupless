"""The workspace export consumer: builds one queued export per message.

The route that queues an export writes its job object first and sends only the
two ids, so a message carries no requester state that could disagree with the
job, and a redelivered message finds the job already finished and builds nothing.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Mapping

from fastapi import APIRouter
from webbpulse.events import register_stream_consumer

from app.common import workspace_export
from app.common.api.dependencies.repositories import Repositories, build_bundle

_log = logging.getLogger(__name__)


def _job(record: Mapping[str, Any]) -> Mapping[str, Any]:
    """The payload inside one SQS record, or an empty mapping when it will not parse."""
    raw = record.get("body")
    if not isinstance(raw, str):
        return {}
    try:
        envelope = json.loads(raw)
    except ValueError:
        _log.warning("An export record would not parse.", extra={"event": "workspace.export.unparseable"})
        return {}
    payload = envelope.get("payload") if isinstance(envelope, Mapping) else None
    return payload if isinstance(payload, Mapping) else {}


def handle_record(repositories: Repositories, record: Mapping[str, Any]) -> None:
    """Build the export one record names."""
    job = _job(record)
    workspace_id = str(job.get("workspace_id", ""))
    export_id = str(job.get("export_id", ""))
    if not workspace_id or not export_id:
        return
    workspace_export.run_export(repositories, workspace_id, export_id)


def build_router(repositories: Repositories | None = None) -> APIRouter:
    """The export consumer's router, mounted at the root with no API prefix."""
    bundle = (
        repositories
        if repositories is not None
        else build_bundle(
            (*workspace_export.EXPORT_REPOSITORIES, *workspace_export.EXPORT_READ_REPOSITORIES),
            name="workspaces-export",
            read_only=workspace_export.EXPORT_READ_REPOSITORIES,
        )
    )
    router = APIRouter()

    def consume(record: Mapping[str, Any]) -> None:
        """Handle one record against the export's bundle."""
        handle_record(bundle, record)

    register_stream_consumer(router, consume, log_event="workspace.export.batch")
    return router
