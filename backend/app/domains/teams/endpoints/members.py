"""Team membership routes: who is in a team, and with which role.

A team membership is what lets a guest reach a team at all, so the routes that
add someone else are team admin only. Join and leave act on the caller alone:
any workspace member who can read an open team may join it, a private team and
a guest only reach those a team admin added, though a workspace owner or admin
may join a private team, and anyone may leave unless they are its last admin.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Request, Response, status
from webbpulse.http import conditional_response

from app.common import member_status, team_members
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
    request: Request,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Everyone explicitly added to this team, joined with their user rows and current statuses.

    Every row shares this team with the caller, so a guest who can read it may see
    each member's status. The answer carries a weak `ETag`, so an unchanged poll
    gets a 304.
    """
    memberships = repositories.memberships.list_team_members(context.workspace_id, str(context.team_id))
    user_ids = [m.user_id for m in memberships]
    users = repositories.users.get_many(user_ids)
    workspace_rows = repositories.memberships.get_many(context.workspace_id, user_ids)
    listing = TeamMemberListRead(
        members=[
            TeamMemberRead.from_rows(
                m,
                users.get(m.user_id),
                user_status=member_status.status_for(workspace_rows.get(m.user_id), None),
            )
            for m in memberships
        ]
    )
    return conditional_response(request, listing)


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
    membership = team_members.put_team_member(repositories, context, str(context.team_id), user_id, payload.role)
    return TeamMemberRead.from_rows(membership, repositories.users.get(user_id))


@router.delete(
    "/{workspace_id}/teams/{team_id}/members/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_team_member(
    user_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN, allow_retired=True))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Remove someone from the team. A guest loses access to it entirely."""
    team_members.remove_team_member(repositories, context, str(context.team_id), user_id)
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

    An open team is open to a workspace member. A private team answers not found
    to anyone outside it but a workspace owner or admin, and a guest reaches only
    the teams an admin added them to, so this never widens access for either.
    """
    membership = team_members.join_team(repositories, context, str(context.team_id))
    return TeamMemberRead.from_rows(membership, repositories.users.get(context.user_id))


@router.post(
    "/{workspace_id}/teams/{team_id}/leave",
    status_code=status.HTTP_204_NO_CONTENT,
)
def leave_team(
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ, allow_retired=True))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Leave a team. The last admin must hand the role on first."""
    team_members.leave_team(repositories, context, str(context.team_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
