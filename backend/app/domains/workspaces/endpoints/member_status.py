"""Away status routes: a member sets or clears their own status in a workspace.

Only the member themselves writes it, so the routes name `me` rather than a user
id, and a guest may set theirs too. A workspace key acts for nobody and is
refused. The status is read back on every member surface.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from app.common import member_status
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.member_status import UserStatusUpdate
from app.common.api.schemas.workspaces import MemberRead

router = APIRouter()


@router.put("/{workspace_id}/members/me/status", response_model=MemberRead)
def set_my_status(
    payload: UserStatusUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> MemberRead:
    """Set the caller's status here, replacing any status they had.

    It clears itself once `until` passes, with nothing to sweep it.
    """
    membership = member_status.set_my_status(repositories, context, payload)
    return MemberRead.from_rows(membership, repositories.users.get(context.user_id))


@router.delete("/{workspace_id}/members/me/status", response_model=MemberRead)
def clear_my_status(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> MemberRead:
    """Clear the caller's status here, answering their member row without one."""
    membership = member_status.clear_my_status(repositories, context)
    return MemberRead.from_rows(membership, repositories.users.get(context.user_id))
