"""The thread rules every status update shares, whichever project or initiative it is about.

A project update and an initiative update each carry the same thread: replies
and emoji reactions, on the update and on its replies. What differs is only how
the update is reached and who moderates it, so each subject resolves a
`ThreadHost` first and every read and write below runs on that. Anyone who may
read the update replies and reacts; a reply's author, or whoever the host names
as a moderator, edits or deletes it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, TypeVar

from fastapi import HTTPException, status
from pydantic import BaseModel
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.update_threads import (
    ProjectUpdateCommentCreate,
    ProjectUpdateCommentPatch,
    ProjectUpdateCommentRead,
    ProjectUpdateReactionWrite,
)
from app.common.custom_emoji import require_custom_emoji
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.update_threads import (
    UpdateComment,
    UpdateThread,
    UpdateThreadStore,
    build_update_comment,
    build_update_reaction,
)
from app.common.discussion_reads import (
    AuthorRead,
    ReactionGroupRead,
    authors_for,
    group_reactions,
    reaction_key,
)
from app.common.mentions import mentioned_user_ids
from app.common.planning_rules import forbidden, not_found


@dataclass(frozen=True)
class ThreadHost:
    """One readable update a thread hangs off, the store holding it and who moderates its replies.

    `may_moderate` answers, for a reply's author, whether the caller may edit or
    delete that reply.
    """

    store: UpdateThreadStore
    parent_id: str
    update_id: str
    may_moderate: Callable[[str], bool]


SummarisedRead = TypeVar("SummarisedRead", bound=BaseModel)


def summarise_threads(
    context: AuthzContext,
    store: UpdateThreadStore,
    parent_id: str,
    rows: list[SummarisedRead],
    update_id_of: Callable[[SummarisedRead], str],
) -> list[SummarisedRead]:
    """A feed's updates with each one's reaction groups and reply count filled in."""
    if not rows:
        return rows
    threads = store.read_many(context.workspace_id, parent_id, [update_id_of(row) for row in rows])
    summarised: list[SummarisedRead] = []
    for row in rows:
        update_id = update_id_of(row)
        thread = threads.get(update_id, UpdateThread())
        summarised.append(
            row.model_copy(
                update={
                    "reactions": group_reactions(thread.reactions_on(update_id), context.user_id),
                    "comment_count": len(thread.comments),
                }
            )
        )
    return summarised


def _comment_read(
    context: AuthzContext,
    host: ThreadHost,
    comment: UpdateComment,
    thread: UpdateThread,
    authors: dict[str, AuthorRead],
) -> ProjectUpdateCommentRead:
    """One reply in its response shape, joined to its author and reactions."""
    return ProjectUpdateCommentRead.from_row(
        comment,
        author=authors.get(comment.author_id, AuthorRead(user_id=comment.author_id)),
        reactions=group_reactions(thread.reactions_on(comment.comment_id), context.user_id),
        can_edit=comment.author_id == context.user_id or host.may_moderate(comment.author_id),
    )


def thread_comments(
    repositories: Repositories, context: AuthzContext, host: ThreadHost
) -> list[ProjectUpdateCommentRead]:
    """Every reply on one readable update, oldest first."""
    thread = host.store.read(context.workspace_id, host.parent_id, host.update_id)
    authors = authors_for(repositories, [comment.author_id for comment in thread.comments])
    return [_comment_read(context, host, comment, thread, authors) for comment in thread.comments]


def post_comment(
    repositories: Repositories, context: AuthzContext, host: ThreadHost, payload: ProjectUpdateCommentCreate
) -> ProjectUpdateCommentRead:
    """Reply on a readable update; the notify consumer tells who the subject's audience rule names."""
    comment = build_update_comment(
        context.workspace_id,
        host.parent_id,
        host.update_id,
        body=payload.body,
        author_id=context.user_id,
        mentions=mentioned_user_ids(repositories, context.workspace_id, payload.body),
        source=context.source,
        subject=host.store.subject,
    )
    try:
        host.store.create_comment(comment)
    except ConditionFailed as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error_code": "CONFLICT", "message": "That reply already exists"},
        ) from exc
    authors = authors_for(repositories, [comment.author_id])
    return _comment_read(context, host, comment, UpdateThread(), authors)


def _editable_comment(context: AuthzContext, host: ThreadHost, comment_id: str) -> UpdateComment:
    """One reply the caller may change, or a 404 when absent and a 403 when it is someone else's."""
    comment = host.store.get_comment(context.workspace_id, host.parent_id, host.update_id, comment_id)
    if comment is None:
        raise not_found()
    if comment.author_id != context.user_id and not host.may_moderate(comment.author_id):
        raise forbidden()
    return comment


def edit_comment(
    repositories: Repositories,
    context: AuthzContext,
    host: ThreadHost,
    comment_id: str,
    payload: ProjectUpdateCommentPatch,
) -> ProjectUpdateCommentRead:
    """Rewrite a reply's body, stamping when it was edited."""
    existing = _editable_comment(context, host, comment_id)
    edited = existing.model_copy(
        update={
            "body": payload.body,
            "mentions": mentioned_user_ids(repositories, context.workspace_id, payload.body),
            "edited_at": utc_now(),
        }
    )
    try:
        host.store.replace_comment(edited)
    except ConditionFailed as exc:
        raise not_found() from exc
    thread = host.store.read(context.workspace_id, host.parent_id, host.update_id)
    authors = authors_for(repositories, [edited.author_id])
    return _comment_read(context, host, edited, thread, authors)


def remove_comment(context: AuthzContext, host: ThreadHost, comment_id: str) -> None:
    """Delete a reply and every reaction on it."""
    comment = _editable_comment(context, host, comment_id)
    host.store.delete_comment(context.workspace_id, host.parent_id, host.update_id, comment.comment_id)


def _reaction_target(context: AuthzContext, host: ThreadHost, comment_id: str | None) -> str:
    """The id of what is reacted to: the update itself or one of its replies, or a 404."""
    if not comment_id:
        return host.update_id
    comment = host.store.get_comment(context.workspace_id, host.parent_id, host.update_id, comment_id)
    if comment is None:
        raise not_found()
    return comment.comment_id


def react(
    repositories: Repositories, context: AuthzContext, host: ThreadHost, payload: ProjectUpdateReactionWrite
) -> ReactionGroupRead:
    """React to a readable update or one of its replies, answering that emoji's group."""
    target_id = _reaction_target(context, host, payload.comment_id)
    require_custom_emoji(repositories, context.workspace_id, payload.emoji)
    host.store.add_reaction(
        build_update_reaction(
            context.workspace_id,
            host.parent_id,
            host.update_id,
            target_id=target_id,
            emoji=payload.emoji,
            user_id=context.user_id,
            subject=host.store.subject,
        )
    )
    thread = host.store.read(context.workspace_id, host.parent_id, host.update_id)
    groups = [
        group
        for group in group_reactions(thread.reactions_on(target_id), context.user_id)
        if group.emoji == payload.emoji
    ]
    if groups:
        return groups[0]
    return ReactionGroupRead(emoji=payload.emoji, count=1, user_ids=[context.user_id], reacted=True)


def unreact(context: AuthzContext, host: ThreadHost, emoji: str, comment_id: str | None) -> None:
    """Take the caller's reaction off an update or one of its replies; a missing one is a no-op."""
    target_id = _reaction_target(context, host, comment_id)
    host.store.remove_reaction(
        context.workspace_id, host.parent_id, host.update_id, target_id, reaction_key(emoji), context.user_id
    )
