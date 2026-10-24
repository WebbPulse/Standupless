"""Chat direct messages for personal notifications: held per recipient, flushed as one message.

A member who linked a chat account gets the notifications they want on the `chat`
channel as direct messages from the Standupless bot. Each one is held as an entry
in a short window, in the same shape the email digest uses but under its own
partitions, and the per minute flush turns every closed window into one dispatch
job. The integrations dispatch consumer sends it, because only that image holds
the bot token.

The flush checks the preference, the route and team visibility again, so a member
who switched chat off, unlinked or lost access during the window hears nothing.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from app.common.api.dependencies.repositories import Repositories
from app.common.chat_digests import (
    CHAT_DIGEST_LINE_LIMIT,
    CHAT_KINDS,
    ChatDigest,
    ChatDigestGroup,
    queue_chat_digest,
)
from app.common.db.dynamo.inbox import Notification
from app.common.db.dynamo.notify_digests import DigestEntry, DueDigest
from app.common.db.dynamo.users import User

_log = logging.getLogger(__name__)

FLUSH_GRACE = timedelta(seconds=30)
"""How long after a window closes before it is flushed, as the email digest waits."""

FLUSH_BATCH = 100
"""The most windows one flush queues, so a backlog never runs a flush past its timeout."""


def wants_chat(repositories: Repositories, recipient: User | None, kind: str, workspace_id: str) -> bool:
    """Whether one notification should also go to the recipient's chat direct messages.

    Only a kind chat carries, a switch left on, and a linked route that is not
    broken. The route read is skipped whenever the switch already answers no.
    """
    if recipient is None or recipient.disabled or kind not in CHAT_KINDS:
        return False
    if not recipient.wants_notification(kind, "chat"):
        return False
    return bool(repositories.inbox.chat_routes.active(workspace_id, recipient.id))


def hold_for_chat(repositories: Repositories, row: Notification, **fields: Any) -> None:
    """Hold one inbox row that was just written for the recipient's next chat message."""
    from app.domains.views.consumers.notify import digest_entry

    repositories.inbox.chat_digests.add(digest_entry(row, **fields))


def compose(repositories: Repositories, due: DueDigest, entries: list[DigestEntry]) -> ChatDigest | None:
    """The one chat message a window becomes, or `None` when nothing in it should still be sent."""
    from app.domains.views.consumers.notify import can_receive
    from app.domains.views.email import _entry_group, _entry_line, _inbox_url

    if not entries:
        return None
    recipient = repositories.users.get(due.recipient_id)
    if not recipient or recipient.disabled or recipient.is_deleted:
        return None
    if not repositories.inbox.chat_routes.active(due.workspace_id, due.recipient_id):
        return None
    workspace = repositories.workspaces.get(due.workspace_id)
    if workspace is None:
        return None

    visible: dict[str, bool] = {}
    groups: dict[str, ChatDigestGroup] = {}
    kept = 0
    more = 0
    for entry in sorted(entries, key=lambda item: item.created_at):
        if entry.kind not in CHAT_KINDS or not recipient.wants_notification(entry.kind, "chat"):
            continue
        if entry.team_id not in visible:
            visible[entry.team_id] = can_receive(repositories, due.workspace_id, entry.team_id, due.recipient_id)
        if not visible[entry.team_id]:
            continue
        if kept >= CHAT_DIGEST_LINE_LIMIT:
            more += 1
            continue
        key, label, url = _entry_group(entry, workspace.slug)
        group = groups.setdefault(key, ChatDigestGroup(label=label, url=url))
        group.lines.append(_entry_line(entry))
        kept += 1
    if not kept:
        return None
    return ChatDigest(
        workspace_id=due.workspace_id,
        recipient_id=due.recipient_id,
        window=due.window,
        workspace_name=workspace.name,
        inbox_url=_inbox_url(workspace.slug),
        groups=list(groups.values()),
        more=more,
    )


def flush_window(repositories: Repositories, due: DueDigest) -> bool:
    """Claim, queue and clear one due window, answering whether a job was queued.

    A failure before the job is queued puts the window back for the next run.
    """
    store = repositories.inbox.chat_digests
    if not store.claim(due):
        return False
    try:
        entries = store.entries(due)
        digest = compose(repositories, due, entries)
        queued = queue_chat_digest(digest) if digest is not None else False
    except Exception:
        store.release(due)
        raise
    store.clear(due, entries)
    return queued


def flush_due_chats(repositories: Repositories, now: datetime | None = None) -> int:
    """Queue every chat window that closed at least `FLUSH_GRACE` before `now`, answering how many went.

    One window failing is logged and skipped, so it never holds up the rest.
    """
    moment = now or datetime.now(timezone.utc)
    queued = 0
    failed = 0
    windows = repositories.inbox.chat_digests.due(moment - FLUSH_GRACE, limit=FLUSH_BATCH)
    for due in windows:
        try:
            if flush_window(repositories, due):
                queued += 1
        except Exception:
            failed += 1
            _log.exception(
                "A chat notification digest failed to flush.",
                extra={"event": "views.notify.chat_digest_failed", "workspace_id": due.workspace_id},
            )
    if windows:
        _log.info(
            "Flushed chat notification digests.",
            extra={
                "event": "views.notify.chat_digest",
                "windows": len(windows),
                "queued": queued,
                "failed": failed,
            },
        )
    return queued
