"""Reaction routes: read one target's groups, add one, remove one.

A reaction is a `PUT` and a `DELETE` on the `(target, emoji, user)` triple rather
than a create and a delete by id, because the row's own sort key is
`<emoji>#<user_id>`: the caller already knows the key and there is nothing to hand
back. Both writes are therefore idempotent, which is what lets a client retry a tap
without reconciling.

The target is an issue or a comment, and the caller names which. A comment's target
id is resolved back to its issue before anything else happens, so both kinds end up
deciding visibility against exactly one issue's team. A comment on a document is
resolved back to its document instead, and decided against the document's parent.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.discussion_reads import group_reactions
from app.common.reaction_writes import add_reaction as add_reaction_row
from app.common.reaction_writes import remove_reaction as remove_reaction_row
from app.common.reaction_writes import resolve_target
from app.domains.discussion.schemas.discussion import (
    ReactionGroupRead,
    ReactionListRead,
    ReactionWrite,
    TargetKindQuery,
)

router = APIRouter()


@router.get("/{workspace_id}/reactions", response_model=ReactionListRead)
def list_reactions(
    target_id: Annotated[str, Query(min_length=1)],
    target_kind: TargetKindQuery,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    issue_id: Annotated[str | None, Query()] = None,
    document_id: Annotated[str | None, Query()] = None,
) -> ReactionListRead:
    """Every reaction on one target, grouped by emoji.

    Not paged: a group is a count over the whole partition, so a page boundary
    would hand back a count of part of it.
    """
    resolve_target(repositories, context, target_id, target_kind, issue_id, document_id)
    rows = repositories.reactions.list_for_target(context.workspace_id, target_id)
    return ReactionListRead(reactions=group_reactions(rows, context.user_id))


@router.put("/{workspace_id}/reactions", response_model=ReactionGroupRead)
def add_reaction(
    payload: ReactionWrite,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ReactionGroupRead:
    """React to a target, answering with that emoji's group as it now stands.

    Idempotent by key, so a second PUT by the same user is the same row and the
    same answer rather than a conflict. Only that emoji's group comes back, because
    that is the one the caller just changed and the rest are already on screen.
    A custom `:name:` must be an emoji the workspace has.
    """
    return add_reaction_row(
        repositories,
        context,
        payload.target_id,
        payload.target_kind,
        payload.emoji,
        issue_id=payload.issue_id,
        document_id=payload.document_id,
    )


@router.delete("/{workspace_id}/reactions", status_code=status.HTTP_204_NO_CONTENT)
def remove_reaction(
    target_id: Annotated[str, Query(min_length=1)],
    target_kind: TargetKindQuery,
    emoji: Annotated[str, Query(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    issue_id: Annotated[str | None, Query()] = None,
    document_id: Annotated[str | None, Query()] = None,
) -> Response:
    """Take back one's own reaction, whether or not it was there.

    The reacting user alone: the key names them, so there is no route by which one
    member removes another's reaction. Removing one that is absent is still 204,
    because the caller's intent is already satisfied.

    The emoji is normalised the way the write normalised it, so a client sending
    the variation selector form removes the row it created rather than missing it.
    """
    remove_reaction_row(
        repositories, context, target_id, target_kind, emoji, issue_id=issue_id, document_id=document_id
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
