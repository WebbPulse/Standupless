"""The comment thread and subscribers of a document, shared by the discussion routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code. A document's thread is stored in the `comments` table the way an issue's
is, partitioned under the document id, so replies, reactions, mentions, edits and
resolving all run through the same rows and the same rules. Its followers sit in
the `subscriptions` table under the document id the same way, with no team.

A document is read by whoever reads its parent. Commenting and resolving take
the right to edit under that parent, which is who would comment on one of its
issues. Editing a comment is its author's alone, and deleting one is its
author's or anyone's who may delete the document.
"""

from __future__ import annotations

from typing import Optional

from webbpulse.dynamodb import ConditionFailed, encode_start_key

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import resume_key
from app.common.api.schemas.issues import SubscribersRead
from app.common.comment_writes import conflict
from app.common.db.dynamo.comments import Comment, CommentAnchor, ThreadResolution, as_comment, build_comment
from app.common.db.dynamo.documents import Document
from app.common.documents import Parent, Rights, load_readable_document
from app.common.issue_subscribers import ME, render_subscribers
from app.common.mentions import mentioned_user_ids
from app.common.planning_rules import forbidden, not_found, unprocessable

NO_TEAM = ""
"""The team a document's comment and subscription rows carry, since a document may sit under no team."""


def require_document_commenter(
    repositories: Repositories, context: AuthzContext, document_id: str
) -> tuple[Parent, Document]:
    """A readable document the caller may comment on, or a 404 or a 403."""
    parent, document = load_readable_document(repositories, context, document_id)
    if not Rights(repositories, context).can_edit(parent):
        raise forbidden()
    return parent, document


def load_document_comment(
    repositories: Repositories, context: AuthzContext, document_id: str, comment_id: str
) -> Comment:
    """One comment of a readable document, or a 404."""
    load_readable_document(repositories, context, document_id)
    comment = repositories.comments.get(context.workspace_id, document_id, comment_id)
    if comment is None or comment.document_id != document_id:
        raise not_found()
    return comment


def document_comment_page(
    repositories: Repositories,
    context: AuthzContext,
    document_id: str,
    *,
    cursor: Optional[str],
    limit: int,
) -> tuple[list[Comment], Optional[str]]:
    """One page of a readable document's thread, oldest first, and the next cursor."""
    load_readable_document(repositories, context, document_id)
    scope = f"comments:{context.workspace_id}:{document_id}"
    page = repositories.comments.list_for_issue(
        context.workspace_id, document_id, limit=limit, start_key=resume_key(cursor, scope)
    )
    rows = [as_comment(item) for item in page.items]
    return [row for row in rows if row.document_id == document_id], encode_start_key(
        page.last_evaluated_key, scope=scope
    )


def create_document_comment(
    repositories: Repositories,
    context: AuthzContext,
    document_id: str,
    body: str,
    *,
    parent_comment_id: Optional[str] = None,
    anchor: Optional[CommentAnchor] = None,
) -> Comment:
    """Add a comment to a document, subscribing its author and everyone it mentions.

    A reply hangs off a root only, as on an issue, and a reply to a resolved
    thread reopens it. The inbox rows are written by the notify consumer off the
    table's stream, so the request does no notification work. `anchor` pins a new
    thread to a passage of the document's body, so a reply carrying one is a 422.
    """
    if not body.strip():
        raise unprocessable("body must not be empty")
    if anchor is not None and parent_comment_id:
        raise unprocessable("A reply cannot be pinned to a passage")
    _, document = require_document_commenter(repositories, context, document_id)
    parent: Optional[Comment] = None
    if parent_comment_id:
        parent = repositories.comments.get(context.workspace_id, document_id, parent_comment_id)
        if parent is None or parent.document_id != document_id:
            raise not_found()
        if parent.parent_comment_id:
            raise conflict("Replies are one level deep")

    mentions = mentioned_user_ids(repositories, context.workspace_id, body)
    comment = build_comment(
        context.workspace_id,
        document.document_id,
        NO_TEAM,
        context.user_id,
        body,
        parent_comment_id=parent_comment_id,
        mentions=mentions,
        source=context.source,
        document_id=document.document_id,
        anchor=anchor,
    )
    try:
        created = repositories.comments.create(comment)
    except ConditionFailed as exc:
        raise conflict("That comment already exists") from exc

    if parent is not None and parent.resolution is not None:
        repositories.comments.set_resolution(context.workspace_id, document_id, parent.comment_id, None)

    subscriptions = repositories.subscriptions
    subscriptions.subscribe(context.workspace_id, document_id, NO_TEAM, context.user_id, "commenter")
    subscriptions.subscribe_many(context.workspace_id, document_id, NO_TEAM, mentions, "mentioned")
    return created


def edit_document_comment(
    repositories: Repositories, context: AuthzContext, document_id: str, comment_id: str, body: str
) -> Comment:
    """Rewrite one's own comment on a document, subscribing only the people the edit newly mentions."""
    if not body.strip():
        raise unprocessable("body must not be empty")
    comment = load_document_comment(repositories, context, document_id, comment_id)
    if comment.author_id != context.user_id:
        raise forbidden()
    mentions = mentioned_user_ids(repositories, context.workspace_id, body)
    updated = repositories.comments.edit(context.workspace_id, document_id, comment_id, body, mentions)
    if updated is None:
        raise not_found()
    added = [user_id for user_id in mentions if user_id not in comment.mentions]
    repositories.subscriptions.subscribe_many(context.workspace_id, document_id, NO_TEAM, added, "mentioned")
    return updated


def delete_document_comment(
    repositories: Repositories, context: AuthzContext, document_id: str, comment_id: str
) -> None:
    """Remove one comment on a document, reparenting its replies and dropping its reactions.

    The author, or anyone who may delete the document itself.
    """
    parent, document = load_readable_document(repositories, context, document_id)
    comment = repositories.comments.get(context.workspace_id, document_id, comment_id)
    if comment is None or comment.document_id != document_id:
        raise not_found()
    if comment.author_id != context.user_id and not Rights(repositories, context).can_delete(parent, document):
        raise forbidden()
    for reply in repositories.comments.iter_for_issue(context.workspace_id, document_id):
        if reply.parent_comment_id == comment_id:
            repositories.comments.clear_parent(context.workspace_id, document_id, reply.comment_id)
    repositories.reactions.delete_for_target(context.workspace_id, comment_id)
    repositories.comments.delete(context.workspace_id, document_id, comment_id)


def set_document_thread_resolution(
    repositories: Repositories, context: AuthzContext, document_id: str, comment_id: str, *, resolved: bool
) -> Comment:
    """Resolve or reopen one thread on a document, answering its root comment.

    Anyone who may comment may do either. A reply is a 409, and setting the state
    a thread already has changes nothing.
    """
    require_document_commenter(repositories, context, document_id)
    comment = repositories.comments.get(context.workspace_id, document_id, comment_id)
    if comment is None or comment.document_id != document_id:
        raise not_found()
    if comment.parent_comment_id:
        raise conflict("Only a thread's first comment can be resolved")
    if (comment.resolution is not None) == resolved:
        return comment
    resolution = ThreadResolution(resolved_by=context.user_id) if resolved else None
    updated = repositories.comments.set_resolution(context.workspace_id, document_id, comment_id, resolution)
    if updated is None:
        raise not_found()
    return updated


def list_document_subscribers(repositories: Repositories, context: AuthzContext, document_id: str) -> SubscribersRead:
    """Everyone following one document the caller may read, oldest first."""
    load_readable_document(repositories, context, document_id)
    return render_subscribers(repositories, context, document_id)


def _self(context: AuthzContext, user_id: str) -> str:
    """The caller's own id for `me` or their own id, a 422 for anyone else."""
    if user_id not in (ME, context.user_id):
        raise unprocessable("Only you can follow or leave a document for yourself")
    return context.user_id


def subscribe_to_document(
    repositories: Repositories, context: AuthzContext, document_id: str, user_id: str = ME
) -> SubscribersRead:
    """Follow one readable document as the caller, answering its subscribers."""
    target = _self(context, user_id)
    load_readable_document(repositories, context, document_id)
    repositories.subscriptions.subscribe(context.workspace_id, document_id, NO_TEAM, target, "manual")
    return render_subscribers(repositories, context, document_id)


def unsubscribe_from_document(
    repositories: Repositories, context: AuthzContext, document_id: str, user_id: str = ME
) -> SubscribersRead:
    """Stop following one readable document as the caller, answering its subscribers."""
    target = _self(context, user_id)
    load_readable_document(repositories, context, document_id)
    repositories.subscriptions.unsubscribe(context.workspace_id, document_id, target)
    return render_subscribers(repositories, context, document_id)
