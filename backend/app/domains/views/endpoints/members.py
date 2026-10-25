"""Member page routes: one person's profile and their recent activity.

Served under `/views` so the gateway's existing views prefix routes it, and
registered before the saved view routes so `members` is never read as a view id.
The assembly lives in `app.common.member_activity`, which accepts `me` for the
caller's own page.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Path, Query
from webbpulse.http import CursorPage

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.issues import DEFAULT_LIMIT, MAX_LIMIT
from app.common.api.schemas.member_pages import MemberActivityListRead, MemberActivityRead, MemberProfileRead
from app.common.member_activity import member_activity_page, member_profile

router = APIRouter()


@router.get("/{workspace_id}/views/members/{user_id}", response_model=MemberProfileRead)
def get_member_profile(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    user_id: Annotated[str, Path(min_length=1, max_length=64)],
) -> MemberProfileRead:
    """One member's page header: name, avatar, role and the teams of theirs the caller can see.

    A 404 when they are not a member of this workspace. No email is returned.
    """
    return member_profile(repositories, context, user_id)


@router.get("/{workspace_id}/views/members/{user_id}/activity", response_model=MemberActivityListRead)
def list_member_activity(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    user_id: Annotated[str, Path(min_length=1, max_length=64)],
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> CursorPage[MemberActivityRead]:
    """One page of a member's issue changes and comments, newest first.

    Only rows on issues the caller can read are returned, so a page can be short
    while `next_cursor` still walks the whole history.
    """
    items, next_cursor = member_activity_page(repositories, context, user_id, cursor=cursor, limit=limit)
    return MemberActivityListRead(items=items, next_cursor=next_cursor)
