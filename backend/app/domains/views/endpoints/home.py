"""Workspace home route: one aggregate read for the landing page.

Served under `/views` so the gateway's existing views prefix routes it, and
registered before the saved view routes so `home` is never read as a view id.
The assembly lives in `app.common.home`.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.home import HomeRead
from app.common.home import UnknownTimezone, home_for
from app.common.issue_rules import unprocessable

router = APIRouter()


@router.get("/{workspace_id}/views/home", response_model=HomeRead)
def get_home(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    tz: Annotated[str, Query(min_length=1, max_length=64)] = "UTC",
) -> HomeRead:
    """The caller's workspace home: their focus, their teams' cycles, projects, what shipped and the inbox.

    `tz` is the caller's IANA timezone, which decides what today is for due
    dates and cycles. Every list is bounded, so the read costs the same on a
    quiet workspace and a busy one.
    """
    try:
        return home_for(repositories, context, timezone=tz)
    except UnknownTimezone as exc:
        raise unprocessable(str(exc)) from exc
