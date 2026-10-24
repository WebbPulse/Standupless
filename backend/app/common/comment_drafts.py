"""Comment drafts: one unposted comment per member per issue, and per reply thread.

Held in `common` because the drafts routes in the views image and the MCP tools
in the integrations image both run it, and that image may not import another
domain's code. A draft is its author's alone: every read and write is keyed by
the caller, so nobody can see or clear another member's draft, and drafts sit in
a table with no stream, so saving one never notifies anyone.

An agent stages a comment by saving a draft, and the person opening the issue
finds it restored in their composer, ready to edit and post. Posting clears the
draft the comment came from, whichever client posted it.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.drafts import DraftRead
from app.common.comment_writes import conflict
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.views import CommentDraft, draft_key
from app.common.issue_keys import current
from app.common.issue_rules import load_visible_issue, not_found, require_team_member


def _read(repositories: Repositories, row: CommentDraft, issue: Issue) -> DraftRead:
    """One draft as the API answers it, naming its issue by its current key."""
    keyed = current(repositories.teams, issue)
    return DraftRead.from_row(row, issue_key=keyed.key, issue_title=issue.title)


def _thread(parent_comment_id: Optional[str]) -> Optional[str]:
    """A reply thread id with blanks read as the issue's own thread."""
    value = (parent_comment_id or "").strip()
    return value or None


def save_draft(
    repositories: Repositories,
    context: AuthzContext,
    issue_id: str,
    body: str,
    *,
    parent_comment_id: Optional[str] = None,
) -> DraftRead:
    """Save the caller's draft on an issue or a reply thread, replacing the one there.

    Held to what posting it would need, so a draft can always be posted: the
    caller may comment in the issue's team, and a reply draft answers a root
    comment on this issue.
    """
    parent = _thread(parent_comment_id)
    issue = load_visible_issue(repositories, context, issue_id)
    require_team_member(repositories, context, issue.team_id)
    if parent:
        root = repositories.comments.get(context.workspace_id, issue.issue_id, parent)
        if root is None:
            raise not_found()
        if root.parent_comment_id:
            raise conflict("Replies are one level deep")
    existing = repositories.views.get_draft(context.workspace_id, context.user_id, issue.issue_id, parent)
    now = utc_now()
    row = CommentDraft(
        workspace_id=context.workspace_id,
        view_key=draft_key(context.user_id, issue.issue_id, parent),
        user_id=context.user_id,
        issue_id=issue.issue_id,
        team_id=issue.team_id,
        parent_comment_id=parent,
        body=body,
        created_at=existing.created_at if existing is not None else now,
        updated_at=now,
    )
    repositories.views.put_draft(row)
    return _read(repositories, row, issue)


def get_draft(
    repositories: Repositories,
    context: AuthzContext,
    issue_id: str,
    *,
    parent_comment_id: Optional[str] = None,
) -> DraftRead:
    """The caller's draft on an issue or a reply thread, or a 404 when there is none."""
    issue = load_visible_issue(repositories, context, issue_id)
    row = repositories.views.get_draft(
        context.workspace_id, context.user_id, issue.issue_id, _thread(parent_comment_id)
    )
    if row is None:
        raise not_found()
    return _read(repositories, row, issue)


def list_drafts(
    repositories: Repositories,
    context: AuthzContext,
    *,
    issue_id: Optional[str] = None,
) -> list[DraftRead]:
    """The caller's drafts, newest saved first, across the workspace or on one issue.

    A draft on an issue the caller can no longer see drops out of the listing and
    is kept, so regaining access brings it back. A draft on an issue that is gone
    is deleted on the way past.
    """
    if issue_id:
        load_visible_issue(repositories, context, issue_id)
    rows = repositories.views.list_drafts(context.workspace_id, context.user_id, issue_id=issue_id)
    if not rows:
        return []
    issues = repositories.issues.get_many(context.workspace_id, list({row.issue_id for row in rows}))
    answer: list[DraftRead] = []
    for row in rows:
        issue = issues.get(row.issue_id)
        if issue is None:
            repositories.views.delete_draft(context.workspace_id, context.user_id, row.issue_id, row.parent_comment_id)
            continue
        if context.can_see_team(issue.team_id):
            answer.append(_read(repositories, row, issue))
    return answer


def delete_draft(
    repositories: Repositories,
    context: AuthzContext,
    issue_id: str,
    *,
    parent_comment_id: Optional[str] = None,
) -> None:
    """Discard the caller's draft in one thread, a no-op when there is none.

    The issue is never read, so a draft on an issue since deleted or hidden can
    still be cleared.
    """
    repositories.views.delete_draft(context.workspace_id, context.user_id, issue_id, _thread(parent_comment_id))


def clear_posted_draft(
    repositories: Repositories,
    workspace_id: str,
    author_id: str,
    issue_id: str,
    parent_comment_id: Optional[str],
    posted_at: datetime,
) -> bool:
    """Clear the draft a posted comment came from, keeping one saved after it was posted."""
    return repositories.views.clear_draft_before(
        workspace_id, author_id, issue_id, _thread(parent_comment_id), posted_at
    )
