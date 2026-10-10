"""The `audit` table: the security and admin events of one workspace, newest first.

One partition per workspace with a ULID sort key, so the newest page is one
descending query and a date range is a key condition rather than a filter. Each
row carries `expires_at`, a year after it was written, so the table's TTL ages the
log out with no sweeper. Rows are written once and never edited.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import Repository, new_ulid

from app.common.db.dynamo.base import as_item, build_repository, delete_partition, utc_now
from app.common.db.dynamo.tables import AUDIT

RETENTION = timedelta(days=365)

MAX_ROUNDS = 10
"""How many filtered reads one page may take before it answers with what it found.

A filter on actor or event can leave a read empty while the cursor moves on, so
a page keeps reading up to this bound and then hands the caller the cursor."""


def audit_floor(moment: datetime) -> str:
    """The ten character time prefix of every audit id minted at or after `moment`, a naive one read as UTC."""
    return new_ulid(moment if moment.tzinfo is not None else moment.replace(tzinfo=UTC))[:10]


def _expiry(moment: datetime) -> int:
    """The epoch second a row written at `moment` ages out at."""
    return int((moment + RETENTION).timestamp())


class AuditEvent(BaseModel):
    """One security or admin event in a workspace.

    `actor_kind` is `user`, `api_key`, `service` or `system`; `source` is the client
    (`web`, `api`, `cli`, `mcp`) or `system`. `before` and `after` hold only the
    fields the event changed, never a secret.
    """

    workspace_id: str
    audit_id: str = Field(default_factory=new_ulid)
    event: str
    actor_id: str
    actor_kind: str = "user"
    source: str = "web"
    ip: str = ""
    amr: list[str] = Field(default_factory=list)
    target_type: str = ""
    target_id: str = ""
    target_label: str = ""
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None
    created_at: datetime = Field(default_factory=utc_now)
    expires_at: int = 0


class AuditRepository:
    """Writes and reads `audit` rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(AUDIT, repository)

    def record(self, event: AuditEvent) -> AuditEvent:
        """Store one event, stamping its expiry from when it happened."""
        if not event.expires_at:
            event = event.model_copy(update={"expires_at": _expiry(event.created_at)})
        self._repository.put(as_item(event))
        return event

    def list_events(
        self,
        workspace_id: str,
        *,
        actor_id: str | None = None,
        event: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        limit: int = 50,
        start_key: Mapping[str, Any] | None = None,
    ) -> tuple[list[AuditEvent], dict[str, Any] | None]:
        """One page of events newest first, and the key to resume after it.

        `since` is inclusive and `until` exclusive, both read as ULID key bounds.
        Actor and event are filters, so a page reads on until it has `limit` rows,
        the partition ends, or `MAX_ROUNDS` reads have run.
        """
        condition = Key("workspace_id").eq(workspace_id)
        if since is not None and until is not None and audit_floor(since) >= audit_floor(until):
            return [], None
        if since is not None and until is not None:
            condition = condition & Key("audit_id").between(audit_floor(since), audit_floor(until))
        elif since is not None:
            condition = condition & Key("audit_id").gte(audit_floor(since))
        elif until is not None:
            condition = condition & Key("audit_id").lt(audit_floor(until))
        filters = None
        if actor_id:
            filters = Attr("actor_id").eq(actor_id)
        if event:
            matched = Attr("event").eq(event)
            filters = matched if filters is None else filters & matched
        rows: list[AuditEvent] = []
        cursor: dict[str, Any] | None = dict(start_key) if start_key else None
        for _ in range(MAX_ROUNDS):
            page = self._repository.query(
                condition,
                filter_expression=filters,
                limit=limit - len(rows),
                start_key=cursor,
                ascending=False,
            )
            rows.extend(AuditEvent.model_validate(item) for item in page.items)
            cursor = dict(page.last_evaluated_key) if page.last_evaluated_key else None
            if cursor is None or len(rows) >= limit:
                break
        return rows, cursor

    def delete_for_workspace(self, workspace_id: str) -> int:
        """Remove a workspace's whole audit log, for the workspace purge."""
        return delete_partition(self._repository, AUDIT, workspace_id)
