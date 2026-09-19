"""The `api_keys` table, and the `ApiKeyStore` the identity package verifies against.

The package's `mint`, `verify`, `revoke` and `effective_scopes` are what run; only
the storage is this product's, because the package's own `DynamoApiKeyStore`
partitions by `key_hash` and cannot answer "every key in this workspace" without a
scan, which design section 2 forbids outside an admin path.

The plaintext key never reaches this module. `mint` hands back the one copy that
will ever exist and the row here holds its SHA-256, so a read grant on this table
authenticates as nobody.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Iterable, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository, new_ulid
from webbpulse.identity.api_keys import ApiKeyRecord, ApiKeyStore

from app.common.db.dynamo.base import as_item, build_repository, first, utc_now
from app.common.db.dynamo.tables import API_KEYS

KEY_KINDS: tuple[str, ...] = ("user", "workspace")

API_KEY_SCOPES: tuple[str, ...] = (
    "issues:read",
    "issues:write",
    "comments:write",
    "projects:read",
    "views:read",
)
"""The five scopes design section 5 fixes, and the only ones a key may carry.

Exported so the route validation, the MCP tool table and the frontend's checkbox
list all read one definition rather than three that drift.
"""

SERVICE_SCOPES: tuple[str, ...] = API_KEY_SCOPES
"""What a per-workspace key intersects against, in place of a membership row.

A workspace key acts as the workspace rather than as a person, so there is no
membership to read. It still intersects, against this fixed set, which is what
keeps the intersection rule a single code path for both kinds.
"""


def new_key_id() -> str:
    """A fresh key id, time sortable so a listing reads in creation order."""
    return new_ulid()


def service_subject(workspace_id: str) -> str:
    """The synthetic principal a per-workspace key acts as.

    Prefixed so it can never collide with a real user id and so a row written by a
    workspace key is recognisable as one in the activity feed.
    """
    return f"svc#{workspace_id}"


def is_service_subject(user_id: str) -> bool:
    """Whether a subject is a workspace key's synthetic principal."""
    return user_id.startswith("svc#")


class ApiKey(BaseModel):
    """One stored API key. Holds the hash and never the plaintext."""

    workspace_id: str
    key_id: str = Field(default_factory=new_key_id)
    key_hash: str
    name: str
    kind: str = "user"
    prefix: str
    scopes: list[str] = Field(default_factory=list)
    user_id: str
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    expires_at: int = 0
    last_used_at: datetime | None = None
    revoked_at: datetime | None = None

    def to_record(self) -> ApiKeyRecord:
        """This row as the package's own record, which is what `verify` answers with.

        `tenant_id` is the workspace, so the package's tenant claim and this
        product's `workspace_id` are the same string and nothing has to translate
        between them on the authorization path.
        """
        return ApiKeyRecord(
            key_hash=self.key_hash,
            user_id=self.user_id,
            tenant_id=self.workspace_id,
            prefix=self.prefix,
            scopes=tuple(self.scopes),
            name=self.name,
            created_at=self.created_at.isoformat(),
            expires_at=self.expires_at,
            last_used_at=self.last_used_at.isoformat() if self.last_used_at else "",
            revoked_at=self.revoked_at.isoformat() if self.revoked_at else "",
        )


class ApiKeyRepository:
    """Reads and writes `api_keys` rows, every method workspace first but one.

    The exception is `get_by_hash`, which is the verification path: a presented key
    carries no workspace, and resolving one is exactly what the read is for. It
    answers the row's own workspace, which every later decision is then made
    against, so the tenant still comes from stored state rather than from the
    caller.
    """

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(API_KEYS, repository)

    def get(self, workspace_id: str, key_id: str) -> ApiKey | None:
        """One key by its workspace and id, or `None`."""
        if not workspace_id or not key_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "key_id": key_id})
        return ApiKey.model_validate(dict(item)) if item is not None else None

    def get_by_hash(self, key_hash: str) -> ApiKey | None:
        """One key by its stored hash, through `key_hash-index`, or `None`.

        The index is the price of partitioning by workspace, and it is paid on the
        machine path rather than the human one deliberately: a key verification is
        one index query, a settings page is one partition query, and neither is a
        scan.
        """
        if not key_hash:
            return None
        page = self._repository.query(
            Key("key_hash").eq(key_hash),
            index_name="key_hash-index",
            limit=1,
        )
        item = first(list(page.items))
        return ApiKey.model_validate(dict(item)) if item is not None else None

    def create(self, key: ApiKey) -> ApiKey:
        """Store a new key, raising `ConditionFailed` when the id is taken."""
        self._repository.put(as_item(key), condition=Attr("key_id").not_exists())
        return key

    def revoke(self, workspace_id: str, key_id: str, *, revoked_at: datetime | None = None) -> ApiKey | None:
        """Mark one key revoked, or `None` when it was not there.

        Revoking is a write rather than a delete so the row stays visible in the
        settings list: a key that vanished would be indistinguishable from one that
        never existed, which is the same reasoning the package's own store records.
        """
        key = {"workspace_id": workspace_id, "key_id": key_id}
        try:
            item = self._repository.set_attributes(
                key,
                {"revoked_at": (revoked_at or utc_now()).isoformat()},
                condition=Attr("key_id").exists(),
            )
        except ConditionFailed:
            return None
        return ApiKey.model_validate(dict(item)) if item is not None else None

    def touch(self, workspace_id: str, key_id: str, *, used_at: datetime | None = None) -> None:
        """Record that a key was just used. Best effort, and never refuses a request.

        A failure here is swallowed because the write is telemetry: refusing a
        request because the last-used stamp could not be written would make a
        throttled table an outage.
        """
        try:
            self._repository.set_attributes(
                {"workspace_id": workspace_id, "key_id": key_id},
                {"last_used_at": (used_at or utc_now()).isoformat()},
                condition=Attr("key_id").exists(),
            )
        except ConditionFailed:
            return

    def list_for_workspace(self, workspace_id: str, *, limit: int = 200) -> list[ApiKey]:
        """Every key of one workspace, newest first."""
        if not workspace_id:
            return []
        items: list[Mapping[str, Any]] = list(
            self._repository.iter_query(Key("workspace_id").eq(workspace_id), max_items=limit)
        )
        rows = [ApiKey.model_validate(dict(item)) for item in items]
        return sorted(rows, key=lambda row: row.created_at, reverse=True)

    def list_for_user(self, workspace_id: str, user_id: str, *, limit: int = 200) -> list[ApiKey]:
        """Every key one member holds in one workspace, newest first.

        Filtered after the partition read rather than through a second index: a
        workspace's key count is bounded at 25 by the contract, so the filter reads
        one short partition and an index would cost a write on every mint to save
        nothing.
        """
        return [row for row in self.list_for_workspace(workspace_id, limit=limit) if row.user_id == user_id]

    def count_for_workspace(self, workspace_id: str) -> int:
        """How many live keys one workspace holds, for the limit check.

        Revoked keys do not count: they authenticate nobody, and counting them would
        make a workspace that rotated its keys unable to mint another.
        """
        return len([row for row in self.list_for_workspace(workspace_id) if row.revoked_at is None])


class WorkspaceApiKeyStore(ApiKeyStore):
    """The package's `ApiKeyStore` over this product's workspace-partitioned table.

    Implements the protocol `webbpulse.identity.api_keys.verify` reads through, so
    the package's verification, constant-time comparison and usability checks are
    what run and none of that logic is rewritten here.

    `list_for_user` and `delete_all_for_user` span workspaces in the protocol's
    shape and cannot here, because this table has no cross-workspace index by
    design. Both answer empty rather than scanning: the product's own listing goes
    through `ApiKeyRepository.list_for_user` with a workspace in hand, and account
    deletion is not a route this product serves.
    """

    def __init__(self, repository: ApiKeyRepository | None = None) -> None:
        """Take an injected repository, or build one over this table."""
        self._keys = repository if repository is not None else ApiKeyRepository()

    def get(self, key_hash: str) -> ApiKeyRecord | None:
        """The record behind one hash, revoked and expired ones included."""
        row = self._keys.get_by_hash(key_hash)
        return row.to_record() if row is not None else None

    def put(self, record: ApiKeyRecord) -> None:
        """Write a record the package minted, deriving the row's own fields.

        Never called by this product: the routes build the `ApiKey` row themselves
        so it carries `key_id`, `kind` and `created_by`, which the package's record
        has no place for. Implemented because the protocol is abstract.
        """
        self._keys.create(
            ApiKey(
                workspace_id=record.tenant_id,
                key_hash=record.key_hash,
                name=record.name,
                prefix=record.prefix,
                scopes=list(record.scopes),
                user_id=record.user_id,
                created_by=record.user_id,
                expires_at=record.expires_at,
            )
        )

    def list_for_user(self, user_id: str) -> list[ApiKeyRecord]:
        """Empty, always. This table cannot answer across workspaces without a scan."""
        del user_id
        return []

    def revoke(self, key_hash: str, *, revoked_at: str | None = None) -> ApiKeyRecord | None:
        """Mark a key revoked by its hash, resolving the workspace through the index."""
        row = self._keys.get_by_hash(key_hash)
        if row is None:
            return None
        updated = self._keys.revoke(row.workspace_id, row.key_id)
        return updated.to_record() if updated is not None else None

    def touch(self, key_hash: str, *, used_at: str | None = None) -> None:
        """Record a use, resolving the workspace through the index. Best effort."""
        del used_at
        row = self._keys.get_by_hash(key_hash)
        if row is None:
            return
        self._keys.touch(row.workspace_id, row.key_id)

    def delete_all_for_user(self, user_id: str) -> int:
        """Zero, always. There is no account deletion route in this product."""
        del user_id
        return 0


def normalise_scopes(scopes: Iterable[str]) -> list[str]:
    """The requested scopes, deduplicated and in the canonical order.

    Ordered by `API_KEY_SCOPES` rather than alphabetically so a stored row and a
    rendered checkbox list read the same way round.
    """
    wanted = {scope.strip() for scope in scopes if scope.strip()}
    return [scope for scope in API_KEY_SCOPES if scope in wanted]


def unknown_scopes(scopes: Iterable[str]) -> list[str]:
    """Which requested scopes are outside the five, sorted, for a 422 to name."""
    return sorted({scope.strip() for scope in scopes if scope.strip()} - set(API_KEY_SCOPES))
