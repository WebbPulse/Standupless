"""Project membership routes: who is in a project, and with which role.

A project membership is what lets a guest reach a project at all, so these routes
are the only way a guest's access widens. They are project admin only.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.domains.projects.schemas.project import (
    ProjectMemberListRead,
    ProjectMemberRead,
    ProjectMemberUpdate,
)

router = APIRouter()

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

NOT_A_MEMBER = {
    "error_code": "NOT_A_WORKSPACE_MEMBER",
    "message": "That person is not a member of this workspace",
}


@router.get("/{workspace_id}/projects/{project_id}/members", response_model=ProjectMemberListRead)
def list_project_members(
    context: Annotated[AuthzContext, Depends(require(Capability.PROJECT_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ProjectMemberListRead:
    """Everyone explicitly added to this project, joined with their user rows."""
    memberships = repositories.memberships.list_project_members(context.workspace_id, str(context.project_id))
    users = repositories.users.get_many([m.user_id for m in memberships])
    return ProjectMemberListRead(members=[ProjectMemberRead.from_rows(m, users.get(m.user_id)) for m in memberships])


@router.put(
    "/{workspace_id}/projects/{project_id}/members/{user_id}",
    response_model=ProjectMemberRead,
)
def put_project_member(
    payload: ProjectMemberUpdate,
    user_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.PROJECT_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ProjectMemberRead:
    """Add someone to the project, or change the role they already hold.

    Only an existing workspace member can be added, because a project membership
    is a narrowing of workspace access and never a grant of it.
    """
    if repositories.memberships.get(context.workspace_id, user_id) is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=NOT_A_MEMBER)

    membership = repositories.memberships.set_project_role(
        context.workspace_id, str(context.project_id), user_id, payload.role
    )
    return ProjectMemberRead.from_rows(membership, repositories.users.get(user_id))


@router.delete(
    "/{workspace_id}/projects/{project_id}/members/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_project_member(
    user_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.PROJECT_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Remove someone from the project. A guest loses access to it entirely."""
    removed = repositories.memberships.delete_project_membership(context.workspace_id, str(context.project_id), user_id)
    if not removed:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
