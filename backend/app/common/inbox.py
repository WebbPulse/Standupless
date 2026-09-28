"""The inbox reads and writes, shared by the inbox routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code. The inbox is per user by construction: every call here builds the partition
from the authorization context and never from an argument, so a notification id
belonging to someone else is simply not in the caller's partition.

Snoozing sets `unread_at` to the moment the notification should come back, and
every unread read bounds the index at now, so a snoozed row returns by itself.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Optional

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import decode_cursor, encode_cursor
from app.common.api.schemas.views import InboxReadRequest, InboxSnoozeRequest, InboxUnreadRequest, NotificationRead
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.inbox import SNOOZE_MAX, Notification
from app.common.issue_keys import display_key
from app.common.issue_rules import not_found, unprocessable

SNOOZE_MIN = timedelta(minutes=1)


def cursor_scope(workspace_id: str, user_id: str, unread: bool, snoozed: bool = False) -> str:
    """The scope an inbox cursor is stamped with.

    Carries the caller and which list the page came from, so a cursor minted on one
    member's unread page is refused on another member's full page.
    """
    mode = "unread" if unread else "snoozed" if snoozed else "all"
    return f"inbox:{workspace_id}:{user_id}:{mode}"


def list_notifications(
    repositories: Repositories,
    context: AuthzContext,
    *,
    unread: bool,
    snoozed: bool,
    cursor: Optional[str],
    limit: int,
) -> tuple[list[NotificationRead], Optional[str]]:
    """One page of the caller's own notifications, newest first, with the next cursor.

    Snoozed notifications stay out of both lists until their time comes, and
    `snoozed` lists only them, so it cannot be combined with `unread`.
    """
    if unread and snoozed:
        raise unprocessable("unread and snoozed cannot be combined")
    workspace_id = context.workspace_id
    scope = cursor_scope(workspace_id, context.user_id, unread, snoozed)
    page = repositories.inbox.list(
        workspace_id,
        context.user_id,
        unread_only=unread,
        snoozed_only=snoozed,
        limit=limit,
        start_key=decode_cursor(cursor, scope),
    )
    rows = [Notification.model_validate(dict(item)) for item in page.items]
    items = [
        NotificationRead.from_row(
            row.model_copy(
                update={"issue_key": display_key(repositories.teams, row.workspace_id, row.team_id, row.issue_key)}
            )
        )
        for row in rows
    ]
    return items, encode_cursor(page.last_evaluated_key, scope)


def mark_read(repositories: Repositories, context: AuthzContext, payload: InboxReadRequest) -> int:
    """Mark some or all of the caller's notifications read, answering how many moved.

    An id already read, or belonging to someone else, counts as nothing changed.
    """
    if payload.all:
        return repositories.inbox.mark_all_read(context.workspace_id, context.user_id)
    if not payload.notification_ids:
        raise unprocessable("Send notification_ids or all")
    return repositories.inbox.mark_read(context.workspace_id, context.user_id, payload.notification_ids)


def mark_unread(repositories: Repositories, context: AuthzContext, payload: InboxUnreadRequest) -> int:
    """Mark some of the caller's notifications unread again, ending any snooze."""
    return repositories.inbox.mark_unread(context.workspace_id, context.user_id, payload.notification_ids)


def snooze(repositories: Repositories, context: AuthzContext, payload: InboxSnoozeRequest) -> int:
    """Hide some of the caller's notifications until a moment, when they return unread.

    The moment must be at least a minute out and within the 90 day retention, so a
    snooze can neither return before the request lands nor outlive the row.
    """
    now = utc_now()
    if payload.until < now + SNOOZE_MIN:
        raise unprocessable("until must be in the future")
    if payload.until > now + SNOOZE_MAX:
        raise unprocessable("until must be within 90 days")
    return repositories.inbox.snooze(context.workspace_id, context.user_id, payload.notification_ids, payload.until)


def delete_notification(repositories: Repositories, context: AuthzContext, notification_id: str) -> None:
    """Remove one of the caller's own notifications, or 404."""
    if not repositories.inbox.delete(context.workspace_id, context.user_id, notification_id):
        raise not_found()
