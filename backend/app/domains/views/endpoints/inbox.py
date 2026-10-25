"""Inbox routes: list, unread count, mark read, mark unread, snooze, delete and clear, and issue reminders.

The inbox is per user by construction. The partition key is built from the
authorization context and never from a parameter, so there is no route by which one
member reads another's inbox and no id to guess: a notification id belonging to
someone else simply is not in the caller's partition.

`unread=true` reads the sparse index, which holds only unread rows, so the badge is
a short index query rather than a filtered partition read. Marking read deletes
`unread_at`, which removes the row from that index in the same write.

Snoozing sets `unread_at` to the moment the notification should come back, and every
unread read bounds the index at now, so a snoozed row returns by itself when its time
comes, with no sweep or scheduler to run.

An issue reminder is the caller asking to hear about one issue again at a moment
they pick. It waits under the caller's own reminder partition and the notify
consumer's minute tick turns it into a `reminder` row in this inbox when it comes
due. Setting one only needs to see the issue, since nobody else sees it.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Path, Query, Response, status
from webbpulse.http import CursorPage

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.views import InboxBucket, ReminderEntityType
from app.common.inbox import INBOX_KINDS, inbox_counts, list_notifications
from app.common.inbox import clear_notifications as clear_rows
from app.common.inbox import delete_notification as delete_row
from app.common.inbox import mark_read as mark_rows_read
from app.common.inbox import mark_unread as mark_rows_unread
from app.common.inbox import snooze as snooze_rows
from app.common.issue_reminders import (
    cancel_entity_reminder,
    cancel_reminder,
    list_entity_reminders,
    list_reminders,
    set_entity_reminder,
    set_reminder,
)
from app.domains.views.schemas.view import (
    INBOX_DEFAULT_LIMIT,
    INBOX_MAX_LIMIT,
    InboxClearRequest,
    InboxClearResult,
    InboxCountRead,
    InboxListRead,
    InboxReadRequest,
    InboxReadResult,
    InboxSnoozeRequest,
    InboxUnreadRequest,
    IssueReminderListRead,
    IssueReminderRead,
    IssueReminderWrite,
    NotificationRead,
    ReminderListRead,
    ReminderRead,
)

router = APIRouter()

INBOX_MAX_KINDS = len(INBOX_KINDS)


@router.get("/{workspace_id}/inbox", response_model=InboxListRead)
def list_inbox(
    workspace_id: str = Path(..., min_length=1),
    unread: bool = Query(default=False),
    snoozed: bool = Query(default=False),
    include_snoozed: bool = Query(default=False),
    kind: list[str] = Query(default=[], max_length=INBOX_MAX_KINDS),
    bucket: InboxBucket = Query(default="all"),
    cursor: Optional[str] = Query(default=None),
    limit: int = Query(default=INBOX_DEFAULT_LIMIT, ge=1, le=INBOX_MAX_LIMIT),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> CursorPage[NotificationRead]:
    """The caller's own notifications, newest first.

    A notification whose issue or comment has since been deleted still renders,
    carrying the title it was written with, rather than 404ing a whole list for one
    stale row.

    Snoozed notifications stay out of both lists until their time comes; `snoozed=true`
    lists only them, and is refused beside `unread=true` since nothing is both.
    `include_snoozed=true` keeps snoozed rows in either list, and each repeated
    `kind` keeps only that notification kind. `bucket` keeps the caller's
    Priority or Other tab, by the priority kinds in their notification settings.
    """
    items, next_cursor = list_notifications(
        repositories,
        context,
        unread=unread,
        snoozed=snoozed,
        include_snoozed=include_snoozed,
        kinds=kind,
        bucket=bucket,
        cursor=cursor,
        limit=limit,
    )
    return InboxListRead(items=items, next_cursor=next_cursor)


@router.get("/{workspace_id}/inbox/count", response_model=InboxCountRead)
def unread_count(
    workspace_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> InboxCountRead:
    """How many of the caller's notifications are unread, in all and per tab, each capped at 100.

    Capped because the badge stops meaning anything past that, and counting no
    further keeps a busy inbox costing the same as a quiet one. `badge` counts
    the Priority tab alone while the caller's priority inbox is on.
    """
    return inbox_counts(repositories, context)


@router.post("/{workspace_id}/inbox/read", response_model=InboxReadResult)
def mark_read(
    payload: InboxReadRequest,
    workspace_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> InboxReadResult:
    """Mark some or all of the caller's notifications read.

    Ids that are already read, or that belong to someone else, count as nothing
    changed rather than as an error: the write is conditional on the row being
    unread in this caller's own partition, so a foreign id cannot be reached.
    """
    return InboxReadResult(updated=mark_rows_read(repositories, context, payload))


@router.post("/{workspace_id}/inbox/unread", response_model=InboxReadResult)
def mark_unread(
    payload: InboxUnreadRequest,
    workspace_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> InboxReadResult:
    """Mark some of the caller's notifications unread again, ending any snooze.

    Like mark-read, an id already unread or belonging to someone else counts as
    nothing changed: the write is conditional on the row existing in this caller's
    own partition, so a foreign id cannot be created or reached.
    """
    return InboxReadResult(updated=mark_rows_unread(repositories, context, payload))


@router.post("/{workspace_id}/inbox/snooze", response_model=InboxReadResult)
def snooze(
    payload: InboxSnoozeRequest,
    workspace_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> InboxReadResult:
    """Hide some of the caller's notifications until a moment, when they return unread.

    The moment must be at least a minute out and within the 90 day retention, so a
    snooze can neither return before the request lands nor outlive the row.
    """
    return InboxReadResult(updated=snooze_rows(repositories, context, payload))


@router.post("/{workspace_id}/inbox/clear", response_model=InboxClearResult)
def clear_inbox(
    payload: InboxClearRequest,
    workspace_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> InboxClearResult:
    """Delete the caller's own notifications in bulk: the read ones, those about finished issues, or all.

    Only the caller's own partition is read, so nothing in anyone else's inbox can
    match. `kinds` narrows it as the list's filter does, `completed_only` keeps to
    rows whose issue is completed or cancelled, and a row still snoozed goes only
    when the clear sends `include_snoozed`.
    """
    return InboxClearResult(deleted=clear_rows(repositories, context, payload))


@router.get("/{workspace_id}/inbox/reminders", response_model=IssueReminderListRead)
def list_issue_reminders(
    workspace_id: str = Path(..., min_length=1),
    issue_id: Optional[str] = Query(default=None, min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> IssueReminderListRead:
    """The caller's pending issue reminders, soonest first, or the one on `issue_id`.

    A reminder on an issue that is gone or no longer visible is left out.
    """
    return IssueReminderListRead(reminders=list_reminders(repositories, context, issue_id))


@router.put("/{workspace_id}/inbox/reminders/{issue_id}", response_model=IssueReminderRead)
def set_issue_reminder(
    payload: IssueReminderWrite,
    workspace_id: str = Path(..., min_length=1),
    issue_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> IssueReminderRead:
    """Remind the caller about one issue at `remind_at`, replacing any reminder already set on it.

    The moment must carry a timezone and be between a minute and 365 days out. An
    issue the caller cannot see is a 404.
    """
    return set_reminder(repositories, context, issue_id, payload)


@router.delete("/{workspace_id}/inbox/reminders/{issue_id}", status_code=status.HTTP_204_NO_CONTENT)
def cancel_issue_reminder(
    workspace_id: str = Path(..., min_length=1),
    issue_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> Response:
    """Cancel the caller's pending reminder on one issue, or 404 when none is pending."""
    cancel_reminder(repositories, context, issue_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{workspace_id}/inbox/entity-reminders", response_model=ReminderListRead)
def list_reminders_on_entities(
    workspace_id: str = Path(..., min_length=1),
    entity_type: Optional[ReminderEntityType] = Query(default=None),
    entity_id: Optional[str] = Query(default=None, min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> ReminderListRead:
    """The caller's pending reminders on issues, projects, initiatives and documents, soonest first.

    `entity_type` narrows to one kind, and with `entity_id` to one subject. A
    reminder on a subject that is gone or no longer readable is left out.
    """
    return ReminderListRead(reminders=list_entity_reminders(repositories, context, entity_type, entity_id))


@router.put("/{workspace_id}/inbox/entity-reminders/{entity_type}/{entity_id}", response_model=ReminderRead)
def set_reminder_on_entity(
    payload: IssueReminderWrite,
    workspace_id: str = Path(..., min_length=1),
    entity_type: ReminderEntityType = Path(...),
    entity_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> ReminderRead:
    """Remind the caller about one issue, project, initiative or document at `remind_at`, replacing any set.

    The moment must carry a timezone and be between a minute and 365 days out. A
    subject the caller cannot read is a 404.
    """
    return set_entity_reminder(repositories, context, entity_type, entity_id, payload)


@router.delete(
    "/{workspace_id}/inbox/entity-reminders/{entity_type}/{entity_id}", status_code=status.HTTP_204_NO_CONTENT
)
def cancel_reminder_on_entity(
    workspace_id: str = Path(..., min_length=1),
    entity_type: ReminderEntityType = Path(...),
    entity_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> Response:
    """Cancel the caller's pending reminder on one subject, or 404 when none is pending."""
    cancel_entity_reminder(repositories, context, entity_type, entity_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/{workspace_id}/inbox/{notification_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_notification(
    workspace_id: str = Path(..., min_length=1),
    notification_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> Response:
    """Remove one of the caller's own notifications, or 404."""
    delete_row(repositories, context, notification_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
