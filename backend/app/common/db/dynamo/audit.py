"""The `audit` table: the security and admin events of one workspace, newest first.

The shared `webbpulse.audit` store reads and writes it under this table's own
attribute names, so rows written before the adoption list unchanged. One
partition per workspace with a ULID sort key, so the newest page is one
descending query and a date range is a key condition. Each row carries
`expires_at`, a year after it was written, so the table's TTL ages the log out
with no sweeper. Rows are written once and never edited.
"""

from __future__ import annotations

from datetime import timedelta

from webbpulse.audit import AuditAttributes, DynamoAuditLogStore
from webbpulse.dynamodb import Repository

from app.common.db.dynamo.base import build_repository
from app.common.db.dynamo.tables import AUDIT

RETENTION = timedelta(days=365)

AUDIT_ATTRIBUTES = AuditAttributes(
    tenant_id="workspace_id",
    event_id="audit_id",
    action="event",
    occurred_at="created_at",
)
"""The stored names this table has used since it was created."""


class AuditRepository(DynamoAuditLogStore):
    """The shared audit log store bound to this product's `audit` table, which has no target index."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        super().__init__(build_repository(AUDIT, repository), attributes=AUDIT_ATTRIBUTES, target_index=None)

    def delete_for_workspace(self, workspace_id: str) -> int:
        """Remove a workspace's whole audit log, for the workspace purge."""
        return self.purge_tenant(workspace_id)
