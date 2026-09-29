"""Pending notification emails, held in the `inbox` table until their digest is flushed.

Email is coalesced into one message per recipient per workspace per five minute
window. Each notification that should be mailed becomes an entry row in a window
partition, and the first entry of a window also writes a due marker into one
shared partition, keyed by the moment the window closes. A scheduled flush reads
the due markers, claims each with a conditional delete, and mails the window's
entries as one message.

The rows live in the `inbox` table under partitions no member's inbox can name,
because an inbox partition is always `<workspace>#<user>` built from the caller's
own context. That keeps the pending state inside the grant the notify consumer
already holds, and the table's TTL drops anything a flush never reached.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel
from webbpulse.dynamodb import ConditionFailed, Repository

from app.common.db.dynamo.base import as_item

DIGEST_WINDOW = timedelta(minutes=5)
"""How long notification emails to one recipient are gathered before one message goes out."""

DIGEST_RETENTION = timedelta(days=2)
"""How long a pending row survives unflushed before the table TTL drops it.

Long enough that a flush schedule paused for a day still finds the backlog, and
short enough that a window nobody flushes does not linger.
"""

DUE_PARTITION = "digest#due"

_ENTRY_PREFIX = "digest#"

_EPOCH_WIDTH = 12


def window_start(moment: datetime) -> int:
    """The epoch second the fixed five minute window holding `moment` opens at."""
    seconds = int(moment.timestamp())
    width = int(DIGEST_WINDOW.total_seconds())
    return seconds - seconds % width


def window_partition(workspace_id: str, recipient_id: str, window: int) -> str:
    """The partition one recipient's entries for one window are written to."""
    return f"{_ENTRY_PREFIX}{workspace_id}#{recipient_id}#{window}"


def _expiry(moment: datetime) -> int:
    """The TTL stamp for a pending row written at `moment`."""
    return int((moment + DIGEST_RETENTION).timestamp())


class DigestEntry(BaseModel):
    """One notification waiting to be mailed, carrying everything its line in the email needs.

    The fields are captured when the inbox row is written, so the flush renders
    without reading the issue or the project again. `kind` and `team_id` are kept
    so the flush can re-check the recipient's preference and visibility.
    """

    workspace_id: str
    recipient_id: str
    notification_id: str
    kind: str
    team_id: str
    actor_name: str = ""
    headline_key: str | None = None
    issue_id: str = ""
    issue_key: str = ""
    issue_title: str = ""
    excerpt: str = ""
    project_id: str = ""
    project_name: str = ""
    health: str = ""
    created_at: datetime


class DueDigest(BaseModel):
    """One window whose entries are ready to be mailed."""

    workspace_id: str
    recipient_id: str
    window: int
    marker: str


class DigestStore:
    """Writes pending digest entries and hands due windows to the flush."""

    def __init__(self, repository: Repository) -> None:
        """Share the `inbox` table's package repository."""
        self._repository = repository

    def add(self, entry: DigestEntry, now: datetime | None = None) -> int:
        """Hold one entry in its recipient's open window, answering that window.

        The entry is keyed by its notification id, so a second add of the same
        notification overwrites rather than duplicates. The due marker is written
        only when it is not already there, so a busy window costs one marker.
        """
        moment = now or datetime.now(timezone.utc)
        window = window_start(moment)
        partition = window_partition(entry.workspace_id, entry.recipient_id, window)
        self._repository.put(as_item(entry, ws_user=partition, expires_at=_expiry(moment)))

        due_at = window + int(DIGEST_WINDOW.total_seconds())
        marker = f"{due_at:0{_EPOCH_WIDTH}d}#{entry.workspace_id}#{entry.recipient_id}#{window}"
        try:
            self._repository.put(
                {
                    "ws_user": DUE_PARTITION,
                    "notification_id": marker,
                    "workspace_id": entry.workspace_id,
                    "recipient_id": entry.recipient_id,
                    "window": window,
                    "expires_at": _expiry(moment),
                },
                condition=Attr("notification_id").not_exists(),
            )
        except ConditionFailed:
            pass
        return window

    def due(self, cutoff: datetime, *, limit: int) -> list[DueDigest]:
        """The oldest windows that closed at or before `cutoff`, at most `limit` of them."""
        bound = f"{int(cutoff.timestamp()):0{_EPOCH_WIDTH}d}~"
        page = self._repository.query(
            Key("ws_user").eq(DUE_PARTITION) & Key("notification_id").lte(bound),
            limit=limit,
            consistent=True,
        )
        return [
            DueDigest(
                workspace_id=str(item["workspace_id"]),
                recipient_id=str(item["recipient_id"]),
                window=int(item["window"]),
                marker=str(item["notification_id"]),
            )
            for item in page.items
        ]

    def claim(self, due: DueDigest) -> bool:
        """Take one due window for this flush, answering whether it was still there.

        The conditional delete is what keeps two overlapping flushes from mailing
        the same window twice.
        """
        try:
            self._repository.delete(
                {"ws_user": DUE_PARTITION, "notification_id": due.marker},
                condition=Attr("notification_id").exists(),
            )
        except ConditionFailed:
            return False
        return True

    def release(self, due: DueDigest) -> None:
        """Put a claimed window back, so a flush that failed before sending is retried."""
        self._repository.put(
            {
                "ws_user": DUE_PARTITION,
                "notification_id": due.marker,
                "workspace_id": due.workspace_id,
                "recipient_id": due.recipient_id,
                "window": due.window,
                "expires_at": _expiry(datetime.now(timezone.utc)),
            }
        )

    def entries(self, due: DueDigest) -> list[DigestEntry]:
        """Every entry held in one window, oldest first."""
        partition = window_partition(due.workspace_id, due.recipient_id, due.window)
        items: Iterable[Any] = self._repository.iter_query(Key("ws_user").eq(partition), consistent=True)
        return [DigestEntry.model_validate(dict(item)) for item in items]

    def clear(self, due: DueDigest, entries: Iterable[DigestEntry]) -> int:
        """Delete the entries a flush mailed, so a late entry in the same window is mailed alone."""
        partition = window_partition(due.workspace_id, due.recipient_id, due.window)
        return self._repository.delete_many(
            [{"ws_user": partition, "notification_id": entry.notification_id} for entry in entries]
        )
