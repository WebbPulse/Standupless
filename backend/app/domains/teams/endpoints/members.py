"""Team membership routes: who is in a team, and with which role.

A team membership is what lets a guest reach a team at all, so the routes that
add someone else are team admin only. Join and leave act on the caller alone:
any workspace member who can read a team may join it, a guest can only reach a
team they were added to, and anyone may leave unless they are its last admin.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Response, status

from app.common import team_members
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.teams import (
    TeamMemberListRead,
    TeamMemberRead,
    TeamMemberUpdate,
)

router = APIRouter()


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
    membership = team_members.put_team_member(
        repositories, context.workspace_id, str(context.team_id), user_id, payload.role
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
    team_members.remove_team_member(repositories, context.workspace_id, str(context.team_id), user_id)
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
    membership = team_members.join_team(repositories, context.workspace_id, str(context.team_id), context.user_id)
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
    team_members.leave_team(repositories, context.workspace_id, str(context.team_id), context.user_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
