"""The `realtime_presence` table: who has an issue or a document open right now.

One row per open connection per entity, written by the WebSocket `presence`
message a page sends when it opens and every half minute after, and removed by
`presence_leave`, by `$disconnect`, or by the table's TTL. A row expires
`PRESENCE_TTL_SECONDS` after its last heartbeat, and since DynamoDB reclaims
expired rows late, every read skips them itself.

A row carries the audience the entity had when it was written: the team that
decides who may read it, or a project's teams, and whether guests are kept out.
A leave or a disconnect fans out from that alone, without reading the entity.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Literal, Mapping

from boto3.dynamodb.conditions import Key
from webbpulse.dynamodb import Repository

from app.common.db.dynamo.base import build_repository
from app.common.db.dynamo.tables import REALTIME_PRESENCE

PresenceKind = Literal["issue", "document"]

PRESENCE_KINDS: tuple[PresenceKind, ...] = ("issue", "document")
"""The kinds of page that report presence."""

PRESENCE_CONNECTION_INDEX = "connection_id-index"
"""The index listing every entity one connection has open."""

PRESENCE_TTL_SECONDS = 65
"""How long a row counts after its last heartbeat: two missed half minute beats."""

ENTITY_VIEWERS_MAX = 200
"""The most rows one entity's read walks, far past any real audience."""


def entity_key(workspace_id: str, kind: str, entity_id: str) -> str:
    """The partition key of one entity's presence."""
    return f"{workspace_id}#{kind}#{entity_id}"


@dataclass(frozen=True)
class Audience:
    """Who may read an entity: one team, any of a project's teams, and whether guests are kept out."""

    team_id: str | None = None
    team_ids: tuple[str, ...] = ()
    members_only: bool = False


@dataclass(frozen=True)
class Presence:
    """One connection's open entity, and whether its member is editing it."""

    workspace_id: str
    kind: str
    entity_id: str
    connection_id: str
    user_id: str
    editing: bool
    opened_at: int
    expires_at: int
    audience: Audience

    @property
    def key(self) -> dict[str, str]:
        """The row's primary key."""
        return {
            "ws_entity": entity_key(self.workspace_id, self.kind, self.entity_id),
            "connection_id": self.connection_id,
        }

    def expired(self, now: float | None = None) -> bool:
        """Whether the row is past its TTL, which DynamoDB may not have reclaimed yet."""
        return self.expires_at <= int(now if now is not None else time.time())

    def item(self) -> dict[str, Any]:
        """The stored row."""
        return {
            **self.key,
            "workspace_id": self.workspace_id,
            "kind": self.kind,
            "entity_id": self.entity_id,
            "user_id": self.user_id,
            "editing": self.editing,
            "opened_at": self.opened_at,
            "expires_at": self.expires_at,
            "team_id": self.audience.team_id,
            "team_ids": list(self.audience.team_ids),
            "members_only": self.audience.members_only,
        }

    @classmethod
    def from_item(cls, item: Mapping[str, Any]) -> "Presence":
        """The presence one stored row describes."""
        team_id = item.get("team_id")
        return cls(
            workspace_id=str(item["workspace_id"]),
            kind=str(item["kind"]),
            entity_id=str(item["entity_id"]),
            connection_id=str(item["connection_id"]),
            user_id=str(item["user_id"]),
            editing=bool(item.get("editing", False)),
            opened_at=int(item.get("opened_at", 0)),
            expires_at=int(item.get("expires_at", 0)),
            audience=Audience(
                team_id=str(team_id) if team_id else None,
                team_ids=tuple(str(value) for value in item.get("team_ids") or ()),
                members_only=bool(item.get("members_only", False)),
            ),
        )


class RealtimePresenceRepository:
    """Reads and writes presence rows, one entity or one connection at a time."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(REALTIME_PRESENCE, repository)

    def get(self, workspace_id: str, kind: str, entity_id: str, connection_id: str) -> Presence | None:
        """One connection's row on one entity, or `None`, expired rows included."""
        item = self._repository.get(
            {"ws_entity": entity_key(workspace_id, kind, entity_id), "connection_id": connection_id}
        )
        return Presence.from_item(item) if item is not None else None

    def put(
        self,
        workspace_id: str,
        kind: str,
        entity_id: str,
        connection_id: str,
        user_id: str,
        *,
        editing: bool,
        audience: Audience,
        opened_at: int | None = None,
        now: float | None = None,
    ) -> Presence:
        """Write or refresh one connection's row, its expiry pushed out from now."""
        moment = int(now if now is not None else time.time())
        presence = Presence(
            workspace_id=workspace_id,
            kind=kind,
            entity_id=entity_id,
            connection_id=connection_id,
            user_id=user_id,
            editing=editing,
            opened_at=opened_at if opened_at is not None else moment,
            expires_at=moment + PRESENCE_TTL_SECONDS,
            audience=audience,
        )
        self._repository.put(presence.item())
        return presence

    def list_for_entity(
        self, workspace_id: str, kind: str, entity_id: str, *, now: float | None = None
    ) -> list[Presence]:
        """Every live row on one entity, oldest open first."""
        rows = self._repository.iter_query(
            Key("ws_entity").eq(entity_key(workspace_id, kind, entity_id)), max_items=ENTITY_VIEWERS_MAX
        )
        live = [presence for presence in (Presence.from_item(row) for row in rows) if not presence.expired(now)]
        return sorted(live, key=lambda presence: (presence.opened_at, presence.connection_id))

    def list_for_connection(self, connection_id: str) -> list[Presence]:
        """Every row one connection holds, expired rows included, through the connection index."""
        if not connection_id:
            return []
        rows = self._repository.iter_query(
            Key("connection_id").eq(connection_id), index_name=PRESENCE_CONNECTION_INDEX, max_items=ENTITY_VIEWERS_MAX
        )
        return [Presence.from_item(row) for row in rows]

    def remove(self, presence: Presence) -> None:
        """Delete one row. Deleting an absent row is not an error."""
        self._repository.delete(presence.key)
