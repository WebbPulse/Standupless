"""Comment and subscriber routes under a document.

Nested under the document because a document's thread is partitioned by its id
the way an issue's is, so a read is one query and every comment route can
decide visibility against the document's parent before touching a row.
Comments render through the same join as an issue's, so reactions and authors
come back inline.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Path, Query, Response, status
from webbpulse.http import CursorPage

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.issues import SubscribersRead
from app.common.document_comments import (
    create_document_comment,
    delete_document_comment,
    document_comment_page,
    edit_document_comment,
    list_document_subscribers,
    set_document_thread_resolution,
    subscribe_to_document,
    unsubscribe_from_document,
)
from app.domains.discussion.endpoints.comments import _render
from app.domains.discussion.schemas.discussion import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    CommentListRead,
    CommentRead,
    DocumentCommentCreate,
    DocumentCommentUpdate,
)

router = APIRouter()

DocumentId = Annotated[str, Path(min_length=1)]
CommentId = Annotated[str, Path(min_length=1)]
Context = Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))]
Repos = Annotated[Repositories, Depends(get_repositories)]


def _counts(repositories: Repositories, context: AuthzContext, document_id: str) -> dict[str, int]:
    """Direct reply counts across the whole thread, so a parent near a page boundary is counted right."""
    return repositories.comments.count_replies(repositories.comments.iter_for_issue(context.workspace_id, document_id))


@router.get("/{workspace_id}/documents/{document_id}/comments", response_model=CommentListRead)
def list_document_comments(
    document_id: DocumentId,
    context: Context,
    repositories: Repos,
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> CursorPage[CommentRead]:
    """One page of a document's thread, oldest first."""
    rows, next_cursor = document_comment_page(repositories, context, document_id, cursor=cursor, limit=limit)
    return CommentListRead(
        items=_render(repositories, context, rows, reply_counts=_counts(repositories, context, document_id)),
        next_cursor=next_cursor,
    )


@router.post(
    "/{workspace_id}/documents/{document_id}/comments",
    response_model=CommentRead,
    status_code=status.HTTP_201_CREATED,
)
def post_document_comment(
    payload: DocumentCommentCreate, document_id: DocumentId, context: Context, repositories: Repos
) -> CommentRead:
    """Add a comment or a reply to a document, subscribing the author and everyone it mentions."""
    created = create_document_comment(
        repositories, context, document_id, payload.body, parent_comment_id=payload.parent_comment_id
    )
    return _render(repositories, context, [created])[0]


@router.patch("/{workspace_id}/documents/{document_id}/comments/{comment_id}", response_model=CommentRead)
def patch_document_comment(
    payload: DocumentCommentUpdate,
    document_id: DocumentId,
    comment_id: CommentId,
    context: Context,
    repositories: Repos,
) -> CommentRead:
    """Rewrite one's own comment on a document."""
    updated = edit_document_comment(repositories, context, document_id, comment_id, payload.body)
    return _render(repositories, context, [updated], reply_counts=_counts(repositories, context, document_id))[0]


@router.delete(
    "/{workspace_id}/documents/{document_id}/comments/{comment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_document_comment(
    document_id: DocumentId, comment_id: CommentId, context: Context, repositories: Repos
) -> Response:
    """Remove one comment on a document, as its author or anyone who may delete the document."""
    delete_document_comment(repositories, context, document_id, comment_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put(
    "/{workspace_id}/documents/{document_id}/comments/{comment_id}/resolution",
    response_model=CommentRead,
)
def resolve_document_thread(
    document_id: DocumentId, comment_id: CommentId, context: Context, repositories: Repos
) -> CommentRead:
    """Resolve one thread on a document, answering its root comment."""
    comment = set_document_thread_resolution(repositories, context, document_id, comment_id, resolved=True)
    return _render(repositories, context, [comment], reply_counts=_counts(repositories, context, document_id))[0]


@router.delete(
    "/{workspace_id}/documents/{document_id}/comments/{comment_id}/resolution",
    response_model=CommentRead,
)
def unresolve_document_thread(
    document_id: DocumentId, comment_id: CommentId, context: Context, repositories: Repos
) -> CommentRead:
    """Reopen one resolved thread on a document, answering its root comment."""
    comment = set_document_thread_resolution(repositories, context, document_id, comment_id, resolved=False)
    return _render(repositories, context, [comment], reply_counts=_counts(repositories, context, document_id))[0]


@router.get("/{workspace_id}/documents/{document_id}/subscribers", response_model=SubscribersRead)
def get_document_subscribers(document_id: DocumentId, context: Context, repositories: Repos) -> SubscribersRead:
    """Everyone following a document, and whether the caller is among them."""
    return list_document_subscribers(repositories, context, document_id)


@router.put("/{workspace_id}/documents/{document_id}/subscribers/{user_id}", response_model=SubscribersRead)
def put_document_subscriber(
    document_id: DocumentId,
    user_id: Annotated[str, Path(min_length=1)],
    context: Context,
    repositories: Repos,
) -> SubscribersRead:
    """Follow a document as the caller, `me` naming them."""
    return subscribe_to_document(repositories, context, document_id, user_id)


@router.delete("/{workspace_id}/documents/{document_id}/subscribers/{user_id}", response_model=SubscribersRead)
def delete_document_subscriber(
    document_id: DocumentId,
    user_id: Annotated[str, Path(min_length=1)],
    context: Context,
    repositories: Repos,
) -> SubscribersRead:
    """Stop following a document as the caller, `me` naming them."""
    return unsubscribe_from_document(repositories, context, document_id, user_id)
