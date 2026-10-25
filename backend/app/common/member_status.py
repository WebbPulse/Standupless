"""A member's away status: who may set it, and who may see it.

The status lives on the person's workspace membership row, so it belongs to one
workspace and is read wherever a member is. Nothing sweeps it: a status whose
`until` has passed is ignored on read, and the next write replaces it.

Only the member sets their own status. Workspace members see everyone's, and a
guest sees their own and that of people who share one of their teams. The routes
and the MCP tools both call these, so the two surfaces cannot drift apart.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Optional

from fastapi import HTTPException, status

from app.common.api.dependencies.authz import ActorKind, AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.member_status import UserStatusRead, UserStatusUpdate, current_status
from app.common.db.dynamo.memberships import Membership

NOT_A_PERSON = {
    "error_code": "API_KEY_ACTOR_REFUSED",
    "message": "A workspace key has no person to set a status for",
}

NOT_A_MEMBER = {"error_code": "NOT_FOUND", "message": "Resource not found"}


def visible_user_ids(repositories: Repositories, context: AuthzContext) -> Optional[set[str]]:
    """The people whose status this caller may see, or `None` for everyone.

    A guest sees their own and that of anyone on one of their teams. Everyone else
    in the workspace sees every member's.
    """
    if not context.is_guest:
        return None
    visible = {context.user_id}
    for team_id in context.team_ids:
        visible.update(row.user_id for row in repositories.memberships.list_team_members(context.workspace_id, team_id))
    return visible


def status_for(membership: Optional[Membership], visible: Optional[set[str]]) -> Optional[UserStatusRead]:
    """One member's status as a caller with this visible set may see it."""
    if membership is None:
        return None
    if visible is not None and membership.user_id not in visible:
        return None
    return current_status(membership.user_status)


def statuses_for(
    repositories: Repositories, context: AuthzContext, user_ids: Iterable[str]
) -> dict[str, UserStatusRead]:
    """The current statuses of the named people this caller may see, keyed by user id.

    One batch read of the workspace memberships, for surfaces that list team rows
    or users rather than workspace members.
    """
    wanted = [user_id for user_id in dict.fromkeys(user_ids) if user_id]
    visible = visible_user_ids(repositories, context)
    if visible is not None:
        wanted = [user_id for user_id in wanted if user_id in visible]
    if not wanted:
        return {}
    rows = repositories.memberships.get_many(context.workspace_id, wanted)
    answer: dict[str, UserStatusRead] = {}
    for user_id, membership in rows.items():
        current = current_status(membership.user_status)
        if current is not None:
            answer[user_id] = current
    return answer


def _require_person(context: AuthzContext) -> None:
    """Refuse a workspace key, which acts for nobody."""
    if context.actor is ActorKind.SERVICE:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=NOT_A_PERSON)


def set_my_status(repositories: Repositories, context: AuthzContext, payload: UserStatusUpdate) -> Membership:
    """Set the caller's own status in this workspace, answering the updated membership."""
    _require_person(context)
    updated = repositories.memberships.set_user_status(context.workspace_id, context.user_id, payload.stored())
    if updated is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_A_MEMBER)
    return updated


def clear_my_status(repositories: Repositories, context: AuthzContext) -> Membership:
    """Clear the caller's own status in this workspace, answering the updated membership."""
    _require_person(context)
    updated = repositories.memberships.set_user_status(context.workspace_id, context.user_id, None)
    if updated is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_A_MEMBER)
    return updated
