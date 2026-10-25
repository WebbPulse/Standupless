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
from typing import Optional, Sequence, get_args

from webbpulse.dynamodb import encode_start_key

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import resume_key
from app.common.api.schemas.views import (
    InboxBucket,
    InboxClearRequest,
    InboxCountRead,
    InboxReadRequest,
    InboxSnoozeRequest,
    InboxUnreadRequest,
    NotificationRead,
)
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.inbox import SNOOZE_MAX, Notification, NotificationKind
from app.common.db.dynamo.users import DEFAULT_PRIORITY_KINDS
from app.common.issue_keys import display_key
from app.common.issue_rules import COMPLETED_CATEGORIES, not_found, status_categories, unprocessable

SNOOZE_MIN = timedelta(minutes=1)
INBOX_KINDS: tuple[str, ...] = (
    *get_args(NotificationKind),
    "channel_disabled",
    "export_ready",
    "export_failed",
    "import_ready",
    "import_failed",
    "app_approval_requested",
    "app_approval_decided",
)
"""Every kind an inbox row can carry: the member facing ones plus the workspace notices."""

INBOX_BUCKETS: tuple[str, ...] = ("all", "priority", "other")
"""The tabs a read or a bulk action may keep to: both, Priority or Other."""


def priority_kinds(repositories: Repositories, context: AuthzContext) -> tuple[bool, frozenset[str]]:
    """Whether the caller splits their inbox, and the kinds their Priority tab holds.

    A caller with no person row, such as a workspace key, gets the defaults.
    """
    user = repositories.users.get(context.user_id) if context.user_id else None
    if user is None:
        return True, DEFAULT_PRIORITY_KINDS
    return bool(user.priority_inbox), frozenset(kind for kind in INBOX_KINDS if user.is_priority(kind))


def bucket_kinds(
    repositories: Repositories, context: AuthzContext, bucket: str, kinds: Sequence[str]
) -> Optional[tuple[str, ...]]:
    """The kinds a read keeps to once `bucket` narrows `kinds`, or `None` when nothing can match.

    `all` leaves `kinds` as sent. Priority keeps the caller's priority kinds and
    Other every kind but those, each within `kinds` when it names any.
    """
    if bucket not in INBOX_BUCKETS:
        raise unprocessable(f"Unknown inbox bucket: {bucket}")
    wanted = tuple(dict.fromkeys(kinds))
    if bucket == "all":
        return wanted
    _, priority = priority_kinds(repositories, context)
    within = wanted or INBOX_KINDS
    narrowed = tuple(kind for kind in within if (kind in priority) == (bucket == "priority"))
    return narrowed or None


def inbox_counts(repositories: Repositories, context: AuthzContext) -> InboxCountRead:
    """The caller's unread counts: everything, each tab of the split inbox, and the sidebar badge."""
    split, priority = priority_kinds(repositories, context)
    total = repositories.inbox.unread_count(context.workspace_id, context.user_id)
    priority_unread, other_unread = repositories.inbox.split_unread_counts(
        context.workspace_id, context.user_id, lambda kind: kind in priority
    )
    return InboxCountRead(
        unread=total,
        priority_unread=priority_unread,
        other_unread=other_unread,
        priority_inbox=split,
        badge=priority_unread if split else total,
    )


def cursor_scope(
    workspace_id: str,
    user_id: str,
    unread: bool,
    snoozed: bool = False,
    *,
    include_snoozed: bool = False,
    kinds: Sequence[str] = (),
) -> str:
    """The scope an inbox cursor is stamped with.

    Carries the caller, which list the page came from and its filters, so a cursor
    minted on one member's unread page is refused on another member's full page,
    and one minted under a kind filter is refused once the filter changes.
    """
    mode = "unread" if unread else "snoozed" if snoozed else "all"
    if include_snoozed and not snoozed:
        mode = f"{mode}+snoozed"
    if kinds:
        mode = f"{mode}:{','.join(sorted(set(kinds)))}"
    return f"inbox:{workspace_id}:{user_id}:{mode}"


def list_notifications(
    repositories: Repositories,
    context: AuthzContext,
    *,
    unread: bool,
    snoozed: bool,
    cursor: Optional[str],
    limit: int,
    include_snoozed: bool = False,
    kinds: Sequence[str] = (),
    bucket: InboxBucket = "all",
) -> tuple[list[NotificationRead], Optional[str]]:
    """One page of the caller's own notifications, newest first, with the next cursor.

    Snoozed notifications stay out of both lists until their time comes unless
    `include_snoozed` keeps them in, and `snoozed` lists only them, so it cannot be
    combined with `unread`. `kinds` keeps only those notification kinds, and
    `bucket` only the caller's Priority or Other tab.
    """
    if unread and snoozed:
        raise unprocessable("unread and snoozed cannot be combined")
    unknown = sorted(set(kinds) - set(INBOX_KINDS))
    if unknown:
        raise unprocessable(f"Unknown notification kind: {', '.join(unknown)}")
    narrowed = bucket_kinds(repositories, context, bucket, kinds)
    if narrowed is None:
        return [], None
    workspace_id = context.workspace_id
    scope = cursor_scope(
        workspace_id, context.user_id, unread, snoozed, include_snoozed=include_snoozed, kinds=narrowed
    )
    page = repositories.inbox.list(
        workspace_id,
        context.user_id,
        unread_only=unread,
        snoozed_only=snoozed,
        include_snoozed=include_snoozed,
        kinds=narrowed,
        limit=limit,
        start_key=resume_key(cursor, scope),
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
    return items, encode_start_key(page.last_evaluated_key, scope=scope)


def mark_read(repositories: Repositories, context: AuthzContext, payload: InboxReadRequest) -> int:
    """Mark some or all of the caller's notifications read, answering how many moved.

    An id already read, or belonging to someone else, counts as nothing changed.
    `kinds` and `bucket` narrow a mark of everything and are refused beside ids.
    """
    if (payload.kinds or payload.bucket != "all") and not payload.all:
        raise unprocessable("kinds and bucket only narrow all")
    if payload.all:
        unknown = sorted(set(payload.kinds) - set(INBOX_KINDS))
        if unknown:
            raise unprocessable(f"Unknown notification kind: {', '.join(unknown)}")
        narrowed = bucket_kinds(repositories, context, payload.bucket, payload.kinds)
        if narrowed is None:
            return 0
        return repositories.inbox.mark_all_read(context.workspace_id, context.user_id, kinds=narrowed)
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


def clear_notifications(repositories: Repositories, context: AuthzContext, payload: InboxClearRequest) -> int:
    """Delete the caller's own notifications in bulk, the read ones, the finished ones or all.

    `kinds` and `bucket` narrow it the way the list's filters do, and a snoozed
    row is only taken by a clear that asks for snoozed rows too. `completed_only`
    keeps to rows whose issue is now completed or cancelled, so rows naming no
    issue, or one since deleted, stay.
    """
    unknown = sorted(set(payload.kinds) - set(INBOX_KINDS))
    if unknown:
        raise unprocessable(f"Unknown notification kind: {', '.join(unknown)}")
    narrowed = bucket_kinds(repositories, context, payload.bucket, payload.kinds)
    if narrowed is None:
        return 0
    return repositories.inbox.delete_matching(
        context.workspace_id,
        context.user_id,
        read_only=payload.read_only,
        include_snoozed=payload.include_snoozed,
        kinds=narrowed,
        issue_filter=(lambda ids: finished_issue_ids(repositories, context.workspace_id, ids))
        if payload.completed_only
        else None,
    )


def finished_issue_ids(repositories: Repositories, workspace_id: str, issue_ids: set[str]) -> set[str]:
    """The named issues whose status sits in a completed or cancelled category.

    One batch read for the issues and one status read per team they span, so the
    cost follows the teams involved rather than the rows being cleared.
    """
    issues = repositories.issues.get_many(workspace_id, sorted(issue_ids))
    categories = {
        team_id: status_categories(repositories, workspace_id, team_id)
        for team_id in {issue.team_id for issue in issues.values()}
    }
    return {
        issue_id
        for issue_id, issue in issues.items()
        if categories[issue.team_id].get(issue.status_id) in COMPLETED_CATEGORIES
    }


def delete_notification(repositories: Repositories, context: AuthzContext, notification_id: str) -> None:
    """Remove one of the caller's own notifications, or 404."""
    if not repositories.inbox.delete(context.workspace_id, context.user_id, notification_id):
        raise not_found()
