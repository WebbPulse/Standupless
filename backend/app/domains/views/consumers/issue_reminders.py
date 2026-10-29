"""Delivers the reminders members set for themselves, run on every digest flush tick.

A member asks to be reminded about an issue, project, initiative or document at a
moment they choose. The flush
schedule ticks every minute, so each tick reads the due markers up to now and
turns each into one `reminder` row in the member's inbox, with the email held for
their digest when they want reminder emails. Unlike the hourly sweeps there is no
window to claim: the due partition only ever holds what is owed, so a tick with
nothing due costs one query. A reminder on a project, initiative or document
lands in the inbox alone, as a document comment does: the reminder emails speak of
an issue, and a member who set one is looking at the inbox for it.

Each marker is claimed with a conditional delete, so overlapping ticks deliver a
reminder once. The inbox row's id is a function of the subject and the moment, so
a tick that dies after the write and before the cleanup repeats as a no-op. A
reminder whose subject is gone, whose workspace is being purged, or whose member
can no longer see the subject is dropped rather than retried. Delivery is deterministic:
no model is asked anything.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.inbox import (
    ISSUE_REMINDER,
    Notification,
    expires_at,
    inbox_partition,
    instant,
    notification_id,
)
from app.common.db.dynamo.issue_reminders import DueReminder
from app.common.team_privacy import person_can_see_initiative
from app.domains.views.consumers.document_comments import can_read_document
from app.domains.views.consumers.notify import receiving_team, write_notification

DELIVERY_BATCH = 100
"""How many due reminders one tick delivers before leaving the rest to the next tick."""

_log = logging.getLogger(__name__)


def _subject_fields(repositories: Repositories, due: DueReminder) -> dict[str, Any] | None:
    """The inbox fields naming a project, initiative or document the member may still see, or `None`."""
    workspace_id, user_id = due.workspace_id, due.user_id
    if due.entity_type == "project":
        project = repositories.planning.get_project(workspace_id, due.entity_id)
        if project is None:
            return None
        team_id = receiving_team(repositories, project, user_id)
        if not team_id:
            return None
        return {"team_id": team_id, "project_id": project.project_id, "project_name": project.name}
    if due.entity_type == "initiative":
        initiative = repositories.planning.get_initiative(workspace_id, due.entity_id)
        if initiative is None or not person_can_see_initiative(repositories, initiative, user_id):
            return None
        return {"team_id": "", "initiative_id": initiative.initiative_id, "initiative_name": initiative.name}
    found = repositories.documents.get(workspace_id, due.entity_id)
    if found is None:
        return None
    document = found[0]
    if not can_read_document(repositories, document, user_id):
        return None
    return {"team_id": "", "document_id": document.document_id, "document_title": document.title}


def _deliver_entity(repositories: Repositories, due: DueReminder) -> bool:
    """Write one due reminder on a project, initiative or document into its member's inbox."""
    fields = _subject_fields(repositories, due)
    if fields is None:
        return False
    recipient = repositories.users.get(due.user_id)
    if recipient is not None and not recipient.wants_notification(ISSUE_REMINDER, "in_app"):
        return False
    stamped = due.remind_at
    source_id = f"{due.subject}#{instant(due.remind_at)}"
    row = Notification(
        ws_user=inbox_partition(due.workspace_id, due.user_id),
        notification_id=notification_id(stamped, ISSUE_REMINDER, due.user_id, source_id),
        workspace_id=due.workspace_id,
        kind=ISSUE_REMINDER,
        actor_id="",
        actor_name="",
        recipient_id=due.user_id,
        created_at=stamped,
        unread_at=stamped.isoformat(),
        expires_at=expires_at(stamped),
        **fields,
    )
    return repositories.inbox.create(row)


def _deliver(repositories: Repositories, due: DueReminder) -> bool:
    """Write one due reminder into its member's inbox, answering whether a row was written."""
    pending = repositories.inbox.reminders.get(due.workspace_id, due.user_id, due.entity_id, due.entity_type)
    if pending is None or instant(pending.remind_at) != instant(due.remind_at):
        return False
    workspace = repositories.workspaces.get(due.workspace_id)
    if workspace is None or workspace.is_purging:
        repositories.inbox.reminders.finish(due)
        return False
    if due.entity_type != "issue":
        written = _deliver_entity(repositories, due)
        repositories.inbox.reminders.finish(due)
        return written
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
                "Failed to deliver a reminder; it is retried on the next tick.",
                extra={"event": "views.issue_reminders.failed", "workspace_id": due.workspace_id},
            )
    if written:
        _log.info("Delivered issue reminders.", extra={"event": "views.issue_reminders", "written": written})
    return written
