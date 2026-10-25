"""The notification digest flush: one email per recipient per five minute window.

The notify consumer writes inbox rows at once and holds their emails as digest
entries. An EventBridge Scheduler schedule invokes the notify consumer every
minute with one synthetic record, the consumer route hands it here, and every
window that closed at least `FLUSH_GRACE` ago is claimed, rendered and mailed.

Claiming is a conditional delete of the window's due marker, so two overlapping
flushes never mail one window twice. A failure before the send puts the marker
back for the next run; the send itself never raises. The recipient's email
preference and team visibility are checked again here, so switching email off
or losing access during the window is honoured, and so is each entry's inbox
row: one read, archived or deleted before the flush is dropped from the email,
and a window with nothing left sends nothing, as in Linear.

A person who chose immediate email skips the window: `send_immediately` mails
each notification on its own as it is written.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from webbpulse.identity.email import EmailMessage

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.notify_digests import DigestEntry, DueDigest
from app.common.email import deliver
from app.domains.views.email import render_digest

_log = logging.getLogger(__name__)

NOTIFY_DIGEST_SOURCE = "standupless.notify-digest"
"""The `eventSource` the flush schedule's synthetic record carries."""

FLUSH_GRACE = timedelta(seconds=30)
"""How long after a window closes before it is flushed.

Covers an entry whose window was read off the clock just before it closed and
written just after, so it lands in the email rather than in a second one.
"""

FLUSH_BATCH = 50
"""The most windows one flush mails, so a backlog never runs a flush past its timeout.

Whatever is left is the oldest work for the next run a minute later.
"""


def is_digest_flush(record: Mapping[str, Any]) -> bool:
    """Whether one record is the flush schedule's trigger rather than a stream record."""
    return str(record.get("eventSource", "")) == NOTIFY_DIGEST_SOURCE


@dataclass
class FlushSummary:
    """What one flush did, for the log line and the tests."""

    windows: int = 0
    sent: int = 0
    skipped: int = 0
    failed: int = 0


def still_unhandled(repositories: Repositories, entry: DigestEntry) -> bool:
    """Whether the inbox row behind one held entry is still there and, when it was held unread, still unread."""
    if entry.unread_when_held is None:
        return True
    row = repositories.inbox.get(entry.workspace_id, entry.recipient_id, entry.notification_id)
    if row is None:
        return False
    return row.unread_at is not None or not entry.unread_when_held


def _compose(
    repositories: Repositories,
    workspace_id: str,
    recipient_id: str,
    entries: list[DigestEntry],
    *,
    check_inbox: bool = True,
) -> EmailMessage | None:
    """The one email some held entries become, or `None` when nothing in them should still be mailed.

    `check_inbox` drops entries whose inbox row was handled since; an immediate
    send skips it, because its row was written a moment ago.
    """
    from app.domains.views.consumers.notify import can_receive

    if not entries:
        return None
    recipient = repositories.users.get(recipient_id)
    if recipient is None or recipient.disabled:
        return None
    workspace = repositories.workspaces.get(workspace_id)
    if workspace is None:
        return None

    visible_teams: dict[str, bool] = {}
    kept: list[DigestEntry] = []
    for entry in entries:
        if not recipient.wants_notification(entry.kind, "email"):
            continue
        if entry.team_id not in visible_teams:
            visible_teams[entry.team_id] = can_receive(repositories, workspace_id, entry.team_id, recipient_id)
        if not visible_teams[entry.team_id]:
            continue
        if check_inbox and not still_unhandled(repositories, entry):
            continue
        kept.append(entry)
    if not kept:
        return None
    return render_digest(kept, to=str(recipient.email), workspace_slug=workspace.slug, accent=workspace.accent_color)


def _send(message: EmailMessage | None) -> bool:
    """Hand one composed email to SES, answering whether there was one to send."""
    if message is None:
        return False
    kind = message.tags.get("kind", "digest") if message.tags else "digest"
    return deliver(message, event=f"views.notify.email.{kind}")


def send_immediately(repositories: Repositories, entry: DigestEntry) -> bool:
    """Mail one notification on its own now, for a person who chose immediate email."""
    return _send(_compose(repositories, entry.workspace_id, entry.recipient_id, [entry], check_inbox=False))


def flush_window(repositories: Repositories, due: DueDigest) -> bool:
    """Claim, mail and clear one due window, answering whether an email was handed to SES.

    A window another flush already claimed is left alone. The entries are cleared
    after the send, so an entry that arrives late in the same window re-opens the
    marker and is mailed on its own rather than repeating what already went.
    """
    store = repositories.inbox.digests
    if not store.claim(due):
        return False
    try:
        entries = store.entries(due)
        message = _compose(repositories, due.workspace_id, due.recipient_id, entries)
    except Exception:
        store.release(due)
        raise
    sent = _send(message)
    store.clear(due, entries)
    return sent


def flush_due(repositories: Repositories, now: datetime | None = None) -> FlushSummary:
    """Mail every window that closed at least `FLUSH_GRACE` before `now`, oldest first.

    One window failing is logged and skipped, so it never holds up the rest.
    """
    moment = now or datetime.now(timezone.utc)
    summary = FlushSummary()
    for due in repositories.inbox.digests.due(moment - FLUSH_GRACE, limit=FLUSH_BATCH):
        summary.windows += 1
        try:
            if flush_window(repositories, due):
                summary.sent += 1
            else:
                summary.skipped += 1
        except Exception:
            summary.failed += 1
            _log.exception(
                "A notification digest failed to flush.",
                extra={"event": "views.notify.digest_failed", "workspace_id": due.workspace_id},
            )
    if summary.windows:
        _log.info(
            "Flushed notification digests.",
            extra={
                "event": "views.notify.digest",
                "windows": summary.windows,
                "sent": summary.sent,
                "skipped": summary.skipped,
                "failed": summary.failed,
            },
        )
    return summary
