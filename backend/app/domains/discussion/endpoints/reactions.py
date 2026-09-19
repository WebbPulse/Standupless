"""Reaction routes: read one target's groups, add one, remove one.

A reaction is a `PUT` and a `DELETE` on the `(target, emoji, user)` triple rather
than a create and a delete by id, because the row's own sort key is
`<emoji>#<user_id>`: the caller already knows the key and there is nothing to hand
back. Both writes are therefore idempotent, which is what lets a client retry a tap
without reconciling.

The target is an issue or a comment, and the caller names which. A comment's target
id is resolved back to its issue before anything else happens, so both kinds end up
deciding visibility against exactly one issue's project.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.reactions import build_reaction
from app.domains.discussion.schemas.discussion import (
    ReactionGroupRead,
    ReactionListRead,
    ReactionWrite,
    TargetKindQuery,
    normalize_emoji,
)
from app.domains.discussion.service import (
    forbidden,
    group_reactions,
    load_visible_issue,
    not_found,
    require_project_member,
)

router = APIRouter()


def _resolve_target(
    repositories: Repositories,
    context: AuthzContext,
    target_id: str,
    target_kind: str,
    issue_id: str | None,
) -> Issue:
    """The issue one reaction target belongs to, or a 404.

    An `issue` target is its own issue. A `comment` target needs the issue that
    partitions it, which the caller supplies as `issue_id`; the comment is then read
    to hold that it really is in that issue, so a caller cannot pair someone else's
    comment id with an issue they can see and react across a project boundary.
    """
    if target_kind == "issue":
        return load_visible_issue(repositories, context, target_id)

    if not issue_id:
        raise not_found()
    issue = load_visible_issue(repositories, context, issue_id)
    comment = repositories.comments.get(context.workspace_id, issue_id, target_id)
    if comment is None:
        raise not_found()
    return issue


@router.get("/{workspace_id}/reactions", response_model=ReactionListRead)
def list_reactions(
    target_id: Annotated[str, Query(min_length=1)],
    target_kind: TargetKindQuery,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    issue_id: Annotated[str | None, Query()] = None,
) -> ReactionListRead:
    """Every reaction on one target, grouped by emoji.

    Not paged: a group is a count over the whole partition, so a page boundary
    would hand back a count of part of it.
    """
    _resolve_target(repositories, context, target_id, target_kind, issue_id)
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
    """
    issue = _resolve_target(repositories, context, payload.target_id, payload.target_kind, payload.issue_id)
    require_project_member(repositories, context, issue.project_id)

    repositories.reactions.put(
        build_reaction(
            context.workspace_id,
            payload.target_id,
            payload.target_kind,
            issue.project_id,
            payload.emoji,
            context.user_id,
        )
    )

    rows = repositories.reactions.list_for_target(context.workspace_id, payload.target_id)
    groups = [group for group in group_reactions(rows, context.user_id) if group.emoji == payload.emoji]
    if not groups:
        raise not_found()
    return groups[0]


@router.delete("/{workspace_id}/reactions", status_code=status.HTTP_204_NO_CONTENT)
def remove_reaction(
    target_id: Annotated[str, Query(min_length=1)],
    target_kind: TargetKindQuery,
    emoji: Annotated[str, Query(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    issue_id: Annotated[str | None, Query()] = None,
) -> Response:
    """Take back one's own reaction, whether or not it was there.

    The reacting user alone: the key names them, so there is no route by which one
    member removes another's reaction. Removing one that is absent is still 204,
    because the caller's intent is already satisfied.

    The emoji is normalised the way the write normalised it, so a client sending
    the variation selector form removes the row it created rather than missing it.
    """
    issue = _resolve_target(repositories, context, target_id, target_kind, issue_id)
    if not context.can_see_project(issue.project_id):
        raise forbidden()

    repositories.reactions.delete(context.workspace_id, target_id, normalize_emoji(emoji), context.user_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
