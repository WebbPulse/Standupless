"""Send a stream batch's notices to the connections allowed to read them.

Each workspace in the batch costs one query of its connection rows, however many
notices it has, and each distinct member's visibility of a team is read once per
batch. Visibility is decided at send time from the member's current rows, so a
member removed, suspended or taken off a private team stops hearing that team's
changes on the next write, even on a socket opened before.

The fan-out is best effort. A send API Gateway answers with 410 deletes the row,
any other failure is logged and skipped, and nothing here ever fails the stream
batch, because a missed notice costs one polling interval and a retried batch
would repeat every webhook and channel post the same records produced.
"""

from __future__ import annotations

import json
import logging
import time
from collections import defaultdict
from collections.abc import Callable, Iterable
from typing import Any, Protocol

from app.common.api.dependencies.repositories import Repositories
from app.common.core.config import settings
from app.common.db.dynamo.realtime_connections import RealtimeConnection, RealtimeConnectionRepository
from app.common.team_privacy import person_can_see_team
from app.domains.integrations.realtime.notices import Notice

_log = logging.getLogger(__name__)

SEND_TIMEOUT_SECONDS = 2.0
"""How long one send may take to connect and to answer before it is given up."""

FANOUT_BUDGET_SECONDS = 10.0
"""How long one batch's sends may run, well inside the function's timeout."""


class ConnectionSender(Protocol):
    """Posts one message to one connection."""

    def send(self, connection_id: str, data: bytes) -> bool:
        """Send `data`, answering False when the connection is gone for good."""
        ...


class GatewaySender:
    """The API Gateway management API, built on first use."""

    def __init__(self, endpoint_url: str) -> None:
        """Bind to one stage's connection management endpoint."""
        self._endpoint_url = endpoint_url
        self._client: Any = None

    def _api(self) -> Any:
        """The management API client, with short timeouts and no retries."""
        if self._client is None:
            import boto3
            from botocore.config import Config

            self._client = boto3.client(
                "apigatewaymanagementapi",
                endpoint_url=self._endpoint_url,
                region_name=settings.AWS_REGION if settings.AWS_REGION != "auto" else None,
                config=Config(
                    connect_timeout=SEND_TIMEOUT_SECONDS,
                    read_timeout=SEND_TIMEOUT_SECONDS,
                    retries={"max_attempts": 1, "mode": "standard"},
                ),
            )
        return self._client

    def send(self, connection_id: str, data: bytes) -> bool:
        """Post one message, answering False on 410 Gone."""
        api = self._api()
        try:
            api.post_to_connection(ConnectionId=connection_id, Data=data)
        except api.exceptions.GoneException:
            return False
        return True


_sender: GatewaySender | None = None


def default_sender() -> ConnectionSender | None:
    """The process's sender, or None where no WebSocket API is configured."""
    global _sender
    if not settings.REALTIME_ENDPOINT_URL:
        return None
    if _sender is None:
        _sender = GatewaySender(settings.REALTIME_ENDPOINT_URL)
    return _sender


class Visibility:
    """Who may read what, remembered for one batch."""

    def __init__(self, repositories: Repositories) -> None:
        """Start an empty memory over one bundle."""
        self._repositories = repositories
        self._teams: dict[tuple[str, str, str], bool] = {}
        self._roles: dict[tuple[str, str], str | None] = {}

    def _role(self, workspace_id: str, user_id: str) -> str | None:
        """The member's workspace role, or None for a non-member or a suspended one."""
        key = (workspace_id, user_id)
        if key not in self._roles:
            membership = self._repositories.memberships.get(workspace_id, user_id)
            self._roles[key] = None if membership is None or membership.is_suspended else membership.role
        return self._roles[key]

    def _team(self, workspace_id: str, team_id: str, user_id: str) -> bool:
        """Whether the member may read one team."""
        key = (workspace_id, team_id, user_id)
        if key not in self._teams:
            self._teams[key] = person_can_see_team(self._repositories, workspace_id, team_id, user_id)
        return self._teams[key]

    def allows(self, notice: Notice, user_id: str) -> bool:
        """Whether one member may hear one notice, by the rule the HTTP API reads it under."""
        role = self._role(notice.workspace_id, user_id)
        if role is None:
            return False
        if notice.kind == "project":
            return any(self._team(notice.workspace_id, team, user_id) for team in notice.team_ids)
        if notice.kind == "initiative":
            if role == "guest":
                return False
            return notice.team_id is None or self._team(notice.workspace_id, notice.team_id, user_id)
        return notice.team_id is not None and self._team(notice.workspace_id, notice.team_id, user_id)


def fan_out(
    repositories: Repositories,
    notices: Iterable[Notice],
    sender: ConnectionSender | None,
    *,
    clock: Callable[[], float] = time.monotonic,
    budget_seconds: float = FANOUT_BUDGET_SECONDS,
) -> dict[str, int]:
    """Send each notice to every connection allowed to read it, answering counts for the log."""
    counts = {"notices": 0, "sent": 0, "gone": 0, "failed": 0, "skipped": 0}
    by_workspace: dict[str, list[Notice]] = defaultdict(list)
    for notice in notices:
        by_workspace[notice.workspace_id].append(notice)
        counts["notices"] += 1
    if sender is None or not by_workspace:
        return counts

    deadline = clock() + budget_seconds
    visibility = Visibility(repositories)
    store = repositories.realtime_connections
    for workspace_id, workspace_notices in by_workspace.items():
        connections = store.list_for_workspace(workspace_id)
        gone: set[str] = set()
        for notice in workspace_notices:
            data = json.dumps(notice.message(), separators=(",", ":")).encode()
            for connection in connections:
                if connection.connection_id in gone:
                    continue
                if clock() > deadline:
                    counts["skipped"] += 1
                    continue
                if not visibility.allows(notice, connection.user_id):
                    continue
                _send(store, sender, connection, data, gone, counts)
    return counts


def _send(
    store: RealtimeConnectionRepository,
    sender: ConnectionSender,
    connection: RealtimeConnection,
    data: bytes,
    gone: set[str],
    counts: dict[str, int],
) -> None:
    """Send one message, dropping the row of a connection API Gateway says is gone."""
    try:
        delivered = sender.send(connection.connection_id, data)
    except Exception:
        counts["failed"] += 1
        _log.warning(
            "A change notice could not be sent.",
            exc_info=True,
            extra={"event": "integrations.realtime.send_failed", "workspace_id": connection.workspace_id},
        )
        return
    if delivered:
        counts["sent"] += 1
        return
    counts["gone"] += 1
    gone.add(connection.connection_id)
    try:
        store.remove(connection)
    except Exception:
        _log.warning(
            "A gone connection's row could not be removed; its TTL will.",
            exc_info=True,
            extra={"event": "integrations.realtime.remove_failed", "workspace_id": connection.workspace_id},
        )
