"""The `idempotency` table: one-shot claims, so a retried call does its work once.

A thin wrapper over `webbpulse.dynamodb.IdempotencyStore` bound to this product's
table and its `scope_key` partition. The table is not workspace-partitioned, so
every caller composes the workspace into the key it claims, which `scoped_key`
does rather than leaving it to each call site.

M1 owns the table because `POST /api/invites/accept` is idempotent for an existing
member. The GitHub delivery ids design section 4 describes arrive with M5.
"""

from __future__ import annotations

from webbpulse.dynamodb import IdempotencyStore, Repository

from app.common.db.dynamo.base import build_repository
from app.common.db.dynamo.tables import IDEMPOTENCY

DEFAULT_TTL_SECONDS = 24 * 60 * 60


def scoped_key(workspace_id: str, scope: str, key: str) -> str:
    """The claim key for one workspace, namespaced by what is being claimed.

    The workspace id leads, so two tenants using the same client-supplied key
    never collide in a table whose partition carries no tenant of its own.
    """
    return f"ws#{workspace_id}#{scope}#{key}"


class IdempotencyRepository:
    """Claims keys in the `idempotency` table, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(IDEMPOTENCY, repository)
        self._store = IdempotencyStore(
            self._repository,
            key_attribute="scope_key",
            ttl_attribute="expires_at",
        )

    def claim(self, workspace_id: str, scope: str, key: str, *, ttl_seconds: float = DEFAULT_TTL_SECONDS) -> bool:
        """Claim one key for this caller, answering whether it won.

        True means nobody had claimed it and this caller owns the work. False means
        a live claim exists and this call is a duplicate to short-circuit.
        """
        return self._store.claim(scoped_key(workspace_id, scope, key), ttl_seconds)

    def release(self, workspace_id: str, scope: str, key: str) -> None:
        """Drop a claim, so a caller that failed can be retried before the TTL."""
        self._store.release(scoped_key(workspace_id, scope, key))
