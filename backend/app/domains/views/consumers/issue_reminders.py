"""Delivers the issue reminders members set for themselves, run on every digest flush tick.

A member asks to be reminded about an issue at a moment they choose. The flush
schedule ticks every minute, so each tick reads the due markers up to now and
turns each into one `reminder` row in the member's inbox, with the email held for
their digest when they want reminder emails. Unlike the hourly sweeps there is no
window to claim: the due partition only ever holds what is owed, so a tick with
nothing due costs one query.

Each marker is claimed with a conditional delete, so overlapping ticks deliver a
reminder once. The inbox row's id is a function of the issue and the moment, so a
tick that dies after the write and before the cleanup repeats as a no-op. A
reminder whose issue is gone, whose workspace is being purged, or whose member can
no longer see the issue is dropped rather than retried. Delivery is deterministic:
no model is asked anything.
"""

from __future__ import annotations

import logging
from datetime import datetime

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.inbox import ISSUE_REMINDER, instant
from app.common.db.dynamo.issue_reminders import DueReminder
from app.domains.views.consumers.notify import write_notification

DELIVERY_BATCH = 100
"""How many due reminders one tick delivers before leaving the rest to the next tick."""

_log = logging.getLogger(__name__)


def _deliver(repositories: Repositories, due: DueReminder) -> bool:
    """Write one due reminder into its member's inbox, answering whether a row was written."""
    pending = repositories.inbox.reminders.get(due.workspace_id, due.user_id, due.issue_id)
    if pending is None or instant(pending.remind_at) != instant(due.remind_at):
        return False
    workspace = repositories.workspaces.get(due.workspace_id)
    if workspace is None or workspace.is_purging:
        repositories.inbox.reminders.finish(due)
        return False
    issue = repositories.issues.get(due.workspace_id, due.issue_id)
    if issue is None:
        repositories.inbox.reminders.finish(due)
        return False
    written = write_notification(
        repositories,
        workspace_id=due.workspace_id,
        recipient_id=due.user_id,
        kind=ISSUE_REMINDER,
        issue=issue,
        comment_id=None,
        actor_id="",
        actor_display="",
        created_at=due.remind_at,
        source_id=f"{due.issue_id}#{instant(due.remind_at)}",
    )
    repositories.inbox.reminders.finish(due)
    return written


def run_issue_reminders(repositories: Repositories, now: datetime) -> int:
    """Deliver every reminder due by `now`, up to one batch, answering how many rows were written."""
    written = 0
    for due in repositories.inbox.reminders.due(now, limit=DELIVERY_BATCH):
        if not repositories.inbox.reminders.claim(due):
            continue
        try:
            if _deliver(repositories, due):
                written += 1
        except Exception:
            repositories.inbox.reminders.release(due)
            _log.exception(
                "Failed to deliver an issue reminder; it is retried on the next tick.",
                extra={"event": "views.issue_reminders.failed", "workspace_id": due.workspace_id},
            )
    if written:
        _log.info("Delivered issue reminders.", extra={"event": "views.issue_reminders", "written": written})
    return written
