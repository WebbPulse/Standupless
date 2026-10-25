"""Comment list, create, edit and delete, shared by the comment routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and a comment an agent adds must carry the same mentions, reply depth,
subscriptions and issue backlinks as one a person adds, or the inbox would treat
the two differently.
"""

from __future__ import annotations

from typing import Optional

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed, encode_start_key

from app.common import discussion_rules
from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import resume_key
from app.common.core.constants import ISSUE_BODY_MAX_BYTES
from app.common.db.dynamo.comments import Comment, CommentAnchor, as_comment, build_comment
from app.common.issue_mentions import record_issue_mentions
from app.common.issue_rules import load_visible_issue, not_found, require_team_member, unprocessable
from app.common.mentions import mentioned_user_ids
from app.common.thread_resolution import reopen_on_reply
from app.common.triage_wake import wake_on_activity


def conflict(message: str) -> HTTPException:
    """A 409 carrying the product's error envelope."""
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"error_code": "CONFLICT", "message": message},
    )


def comment_page(
    repositories: Repositories,
    context: AuthzContext,
    issue_id: str,
    *,
    cursor: Optional[str],
    limit: int,
) -> tuple[list[Comment], Optional[str]]:
    """One page of a visible issue's thread, oldest first, and the next cursor."""
    load_visible_issue(repositories, context, issue_id)
    scope = f"comments:{context.workspace_id}:{issue_id}"
    page = repositories.comments.list_for_issue(
        context.workspace_id,
        issue_id,
        limit=limit,
        start_key=resume_key(cursor, scope),
    )
    return [as_comment(item) for item in page.items], encode_start_key(page.last_evaluated_key, scope=scope)


def create_comment(
    repositories: Repositories,
    context: AuthzContext,
    issue_id: str,
    body: str,
    *,
    parent_comment_id: Optional[str] = None,
    attachment_ids: Optional[list[str]] = None,
    anchor: Optional[CommentAnchor] = None,
) -> Comment:
    """Add a comment to an issue, extracting its mentions on the way in.

    A reply may only hang off a root comment: nesting past one level is a 409
    rather than a silent reparent, because the contract makes `reply_count` a count
    of direct replies and a deeper thread would make it a tree walk.

    The inbox rows the mentions produce are written by the `views` notify consumer
    off this table's stream, so the request path does no notification work. The
    author and everyone mentioned are subscribed to the issue here, which is what
    makes the next comment on it reach them. Every issue the body names by key
    gets a "mentioned in" backlink.

    Every named attachment must already be on this issue. The lookup is keyed by
    the issue's own partition, so an id from another issue or workspace is refused
    the same way as one that never existed.

    A reply to a resolved thread reopens it, so new discussion is never hidden
    under a collapsed thread.

    A comment from anyone but the person who snoozed the issue in triage ends the
    snooze, so new activity brings it back to the inbox.

    `anchor` pins a new thread to a passage of the description. A reply belongs to
    its root's passage, so one carrying its own anchor is a 422.
    """
    if anchor is not None and parent_comment_id:
        raise unprocessable("A reply cannot be pinned to a passage")
    issue = load_visible_issue(repositories, context, issue_id)
    require_team_member(repositories, context, issue.team_id)

    parent: Optional[Comment] = None
    if parent_comment_id:
        parent = repositories.comments.get(context.workspace_id, issue_id, parent_comment_id)
        if parent is None:
            raise not_found()
        if parent.parent_comment_id:
            raise conflict("Replies are one level deep")

    attachments = list(attachment_ids or [])
    if attachments:
        held = repositories.attachments.get_many(context.workspace_id, issue_id, attachments)
        if any(attachment_id not in held for attachment_id in attachments):
            raise unprocessable("Every attachment must belong to this issue")

    mentions = mentioned_user_ids(repositories, context.workspace_id, body)
    comment = build_comment(
        context.workspace_id,
        issue_id,
        issue.team_id,
        context.user_id,
        body,
        parent_comment_id=parent_comment_id,
        mentions=mentions,
        attachment_ids=attachments,
        source=context.source,
        anchor=anchor,
    )
    try:
        created = repositories.comments.create(comment)
    except ConditionFailed as exc:
        raise conflict("That comment already exists") from exc

    if parent is not None:
        reopen_on_reply(repositories, parent, context.user_id, source=context.source)
    wake_on_activity(repositories, issue, context.user_id)

    subscriptions = repositories.subscriptions
    subscriptions.subscribe(context.workspace_id, issue_id, issue.team_id, context.user_id, "commenter")
    subscriptions.subscribe_many(context.workspace_id, issue_id, issue.team_id, mentions, "mentioned")
    record_issue_mentions(repositories, context, issue, None, body, place="comment", comment_id=created.comment_id)
    return created


def edit_comment(repositories: Repositories, context: AuthzContext, comment: Comment, body: str) -> Comment:
    """Rewrite one comment's body, re-extracting its mentions, and answer the stored comment.

    Only what the edit adds is news: the people it newly mentions are subscribed,
    and the notify consumer pings them alone off the stream record, while the
    issues it newly names get a backlink. Someone already mentioned is not
    subscribed again, so an edit never undoes their unsubscribing.
    """
    mentions = mentioned_user_ids(repositories, context.workspace_id, body)
    updated = repositories.comments.edit(context.workspace_id, comment.issue_id, comment.comment_id, body, mentions)
    if updated is None:
        raise not_found()

    added = [user_id for user_id in mentions if user_id not in comment.mentions]
    repositories.subscriptions.subscribe_many(
        context.workspace_id, comment.issue_id, comment.team_id, added, "mentioned"
    )
    issue = repositories.issues.get(context.workspace_id, comment.issue_id)
    if issue is not None:
        record_issue_mentions(
            repositories, context, issue, comment.body, body, place="comment", comment_id=comment.comment_id
        )
    return updated


def load_comment(repositories: Repositories, context: AuthzContext, issue_id: str, comment_id: str) -> Comment:
    """One comment of a visible issue, or a 404.

    The issue is loaded first, so a comment on an issue the caller cannot see is
    the same 404 as one that never existed and the comment id itself leaks nothing.
    """
    discussion_rules.load_visible_issue(repositories, context, issue_id)
    comment = repositories.comments.get(context.workspace_id, issue_id, comment_id)
    if comment is None:
        raise discussion_rules.not_found()
    return comment


def update_comment(
    repositories: Repositories, context: AuthzContext, issue_id: str, comment_id: str, body: str
) -> Comment:
    """Rewrite one's own comment on an issue, or a 404 or 403, answering the stored comment.

    The author alone, not a team admin: rewriting someone else's words is a
    different act from removing them, and only the second has a moderation case.
    """
    if not body.strip():
        raise unprocessable("body must not be empty")
    if len(body.encode("utf-8")) > ISSUE_BODY_MAX_BYTES:
        raise unprocessable(f"body must be at most {ISSUE_BODY_MAX_BYTES} bytes")
    comment = load_comment(repositories, context, issue_id, comment_id)
    if not discussion_rules.may_edit_comment(context, comment):
        raise discussion_rules.forbidden()
    return edit_comment(repositories, context, comment, body)


def delete_comment(repositories: Repositories, context: AuthzContext, issue_id: str, comment_id: str) -> None:
    """Remove one comment on an issue, reparenting its replies and dropping its reactions.

    The author or an admin of the issue's current team. The replies are
    reparented to the thread root rather than deleted with it, so removing a
    comment never takes someone else's words with it, and the reactions go because
    nothing but this comment's id names their partition.
    """
    issue = discussion_rules.load_visible_issue(repositories, context, issue_id)
    comment = load_comment(repositories, context, issue_id, comment_id)
    if not discussion_rules.may_delete_comment(repositories, context, comment, issue.team_id):
        raise discussion_rules.forbidden()

    for reply in repositories.comments.iter_for_issue(context.workspace_id, issue_id):
        if reply.parent_comment_id == comment_id:
            repositories.comments.clear_parent(context.workspace_id, issue_id, reply.comment_id)

    repositories.reactions.delete_for_target(context.workspace_id, comment_id)
    repositories.comments.delete(context.workspace_id, issue_id, comment_id)
