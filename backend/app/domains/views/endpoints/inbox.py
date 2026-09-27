"""Inbox routes: list, unread count, mark read, mark unread, snooze and delete.

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
"""

from __future__ import annotations

from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Path, Query, Response, status
from webbpulse.http import CursorPage

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.pagination import decode_cursor, encode_cursor
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.inbox import SNOOZE_MAX, Notification
from app.common.issue_keys import display_key
from app.domains.views.schemas.view import (
    INBOX_DEFAULT_LIMIT,
    INBOX_MAX_LIMIT,
    InboxCountRead,
    InboxListRead,
    InboxReadRequest,
    InboxReadResult,
    InboxSnoozeRequest,
    InboxUnreadRequest,
    NotificationRead,
)
from app.domains.views.service import not_found, unprocessable

router = APIRouter()


SNOOZE_MIN = timedelta(minutes=1)


def _scope(workspace_id: str, user_id: str, unread: bool, snoozed: bool = False) -> str:
    """The scope an inbox cursor is stamped with.

    Carries the caller and which list the page came from, so a cursor minted on one
    member's unread page is refused on another member's full page rather than being
    fed back as a start key.
    """
    mode = "unread" if unread else "snoozed" if snoozed else "all"
    return f"inbox:{workspace_id}:{user_id}:{mode}"


@router.get("/{workspace_id}/inbox", response_model=InboxListRead)
def list_inbox(
    workspace_id: str = Path(..., min_length=1),
    unread: bool = Query(default=False),
    snoozed: bool = Query(default=False),
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
    """
    if unread and snoozed:
        raise unprocessable("unread and snoozed cannot be combined")
    scope = _scope(workspace_id, context.user_id, unread, snoozed)
    page = repositories.inbox.list(
        workspace_id,
        context.user_id,
        unread_only=unread,
        snoozed_only=snoozed,
        limit=limit,
        start_key=decode_cursor(cursor, scope),
    )
    rows = [Notification.model_validate(dict(item)) for item in page.items]
    return InboxListRead(
        items=[
            NotificationRead.from_row(
                row.model_copy(
                    update={"issue_key": display_key(repositories.teams, row.workspace_id, row.team_id, row.issue_key)}
                )
            )
            for row in rows
        ],
        next_cursor=encode_cursor(page.last_evaluated_key, scope),
    )


@router.get("/{workspace_id}/inbox/count", response_model=InboxCountRead)
def unread_count(
    workspace_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> InboxCountRead:
    """How many of the caller's notifications are unread, capped at 100.

    Capped because the badge stops meaning anything past that, and counting no
    further keeps a busy inbox costing the same as a quiet one.
    """
    return InboxCountRead(unread=repositories.inbox.unread_count(workspace_id, context.user_id))


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
    if payload.all:
        return InboxReadResult(updated=repositories.inbox.mark_all_read(workspace_id, context.user_id))

    if not payload.notification_ids:
        raise unprocessable("Send notification_ids or all")

    return InboxReadResult(
        updated=repositories.inbox.mark_read(workspace_id, context.user_id, payload.notification_ids)
    )


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
    return InboxReadResult(
        updated=repositories.inbox.mark_unread(workspace_id, context.user_id, payload.notification_ids)
    )


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
    now = utc_now()
    if payload.until < now + SNOOZE_MIN:
        raise unprocessable("until must be in the future")
    if payload.until > now + SNOOZE_MAX:
        raise unprocessable("until must be within 90 days")
    return InboxReadResult(
        updated=repositories.inbox.snooze(workspace_id, context.user_id, payload.notification_ids, payload.until)
    )


@router.delete("/{workspace_id}/inbox/{notification_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_notification(
    workspace_id: str = Path(..., min_length=1),
    notification_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> Response:
    """Remove one of the caller's own notifications, or 404."""
    if not repositories.inbox.delete(workspace_id, context.user_id, notification_id):
        raise not_found()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
