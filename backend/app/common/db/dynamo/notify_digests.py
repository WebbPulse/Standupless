"""Pending notification emails, held in the `inbox` table until their digest is flushed.

Email is coalesced into one message per recipient per workspace per five minute
window. Each notification that should be mailed becomes an entry row in a window
partition, and the first entry of a window also writes a due marker into one
shared partition, keyed by the moment the window closes. A scheduled flush reads
the due markers, claims each with a conditional delete, and mails the window's
entries as one message. An urgent entry also writes a marker due at once, so
its window goes out on the next flush and the window's own marker later finds
nothing left to send.

An entry for a person who paused notifications or is outside their working
hours is held instead, in one held window per recipient per workspace, and a
held marker in its own partition names that window. The flush reads every held
marker, re-reads the person, and mails a window once they may be reached again,
so resuming early, changing the schedule or extending a pause all take effect
on the next run without anything having to be rescheduled.

The rows live in the `inbox` table under partitions no member's inbox can name,
because an inbox partition is always `<workspace>#<user>` built from the caller's
own context. That keeps the pending state inside the grant the notify consumer
already holds, and the table's TTL drops anything a flush never reached.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from itertools import islice
from typing import Any, Iterable

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
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

HELD_PARTITION = "digest#held"
"""The partition naming every recipient whose emails wait for a pause or working hours to end."""

HELD_WINDOW = 0
"""The window number a recipient's held entries are kept under, which no real window starts at."""

HELD_RETENTION = timedelta(days=32)
"""How long a held row survives, which outlasts the longest pause a person may set."""

HELD_SCAN = 1000
"""The most held markers one flush reads, so a large pile of paused people costs a bounded read."""

_ENTRY_PREFIX = "digest#"

_EPOCH_WIDTH = 12


CHAT_DIGEST_WINDOW = timedelta(minutes=2)
"""How long chat direct messages to one recipient are gathered before one message goes out.

Shorter than the email window because a chat message is expected sooner, while
still turning a burst of edits into one message.
"""

CHAT_DUE_PARTITION = "chatdigest#due"

CHAT_ENTRY_PREFIX = "chatdigest#"


def window_start(moment: datetime, width: timedelta = DIGEST_WINDOW) -> int:
    """The epoch second the fixed window of `width` holding `moment` opens at."""
    seconds = int(moment.timestamp())
    span = int(width.total_seconds())
    return seconds - seconds % span


def window_partition(workspace_id: str, recipient_id: str, window: int, prefix: str = _ENTRY_PREFIX) -> str:
    """The partition one recipient's entries for one window are written to."""
    return f"{prefix}{workspace_id}#{recipient_id}#{window}"


def _expiry(moment: datetime) -> int:
    """The TTL stamp for a pending row written at `moment`."""
    return int((moment + DIGEST_RETENTION).timestamp())


class DigestEntry(BaseModel):
    """One notification waiting to be mailed, carrying everything its line in the email needs.

    The fields are captured when the inbox row is written, so the flush renders
    without reading the issue or the project again. `kind` and `team_id` are kept
    so the flush can re-check the recipient's preference and visibility.
    `unread_when_held` says whether the inbox row was unread when the entry was
    held, so the flush can drop one the person has since read; `None` marks an
    entry with no inbox row to check. `comment_id` is the comment a comment
    notification is about, which a reply to its email threads under.
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
    comment_id: str = ""
    excerpt: str = ""
    project_id: str = ""
    project_name: str = ""
    health: str = ""
    initiative_id: str = ""
    initiative_name: str = ""
    due_state: str = ""
    report: list[str] = Field(default_factory=list)
    unread_when_held: bool | None = None
    created_at: datetime


class DueDigest(BaseModel):
    """One window whose entries are ready to be mailed.

    `partition` is where its marker lives: empty for the store's own due
    partition, or the held partition for a window waiting on a pause.
    """

    workspace_id: str
    recipient_id: str
    window: int
    marker: str
    partition: str = ""


class DigestStore:
    """Writes pending digest entries and hands due windows to the flush.

    The email digest uses the defaults. The chat direct message digest builds a
    second store over its own partitions and a shorter window, so the two flushes
    never claim each other's windows.
    """

    def __init__(
        self,
        repository: Repository,
        *,
        prefix: str = _ENTRY_PREFIX,
        due_partition: str = DUE_PARTITION,
        window: timedelta = DIGEST_WINDOW,
    ) -> None:
        """Share the `inbox` table's package repository under one set of partitions."""
        self._repository = repository
        self._prefix = prefix
        self._due_partition = due_partition
        self._window = window

    def add(self, entry: DigestEntry, now: datetime | None = None, *, expedite: bool = False) -> int:
        """Hold one entry in its recipient's open window, answering that window.

        The entry is keyed by its notification id, so a second add of the same
        notification overwrites rather than duplicates. The due marker is written
        only when it is not already there, so a busy window costs one marker.
        `expedite` also marks the window due now, so the next flush mails it
        without waiting for the window to close.
        """
        moment = now or datetime.now(timezone.utc)
        window = window_start(moment, self._window)
        partition = window_partition(entry.workspace_id, entry.recipient_id, window, self._prefix)
        self._repository.put(as_item(entry, ws_user=partition, expires_at=_expiry(moment)))

        self._mark_due(entry, window, window + int(self._window.total_seconds()), moment)
        if expedite:
            self._mark_due(entry, window, int(moment.timestamp()), moment)
        return window

    def _mark_due(self, entry: DigestEntry, window: int, due_at: int, moment: datetime) -> None:
        """Write one due marker for a window unless that exact marker is already there."""
        marker = f"{due_at:0{_EPOCH_WIDTH}d}#{entry.workspace_id}#{entry.recipient_id}#{window}"
        try:
            self._repository.put(
                {
                    "ws_user": self._due_partition,
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

    def hold(self, entry: DigestEntry, now: datetime | None = None) -> None:
        """Keep one entry until its recipient may be reached again, in their held window.

        The marker is written every time rather than only when missing, so its
        TTL follows the newest entry and a long pause never loses its marker
        while entries remain.
        """
        moment = now or datetime.now(timezone.utc)
        expiry = int((moment + HELD_RETENTION).timestamp())
        partition = window_partition(entry.workspace_id, entry.recipient_id, HELD_WINDOW, self._prefix)
        self._repository.put(as_item(entry, ws_user=partition, expires_at=expiry))
        self._repository.put(
            {
                "ws_user": HELD_PARTITION,
                "notification_id": f"{entry.workspace_id}#{entry.recipient_id}",
                "workspace_id": entry.workspace_id,
                "recipient_id": entry.recipient_id,
                "window": HELD_WINDOW,
                "expires_at": expiry,
            }
        )

    def held(self, *, limit: int = HELD_SCAN) -> list[DueDigest]:
        """Every recipient with held entries, at most `limit` of them, for the flush to re-check."""
        items: Iterable[Any] = self._repository.iter_query(Key("ws_user").eq(HELD_PARTITION), consistent=True)
        return [
            DueDigest(
                workspace_id=str(item["workspace_id"]),
                recipient_id=str(item["recipient_id"]),
                window=int(item["window"]),
                marker=str(item["notification_id"]),
                partition=HELD_PARTITION,
            )
            for item in islice(items, limit)
        ]

    def due(self, cutoff: datetime, *, limit: int) -> list[DueDigest]:
        """The oldest windows that closed at or before `cutoff`, at most `limit` of them."""
        bound = f"{int(cutoff.timestamp()):0{_EPOCH_WIDTH}d}~"
        page = self._repository.query(
            Key("ws_user").eq(self._due_partition) & Key("notification_id").lte(bound),
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
                {"ws_user": due.partition or self._due_partition, "notification_id": due.marker},
                condition=Attr("notification_id").exists(),
            )
        except ConditionFailed:
            return False
        return True

    def release(self, due: DueDigest) -> None:
        """Put a claimed window back, so a flush that failed before sending is retried."""
        self._repository.put(
            {
                "ws_user": due.partition or self._due_partition,
                "notification_id": due.marker,
                "workspace_id": due.workspace_id,
                "recipient_id": due.recipient_id,
                "window": due.window,
                "expires_at": _expiry(datetime.now(timezone.utc)),
            }
        )

    def entries(self, due: DueDigest) -> list[DigestEntry]:
        """Every entry held in one window, oldest first."""
        partition = window_partition(due.workspace_id, due.recipient_id, due.window, self._prefix)
        items: Iterable[Any] = self._repository.iter_query(Key("ws_user").eq(partition), consistent=True)
        return [DigestEntry.model_validate(dict(item)) for item in items]

    def clear(self, due: DueDigest, entries: Iterable[DigestEntry]) -> int:
        """Delete the entries a flush mailed, so a late entry in the same window is mailed alone."""
        partition = window_partition(due.workspace_id, due.recipient_id, due.window, self._prefix)
        return self._repository.delete_many(
            [{"ws_user": partition, "notification_id": entry.notification_id} for entry in entries]
        )
