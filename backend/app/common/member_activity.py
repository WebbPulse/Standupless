"""One member's page: who they are and what they recently did, as the caller may see it.

Shared by the member page routes and any later tool, so both read the same rows
through the same visibility check and hand out cursors the other accepts.

The feed merges two streams, the person's own issue changes off the activity
table's actor index and their comments off the comments table's author index.
The cursor is the boundary row of the merged order, a timestamp and an id, so
each stream resumes strictly after it. Rows on issues the caller cannot read are
dropped after the merge, which can leave a page short while its cursor still
walks the whole history.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from webbpulse.dynamodb import encode_start_key

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import resume_key
from app.common.api.schemas.issues import ActivityRead
from app.common.api.schemas.member_pages import MemberActivityRead, MemberCommentRead, MemberProfileRead
from app.common.api.schemas.member_status import current_status
from app.common.api.schemas.workspaces import display_name_for
from app.common.db.dynamo.activity import Activity
from app.common.db.dynamo.comments import Comment
from app.common.icons import icon_url
from app.common.issue_activity import with_current_keys
from app.common.issue_keys import current
from app.common.issue_mentions import visible_backlink
from app.common.issue_rules import not_found

ME = "me"
"""What a caller writes instead of their own id, resolved from the authorization context."""

EXCERPT_LENGTH = 280
"""How much of a comment body one feed entry carries."""

OVERFETCH = 20
"""Rows read past the page from each stream, covering the second the stored stamps round to."""

TOUCHED_BATCH = 100
"""How many feed rows one scan of the touched issues read takes."""

TOUCHED_SCANS = 10
"""How many feed pages one touched issues page reads at most before handing back a cursor."""


@dataclass(frozen=True)
class _Entry:
    """One row of either stream, keyed for the merged order."""

    created_at: datetime
    id: str
    activity: Optional[Activity] = None
    comment: Optional[Comment] = None

    @property
    def issue_id(self) -> str:
        """The issue this row belongs to."""
        if self.activity is not None:
            return self.activity.issue_id
        assert self.comment is not None
        return self.comment.issue_id


def resolve_member_id(context: AuthzContext, user_id: str) -> str:
    """`user_id`, or the caller's own id when they wrote `me`."""
    return context.user_id if user_id == ME else user_id


def member_profile(repositories: Repositories, context: AuthzContext, user_id: str) -> MemberProfileRead:
    """One workspace member's page header, or a 404 when they are not a member.

    The teams listed are the ones the caller can see, and no email is returned.
    The status and timezone answer only to a caller who may see the member's status.
    """
    member_id = resolve_member_id(context, user_id)
    membership = repositories.memberships.get(context.workspace_id, member_id)
    if membership is None:
        raise not_found()
    user = repositories.users.get(member_id)
    team_ids = sorted(
        {
            row.team_id
            for row in repositories.memberships.list_team_memberships_for_user(context.workspace_id, member_id)
            if row.team_id and context.can_see_team(row.team_id)
        }
    )
    shown = _status_shown(context, member_id, team_ids)
    return MemberProfileRead(
        user_id=member_id,
        display_name=display_name_for(user),
        full_name=user.full_name if user is not None else "",
        avatar_url=icon_url(user.icon_key) if user is not None else None,
        role=membership.role,  # pyright: ignore[reportArgumentType]
        joined_at=membership.joined_at,
        team_ids=team_ids,
        user_status=current_status(membership.user_status) if shown else None,
        timezone=user.timezone if shown and user is not None else None,
    )


def _status_shown(context: AuthzContext, member_id: str, team_ids: list[str]) -> bool:
    """Whether the caller may see this member's status.

    Anyone but a guest may, and so may a guest looking at themselves or at someone
    on one of their teams, which is when `team_ids` holds a team they can see.
    """
    return not context.is_guest or member_id == context.user_id or bool(team_ids)


def _boundary(cursor: Optional[str], scope: str) -> Optional[tuple[datetime, str]]:
    """The merged-order position a cursor names, or `None` for the first page."""
    payload = resume_key(cursor, scope)
    if not payload:
        return None
    try:
        return datetime.fromisoformat(str(payload["t"])), str(payload["i"])
    except (KeyError, TypeError, ValueError):
        return None


def _older(entry: _Entry, boundary: Optional[tuple[datetime, str]]) -> bool:
    """Whether a row comes after the boundary in newest-first order."""
    if boundary is None:
        return True
    return (entry.created_at, entry.id) < boundary


def member_activity_page(
    repositories: Repositories,
    context: AuthzContext,
    user_id: str,
    *,
    cursor: Optional[str] = None,
    limit: int,
) -> tuple[list[MemberActivityRead], Optional[str]]:
    """One page of a member's issue changes and comments, newest first, and the cursor after it.

    A 404 when they are not a member of the workspace. Only rows on issues the
    caller can read are returned.
    """
    member_id = resolve_member_id(context, user_id)
    workspace_id = context.workspace_id
    if repositories.memberships.get(workspace_id, member_id) is None:
        raise not_found()
    scope = _scope(workspace_id, member_id)
    boundary = _boundary(cursor, scope)
    before = boundary[0] if boundary is not None else None
    fetch = limit + 1 + OVERFETCH
    changes = repositories.activity.list_for_actor(workspace_id, member_id, before=before, max_items=fetch)
    comments = repositories.comments.list_by_author(workspace_id, member_id, before=before, max_items=fetch)
    entries = [_Entry(row.created_at, row.activity_id, activity=row) for row in changes]
    entries += [_Entry(row.created_at, row.comment_id, comment=row) for row in comments]
    merged = sorted(
        (entry for entry in entries if _older(entry, boundary)), key=lambda e: (e.created_at, e.id), reverse=True
    )
    page = merged[:limit]
    more = len(merged) > limit or len(changes) >= fetch or len(comments) >= fetch
    next_cursor = None
    if more and page:
        last = page[-1]
        next_cursor = _cursor_at(scope, last.created_at, last.id)
    return _visible(repositories, context, page), next_cursor


def _scope(workspace_id: str, member_id: str) -> str:
    """The cursor scope of one member's feed, shared by the feed and the touched issues read."""
    return f"member-activity:{workspace_id}:{member_id}"


def _cursor_at(scope: str, created_at: datetime, row_id: str) -> Optional[str]:
    """A cursor that resumes the feed strictly after the row it names."""
    return encode_start_key({"t": created_at.isoformat(), "i": row_id}, scope=scope)


def member_touched_issues_page(
    repositories: Repositories,
    context: AuthzContext,
    user_id: str,
    *,
    cursor: Optional[str] = None,
    limit: int,
) -> tuple[list[MemberActivityRead], Optional[str]]:
    """The issues a member most recently changed or commented on, one row per issue, newest first.

    Each row is the member's latest action on its issue. The read walks the feed
    until `limit` distinct issues are found or `TOUCHED_SCANS` pages are read, and
    the cursor resumes the feed after the last row used, so it is a feed cursor.
    An issue seen on an earlier page can come back on a later one with an older
    action, which the caller drops. A 404 when they are not a workspace member.
    """
    scope = _scope(context.workspace_id, resolve_member_id(context, user_id))
    seen: set[str] = set()
    items: list[MemberActivityRead] = []
    page_cursor = cursor
    for _ in range(TOUCHED_SCANS):
        rows, after = member_activity_page(repositories, context, user_id, cursor=page_cursor, limit=TOUCHED_BATCH)
        for index, row in enumerate(rows):
            if row.issue_id in seen:
                continue
            seen.add(row.issue_id)
            items.append(row)
            if len(items) == limit:
                if index < len(rows) - 1:
                    return items, _cursor_at(scope, row.created_at, row.id)
                return items, after
        if after is None:
            return items, None
        page_cursor = after
    return items, page_cursor


def _visible(repositories: Repositories, context: AuthzContext, page: list[_Entry]) -> list[MemberActivityRead]:
    """The page's rows the caller may read, each naming its issue under the current key."""
    issues = repositories.issues.get_many(context.workspace_id, sorted({entry.issue_id for entry in page}))
    readable = {
        issue_id: current(repositories.teams, issue)
        for issue_id, issue in issues.items()
        if context.can_see_team(issue.team_id)
    }
    changes = [entry.activity for entry in page if entry.activity is not None and entry.issue_id in readable]
    rekeyed = {row.activity_id: row for row in with_current_keys(repositories, context.workspace_id, changes)}
    items: list[MemberActivityRead] = []
    for entry in page:
        issue = readable.get(entry.issue_id)
        if issue is None:
            continue
        activity: Optional[ActivityRead] = None
        comment: Optional[MemberCommentRead] = None
        if entry.activity is not None:
            row = rekeyed.get(entry.activity.activity_id, entry.activity)
            if not visible_backlink(context, row):
                continue
            activity = ActivityRead.from_row(row)
        elif entry.comment is not None:
            comment = MemberCommentRead(
                comment_id=entry.comment.comment_id,
                body=entry.comment.body[:EXCERPT_LENGTH],
                parent_comment_id=entry.comment.parent_comment_id,
            )
        items.append(
            MemberActivityRead(
                type="issue_change" if activity is not None else "comment",
                id=entry.id,
                created_at=entry.created_at,
                issue_id=issue.issue_id,
                issue_key=issue.key,
                issue_title=issue.title,
                team_id=issue.team_id,
                activity=activity,
                comment=comment,
            )
        )
    return items
