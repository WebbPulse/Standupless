"""Resolving a comment thread, unresolving it, and reopening it on a reply.

Held in `common` because the discussion routes, the MCP tools and the GitHub
reply handler all change it, and the integrations image may not import another
domain's code. The mark sits on the thread's root comment, the way a GitHub
thread's sync state does, so the comment list already carries it and a reader
collapses the thread with no second read.

Every change records one activity row naming the root comment, so the issue's
history says who resolved or reopened which thread even after the thread is
collapsed out of the way.
"""

from __future__ import annotations

from fastapi import HTTPException, status

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.comments import Comment, ThreadResolution
from app.common.db.dynamo.issues import Issue
from app.common.issue_rules import load_visible_issue, not_found, require_team_member

RESOLVED = "thread_resolved"
"""The activity kind resolving a thread records."""

UNRESOLVED = "thread_unresolved"
"""The activity kind unresolving or reopening a thread records."""

REOPENED_BY_REPLY = "reply"
"""The activity field a reopen carries when a reply, not a person's click, reopened the thread."""


def conflict(message: str) -> HTTPException:
    """A 409 carrying the product's error envelope."""
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"error_code": "CONFLICT", "message": message},
    )


def _root_comment(repositories: Repositories, context: AuthzContext, issue: Issue, comment_id: str) -> Comment:
    """A root comment of a visible issue, or a 404, or a 409 for a reply."""
    comment = repositories.comments.get(context.workspace_id, issue.issue_id, comment_id)
    if comment is None:
        raise not_found()
    if comment.parent_comment_id:
        raise conflict("Only a thread's first comment can be resolved")
    return comment


def resolve_thread(repositories: Repositories, context: AuthzContext, issue_id: str, comment_id: str) -> Comment:
    """Mark one thread resolved as the caller, answering the stored root comment.

    Any team member may resolve, as anyone may reply. Resolving a thread that is
    already resolved changes nothing and records nothing, so a double click or a
    retried tool call leaves one history row.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    require_team_member(repositories, context, issue.team_id)
    comment = _root_comment(repositories, context, issue, comment_id)
    if comment.resolution is not None:
        return comment
    updated = repositories.comments.set_resolution(
        context.workspace_id, issue.issue_id, comment.comment_id, ThreadResolution(resolved_by=context.user_id)
    )
    if updated is None:
        raise not_found()
    repositories.activity.record(
        build_activity(
            context.workspace_id,
            issue.team_id,
            issue.issue_id,
            context.user_id,
            RESOLVED,
            to_value=comment.comment_id,
            source=context.source,
        )
    )
    return updated


def unresolve_thread(repositories: Repositories, context: AuthzContext, issue_id: str, comment_id: str) -> Comment:
    """Clear one thread's resolution as the caller, answering the stored root comment.

    Anyone who may resolve may unresolve, whoever resolved it. Unresolving an
    open thread changes nothing and records nothing.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    require_team_member(repositories, context, issue.team_id)
    comment = _root_comment(repositories, context, issue, comment_id)
    if comment.resolution is None:
        return comment
    updated = repositories.comments.set_resolution(context.workspace_id, issue.issue_id, comment.comment_id, None)
    if updated is None:
        raise not_found()
    repositories.activity.record(
        build_activity(
            context.workspace_id,
            issue.team_id,
            issue.issue_id,
            context.user_id,
            UNRESOLVED,
            to_value=comment.comment_id,
            source=context.source,
        )
    )
    return updated


def reopen_on_reply(
    repositories: Repositories,
    root: Comment,
    actor_id: str,
    *,
    actor_kind: str = "user",
    source: str | None = None,
) -> bool:
    """Reopen a resolved thread because someone replied to it, answering whether it was resolved.

    A reply is new discussion, so leaving the thread collapsed would hide it. The
    history row names the reply as the reason, so the feed reads "reopened by
    replying" rather than as a deliberate unresolve.
    """
    if root.resolution is None:
        return False
    updated = repositories.comments.set_resolution(root.workspace_id, root.issue_id, root.comment_id, None)
    if updated is None:
        return False
    repositories.activity.record(
        build_activity(
            root.workspace_id,
            root.team_id,
            root.issue_id,
            actor_id,
            UNRESOLVED,
            actor_kind=actor_kind,
            field=REOPENED_BY_REPLY,
            to_value=root.comment_id,
            source=source,
        )
    )
    return True
