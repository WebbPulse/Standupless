"""Team membership routes: who is in a team, and with which role.

A team membership is what lets a guest reach a team at all, so the routes that
add someone else are team admin only. Join and leave act on the caller alone:
any workspace member who can read a team may join it, a guest can only reach a
team they were added to, and anyone may leave unless they are its last admin.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.memberships import Membership
from app.domains.teams.schemas.team import (
    TeamMemberListRead,
    TeamMemberRead,
    TeamMemberUpdate,
)

router = APIRouter()

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

NOT_A_MEMBER = {
    "error_code": "NOT_A_WORKSPACE_MEMBER",
    "message": "That person is not a member of this workspace",
}

LAST_ADMIN = {
    "error_code": "LAST_TEAM_ADMIN",
    "message": "A team needs at least one admin. Make someone else an admin first",
}


@router.get("/{workspace_id}/teams/{team_id}/members", response_model=TeamMemberListRead)
def list_team_members(
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TeamMemberListRead:
    """Everyone explicitly added to this team, joined with their user rows."""
    memberships = repositories.memberships.list_team_members(context.workspace_id, str(context.team_id))
    users = repositories.users.get_many([m.user_id for m in memberships])
    return TeamMemberListRead(members=[TeamMemberRead.from_rows(m, users.get(m.user_id)) for m in memberships])


@router.put(
    "/{workspace_id}/teams/{team_id}/members/{user_id}",
    response_model=TeamMemberRead,
)
def put_team_member(
    payload: TeamMemberUpdate,
    user_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TeamMemberRead:
    """Add someone to the team, or change the role they already hold.

    Only an existing workspace member can be added, because a team membership
    is a narrowing of workspace access and never a grant of it.
    """
    if repositories.memberships.get(context.workspace_id, user_id) is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=NOT_A_MEMBER)
    if payload.role != "admin":
        _guard_last_admin(repositories, context, user_id)

    membership = repositories.memberships.set_team_role(
        context.workspace_id, str(context.team_id), user_id, payload.role
    )
    return TeamMemberRead.from_rows(membership, repositories.users.get(user_id))


@router.delete(
    "/{workspace_id}/teams/{team_id}/members/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_team_member(
    user_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Remove someone from the team. A guest loses access to it entirely."""
    _guard_last_admin(repositories, context, user_id)
    removed = repositories.memberships.delete_team_membership(context.workspace_id, str(context.team_id), user_id)
    if not removed:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{workspace_id}/teams/{team_id}/join",
    response_model=TeamMemberRead,
)
def join_team(
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TeamMemberRead:
    """Join a team as a member, or answer the membership already held unchanged.

    Every team is open to a workspace member. A guest reaches only the teams an
    admin added them to, so for a guest this never widens access.
    """
    team_id = str(context.team_id)
    if repositories.teams.get(context.workspace_id, team_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    membership = repositories.memberships.get_team_membership(context.workspace_id, team_id, context.user_id)
    if membership is None:
        membership = repositories.memberships.set_team_role(context.workspace_id, team_id, context.user_id, "member")
    return TeamMemberRead.from_rows(membership, repositories.users.get(context.user_id))


@router.post(
    "/{workspace_id}/teams/{team_id}/leave",
    status_code=status.HTTP_204_NO_CONTENT,
)
def leave_team(
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Leave a team. The last admin must hand the role on first."""
    team_id = str(context.team_id)
    _guard_last_admin(repositories, context, context.user_id)
    if not repositories.memberships.delete_team_membership(context.workspace_id, team_id, context.user_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _guard_last_admin(repositories: Repositories, context: AuthzContext, user_id: str) -> None:
    """Refuse with 409 when `user_id` is the team's only explicit admin."""
    members: list[Membership] = repositories.memberships.list_team_members(context.workspace_id, str(context.team_id))
    admins = [member.user_id for member in members if member.role == "admin"]
    if admins == [user_id]:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=LAST_ADMIN)
