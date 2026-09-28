"""Team membership writes: add, change a role, remove, join and leave.

Shared by the team member routes and the MCP tools, because the integrations image
may not import another domain's code and a membership an agent writes must obey
the same last-admin rule a person's does. The caller has already been held to the
route's capability: team admin for another person, team read for themselves.
"""

from __future__ import annotations

from fastapi import HTTPException, status

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.memberships import Membership

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

NOT_A_MEMBER = {
    "error_code": "NOT_A_WORKSPACE_MEMBER",
    "message": "That person is not a member of this workspace",
}

LAST_ADMIN = {
    "error_code": "LAST_TEAM_ADMIN",
    "message": "A team needs at least one admin. Make someone else an admin first",
}


def guard_last_admin(repositories: Repositories, workspace_id: str, team_id: str, user_id: str) -> None:
    """Refuse with 409 when `user_id` is the team's only explicit admin."""
    members = repositories.memberships.list_team_members(workspace_id, team_id)
    admins = [member.user_id for member in members if member.role == "admin"]
    if admins == [user_id]:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=LAST_ADMIN)


def put_team_member(repositories: Repositories, workspace_id: str, team_id: str, user_id: str, role: str) -> Membership:
    """Add someone to a team, or change the role they already hold.

    Only an existing workspace member can be added, because a team membership is a
    narrowing of workspace access and never a grant of it.
    """
    if repositories.memberships.get(workspace_id, user_id) is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=NOT_A_MEMBER)
    if role != "admin":
        guard_last_admin(repositories, workspace_id, team_id, user_id)
    return repositories.memberships.set_team_role(workspace_id, team_id, user_id, role)


def remove_team_member(repositories: Repositories, workspace_id: str, team_id: str, user_id: str) -> None:
    """Remove someone from a team, or 404 when they hold no membership in it."""
    guard_last_admin(repositories, workspace_id, team_id, user_id)
    if not repositories.memberships.delete_team_membership(workspace_id, team_id, user_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)


def join_team(repositories: Repositories, workspace_id: str, team_id: str, user_id: str) -> Membership:
    """Join a team as a member, or answer the membership already held unchanged."""
    if repositories.teams.get(workspace_id, team_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    membership = repositories.memberships.get_team_membership(workspace_id, team_id, user_id)
    if membership is None:
        membership = repositories.memberships.set_team_role(workspace_id, team_id, user_id, "member")
    return membership


def leave_team(repositories: Repositories, workspace_id: str, team_id: str, user_id: str) -> None:
    """Leave a team. The last admin must hand the role on first."""
    remove_team_member(repositories, workspace_id, team_id, user_id)
