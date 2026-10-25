"""List fold routes: the caller's folded groups and hidden board columns on a list that is not a saved view.

A saved view carries its folds on the view itself, shared by everyone who opens
it. A team's issues, a cycle, a project's issues and the personal lists keep
them per person here instead, so they follow the person to every device.
Served under `/views` so the gateway's views prefix routes them to the domain
that owns the views table they live in.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.views import LIST_KEY_PATTERN, ListFoldsRead, ListFoldsWrite

router = APIRouter()


@router.get("/{workspace_id}/views/folds", response_model=ListFoldsRead)
def read_list_folds(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    list_key: Annotated[str, Query(pattern=LIST_KEY_PATTERN)],
) -> ListFoldsRead:
    """The caller's folds on one list, empty when they never folded anything there."""
    row = repositories.views.get_list_folds(context.workspace_id, context.user_id, list_key)
    return ListFoldsRead(list_key=list_key, collapsed_groups=list(row.collapsed) if row else [])


@router.put("/{workspace_id}/views/folds", response_model=ListFoldsRead)
def write_list_folds(
    body: ListFoldsWrite,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ListFoldsRead:
    """Replace the caller's folds on one list; an empty list clears them and keeps no row."""
    kept = repositories.views.set_list_folds(
        context.workspace_id, context.user_id, body.list_key, list(body.collapsed_groups)
    )
    return ListFoldsRead(list_key=body.list_key, collapsed_groups=kept)
