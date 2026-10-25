"""The `realtime_connections` table: the WebSocket connections open on each workspace.

A row is written when `$connect` is accepted and removed on `$disconnect`, on a
send that API Gateway answers with 410, or by the table's TTL when neither ran.
Nothing else reads it but the stream fan-out, which reads one workspace at a time.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Mapping

from boto3.dynamodb.conditions import Key
from webbpulse.dynamodb import Repository

from app.common.db.dynamo.base import build_repository
from app.common.db.dynamo.tables import REALTIME_CONNECTIONS

CONNECTION_INDEX = "connection_id-index"
"""The index resolving a connection id to its workspace row."""

CONNECTION_TTL_SECONDS = 2 * 60 * 60 + 15 * 60
"""How long a row outlives its connect: API Gateway's two hour limit and a margin."""


def connection_key(user_id: str, connection_id: str) -> str:
    """The sort key of one connection, the member first so their rows are one prefix."""
    return f"{user_id}#{connection_id}"


@dataclass(frozen=True)
class RealtimeConnection:
    """One open connection: whose it is, on which workspace, and until when it counts."""

    workspace_id: str
    connection_id: str
    user_id: str
    connected_at: int
    expires_at: int

    @property
    def key(self) -> dict[str, str]:
        """The row's primary key."""
        return {"workspace_id": self.workspace_id, "connection_key": connection_key(self.user_id, self.connection_id)}

    def expired(self, now: float | None = None) -> bool:
        """Whether the row is past its TTL, which DynamoDB may not have reclaimed yet."""
        return self.expires_at <= int(now if now is not None else time.time())

    @classmethod
    def from_item(cls, item: Mapping[str, Any]) -> "RealtimeConnection":
        """The connection one stored row describes."""
        return cls(
            workspace_id=str(item["workspace_id"]),
            connection_id=str(item["connection_id"]),
            user_id=str(item["user_id"]),
            connected_at=int(item.get("connected_at", 0)),
            expires_at=int(item.get("expires_at", 0)),
        )


class RealtimeConnectionRepository:
    """Reads and writes connection rows, every list read inside one workspace."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(REALTIME_CONNECTIONS, repository)

    def add(
        self, workspace_id: str, user_id: str, connection_id: str, *, now: float | None = None
    ) -> RealtimeConnection:
        """Store one accepted connection with its expiry."""
        moment = int(now if now is not None else time.time())
        connection = RealtimeConnection(
            workspace_id=workspace_id,
            connection_id=connection_id,
            user_id=user_id,
            connected_at=moment,
            expires_at=moment + CONNECTION_TTL_SECONDS,
        )
        self._repository.put(
            {
                **connection.key,
                "connection_id": connection.connection_id,
                "user_id": connection.user_id,
                "connected_at": connection.connected_at,
                "expires_at": connection.expires_at,
            }
        )
        return connection

    def list_for_workspace(self, workspace_id: str, *, now: float | None = None) -> list[RealtimeConnection]:
        """Every live connection on one workspace, skipping rows past their TTL."""
        rows = self._repository.iter_query(Key("workspace_id").eq(workspace_id))
        connections = [RealtimeConnection.from_item(row) for row in rows]
        return [connection for connection in connections if not connection.expired(now)]

    def count_for_member(self, workspace_id: str, user_id: str, *, now: float | None = None) -> int:
        """How many live connections one member holds on one workspace."""
        rows = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("connection_key").begins_with(f"{user_id}#")
        )
        return sum(1 for row in rows if not RealtimeConnection.from_item(row).expired(now))

    def find(self, connection_id: str) -> RealtimeConnection | None:
        """The row one connection id names, through the connection index."""
        if not connection_id:
            return None
        page = self._repository.query(Key("connection_id").eq(connection_id), index_name=CONNECTION_INDEX, limit=5)
        for item in page.items:
            row = self._repository.get({"workspace_id": item["workspace_id"], "connection_key": item["connection_key"]})
            if row is not None:
                return RealtimeConnection.from_item(row)
        return None

    def remove(self, connection: RealtimeConnection) -> None:
        """Delete one connection row. Deleting an absent row is not an error."""
        self._repository.delete(connection.key)

    def remove_by_id(self, connection_id: str) -> RealtimeConnection | None:
        """Delete the row one connection id names, answering the row that was there."""
        connection = self.find(connection_id)
        if connection is not None:
            self.remove(connection)
        return connection

    def refresh(self, connection: RealtimeConnection, *, now: float | None = None) -> None:
        """Push one connection's expiry out again, for a heartbeat on a long lived socket."""
        moment = int(now if now is not None else time.time())
        self._repository.set_attributes(
            connection.key,
            {"expires_at": moment + CONNECTION_TTL_SECONDS},
            return_values="NONE",
        )
