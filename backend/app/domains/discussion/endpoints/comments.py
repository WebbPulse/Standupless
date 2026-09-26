"""Comment routes: list and create under an issue, read, edit and delete by id.

The thread routes are nested under the issue because the `comments` table
partitions by `<workspace_id>#<issue_id>`, so the issue is what makes a read one
query. The single-comment routes take `issue_id` as a query parameter for the same
reason, which keeps a comment id stable in a permalink built from the issue route
rather than making the partition part of the path.

Reactions are rendered inline on every comment, so a thread costs one call rather
than one call per comment. Attachments a comment carries are joined the same way,
with one batch read per page, so a file posted in the thread renders inline.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Path, Query, Response, status
from webbpulse.dynamodb import ConditionFailed
from webbpulse.http import CursorPage

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.pagination import decode_cursor, encode_cursor
from app.common.db.dynamo.comments import Comment, as_comment, build_comment
from app.common.mentions import mentioned_user_ids
from app.domains.discussion.schemas.discussion import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    AttachmentRead,
    AuthorRead,
    CommentCreate,
    CommentListRead,
    CommentRead,
    CommentUpdate,
)
from app.domains.discussion.service import (
    authors_for,
    conflict,
    forbidden,
    group_reactions,
    load_visible_issue,
    may_delete_comment,
    may_edit_comment,
    not_found,
    require_team_member,
    unprocessable,
)

router = APIRouter()


def _render(
    repositories: Repositories,
    context: AuthzContext,
    comments: list[Comment],
    *,
    reply_counts: dict[str, int] | None = None,
) -> list[CommentRead]:
    """A page of comments as responses, with authors and reactions joined on.

    Every join is batched across the page rather than done per comment: the author
    read is one `BatchGetItem`, the reactions are one query per comment that has
    any, and the attachments are one `BatchGetItem` per issue on the page, which is
    what keeps rendering a thread proportional to the page and not to a round trip
    per row.
    """
    authors = authors_for(repositories, [comment.author_id for comment in comments])
    reactions = repositories.reactions.list_for_targets(
        context.workspace_id, [comment.comment_id for comment in comments]
    )
    attachments = _attachments_for(repositories, context, comments)
    counts = reply_counts if reply_counts is not None else {}
    return [
        CommentRead.from_row(
            comment,
            author=authors.get(comment.author_id, AuthorRead(user_id=comment.author_id)),
            reactions=group_reactions(reactions.get(comment.comment_id, []), context.user_id),
            reply_count=counts.get(comment.comment_id, 0),
            attachments=[
                attachments[(comment.issue_id, attachment_id)]
                for attachment_id in comment.attachment_ids
                if (comment.issue_id, attachment_id) in attachments
            ],
        )
        for comment in comments
    ]


def _attachments_for(
    repositories: Repositories,
    context: AuthzContext,
    comments: list[Comment],
) -> dict[tuple[str, str], AttachmentRead]:
    """The attachments a page of comments names, keyed by issue and attachment id.

    Grouped by issue because the issue is the attachment partition, so a page that
    names no attachment costs no read at all and a thread page costs one.
    """
    wanted: dict[str, list[str]] = {}
    for comment in comments:
        if comment.attachment_ids:
            wanted.setdefault(comment.issue_id, []).extend(comment.attachment_ids)
    found: dict[tuple[str, str], AttachmentRead] = {}
    for issue_id, attachment_ids in wanted.items():
        rows = repositories.attachments.get_many(context.workspace_id, issue_id, attachment_ids)
        for attachment_id, row in rows.items():
            found[(issue_id, attachment_id)] = AttachmentRead.from_row(row)
    return found


def _load_comment(repositories: Repositories, context: AuthzContext, issue_id: str, comment_id: str) -> Comment:
    """One comment of a visible issue, or a 404.

    The issue is loaded first, so a comment on an issue the caller cannot see is
    the same 404 as one that never existed and the comment id itself leaks nothing.
    """
    load_visible_issue(repositories, context, issue_id)
    comment = repositories.comments.get(context.workspace_id, issue_id, comment_id)
    if comment is None:
        raise not_found()
    return comment


@router.get("/{workspace_id}/issues/{issue_id}/comments", response_model=CommentListRead)
def list_comments(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> CursorPage[CommentRead]:
    """One page of an issue's thread, oldest first so it reads in order.

    Reply counts are computed over the whole thread rather than over the page,
    because a reply can sit on a later page than its parent and a count of the page
    alone would be wrong for every parent near a boundary.
    """
    load_visible_issue(repositories, context, issue_id)
    scope = f"comments:{context.workspace_id}:{issue_id}"
    page = repositories.comments.list_for_issue(
        context.workspace_id,
        issue_id,
        limit=limit,
        start_key=decode_cursor(cursor, scope),
    )
    rows = [as_comment(item) for item in page.items]
    counts = repositories.comments.count_replies(repositories.comments.iter_for_issue(context.workspace_id, issue_id))
    return CommentListRead(
        items=_render(repositories, context, rows, reply_counts=counts),
        next_cursor=encode_cursor(page.last_evaluated_key, scope),
    )


@router.post(
    "/{workspace_id}/issues/{issue_id}/comments",
    response_model=CommentRead,
    status_code=status.HTTP_201_CREATED,
)
def create_comment(
    payload: CommentCreate,
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> CommentRead:
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

    if payload.parent_comment_id:
        parent = repositories.comments.get(context.workspace_id, issue_id, payload.parent_comment_id)
        if parent is None:
            raise not_found()
        if parent.parent_comment_id:
            raise conflict("Replies are one level deep")

    if payload.attachment_ids:
        held = repositories.attachments.get_many(context.workspace_id, issue_id, payload.attachment_ids)
        if any(attachment_id not in held for attachment_id in payload.attachment_ids):
            raise unprocessable("Every attachment must belong to this issue")

    mentions = mentioned_user_ids(repositories, context.workspace_id, payload.body)
    comment = build_comment(
        context.workspace_id,
        issue_id,
        issue.team_id,
        context.user_id,
        payload.body,
        parent_comment_id=payload.parent_comment_id,
        mentions=mentions,
        attachment_ids=payload.attachment_ids,
    )
    try:
        created = repositories.comments.create(comment)
    except ConditionFailed as exc:
        raise conflict("That comment already exists") from exc

    subscriptions = repositories.subscriptions
    subscriptions.subscribe(context.workspace_id, issue_id, issue.team_id, context.user_id, "commenter")
    subscriptions.subscribe_many(context.workspace_id, issue_id, issue.team_id, mentions, "mentioned")

    return _render(repositories, context, [created])[0]


@router.get("/{workspace_id}/comments/{comment_id}", response_model=CommentRead)
def read_comment(
    comment_id: Annotated[str, Path(min_length=1)],
    issue_id: Annotated[str, Query(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> CommentRead:
    """One comment the caller may read.

    `issue_id` is required because it is the partition; without it this read would
    be a scan, which the design forbids outside an admin path.
    """
    comment = _load_comment(repositories, context, issue_id, comment_id)
    counts = repositories.comments.count_replies(repositories.comments.iter_for_issue(context.workspace_id, issue_id))
    return _render(repositories, context, [comment], reply_counts=counts)[0]


@router.patch("/{workspace_id}/comments/{comment_id}", response_model=CommentRead)
def update_comment(
    payload: CommentUpdate,
    comment_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> CommentRead:
    """Rewrite one's own comment, stamping `edited_at` and re-extracting mentions.

    The author alone, not a team admin: rewriting someone else's words is a
    different act from removing them, and only the second has a moderation case.

    Mentions are recomputed from the new body, so an edit that adds one notifies
    and an edit that removes one stops claiming it.
    """
    comment = _load_comment(repositories, context, payload.issue_id, comment_id)
    if not may_edit_comment(context, comment):
        raise forbidden()

    mentions = mentioned_user_ids(repositories, context.workspace_id, payload.body)
    updated = repositories.comments.edit(context.workspace_id, payload.issue_id, comment_id, payload.body, mentions)
    if updated is None:
        raise not_found()

    added = [user_id for user_id in mentions if user_id not in comment.mentions]
    repositories.subscriptions.subscribe_many(
        context.workspace_id, payload.issue_id, comment.team_id, added, "mentioned"
    )

    counts = repositories.comments.count_replies(
        repositories.comments.iter_for_issue(context.workspace_id, payload.issue_id)
    )
    return _render(repositories, context, [updated], reply_counts=counts)[0]


@router.delete("/{workspace_id}/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_comment(
    comment_id: Annotated[str, Path(min_length=1)],
    issue_id: Annotated[str, Query(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Remove one comment, reparenting its replies and dropping its reactions.

    The author or a team admin. The replies are reparented to the thread root
    rather than deleted with it, so removing a comment never takes someone else's
    words with it, and the reactions go because nothing but this comment's id names
    their partition.
    """
    comment = _load_comment(repositories, context, issue_id, comment_id)
    if not may_delete_comment(repositories, context, comment):
        raise forbidden()

    for reply in repositories.comments.iter_for_issue(context.workspace_id, issue_id):
        if reply.parent_comment_id == comment_id:
            repositories.comments.clear_parent(context.workspace_id, issue_id, reply.comment_id)

    repositories.reactions.delete_for_target(context.workspace_id, comment_id)
    repositories.comments.delete(context.workspace_id, issue_id, comment_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
