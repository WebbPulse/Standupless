"""Comment list and create, shared by the comment routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and a comment an agent adds must carry the same mentions, reply depth and
subscriptions as one a person adds, or the inbox would treat the two differently.
"""

from __future__ import annotations

from typing import Optional

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed, encode_start_key

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import resume_key
from app.common.db.dynamo.comments import Comment, as_comment, build_comment
from app.common.issue_rules import load_visible_issue, not_found, require_team_member, unprocessable
from app.common.mentions import mentioned_user_ids


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
) -> Comment:
    """Add a comment to an issue, extracting its mentions on the way in.

    A reply may only hang off a root comment: nesting past one level is a 409
    rather than a silent reparent, because the contract makes `reply_count` a count
    of direct replies and a deeper thread would make it a tree walk.

    The inbox rows the mentions produce are written by the `views` notify consumer
    off this table's stream, so the request path does no notification work. The
    author and everyone mentioned are subscribed to the issue here, which is what
    makes the next comment on it reach them.

    Every named attachment must already be on this issue. The lookup is keyed by
    the issue's own partition, so an id from another issue or workspace is refused
    the same way as one that never existed.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    require_team_member(repositories, context, issue.team_id)

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
    )
    try:
        created = repositories.comments.create(comment)
    except ConditionFailed as exc:
        raise conflict("That comment already exists") from exc

    subscriptions = repositories.subscriptions
    subscriptions.subscribe(context.workspace_id, issue_id, issue.team_id, context.user_id, "commenter")
    subscriptions.subscribe_many(context.workspace_id, issue_id, issue.team_id, mentions, "mentioned")
    return created
