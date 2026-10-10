"""Saved view routes: list, create, read, patch and delete.

A saved view stores a filter and never results. Running one is the M2 issue list
with the stored filter expanded into its query, which is why there is deliberately
no route returning a view's issues: a second read path would be a second place
team visibility is decided, and the invariant is that there is one.

Scope is derived from whether a team is named or the view is shared with the
workspace, never sent as a scope, and the owner comes
from the authorization context, so neither is something a caller can assert.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Path, Query, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.saved_views import (
    create_saved_view,
    delete_saved_view,
    favorite_ids,
    load_visible_view,
    readable_views,
    set_view_favorite,
    update_saved_view,
)
from app.domains.views.schemas.view import ScopeField, ViewCreate, ViewListRead, ViewRead, ViewUpdate

router = APIRouter()


@router.get("/{workspace_id}/views", response_model=ViewListRead)
def list_views(
    workspace_id: str = Path(..., min_length=1),
    scope: ScopeField = Query(default="mine"),
    team_id: Optional[str] = Query(default=None),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> ViewListRead:
    """Saved views the caller may read, narrowed by scope.

    `all` is the caller's own views plus the team views of teams they can see,
    which for a guest is only the teams they hold a membership in, so the listing
    is built from what they may read rather than filtered afterwards.
    """
    ordered = readable_views(repositories, context, scope, team_id)
    starred = favorite_ids(repositories, context)
    return ViewListRead(views=[ViewRead.from_row(row, favorite=row.view_id in starred) for row in ordered])


@router.post("/{workspace_id}/views", response_model=ViewRead, status_code=status.HTTP_201_CREATED)
def create_view(
    payload: ViewCreate,
    workspace_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> ViewRead:
    """Save a new view, personal unless it names a team.

    A team view needs the caller to be a member of that team: a reader could
    otherwise leave a shared view on a team they cannot write in.
    """
    return ViewRead.from_row(create_saved_view(repositories, context, payload))


@router.get("/{workspace_id}/views/{view_id}", response_model=ViewRead)
def read_view(
    workspace_id: str = Path(..., min_length=1),
    view_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> ViewRead:
    """One saved view the caller may read, or a 404."""
    view = load_visible_view(repositories, context, view_id)
    return ViewRead.from_row(view, favorite=view.view_id in favorite_ids(repositories, context))


@router.patch("/{workspace_id}/views/{view_id}", response_model=ViewRead)
def update_view(
    payload: ViewUpdate,
    workspace_id: str = Path(..., min_length=1),
    view_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> ViewRead:
    """Change a saved view's name, filter, sort, grouping or display settings.

    The display switches take true or false and never null, because a switch
    that could be neither would leave the client guessing what the view shows.
    """
    view = update_saved_view(repositories, context, view_id, payload)
    return ViewRead.from_row(view, favorite=view.view_id in favorite_ids(repositories, context))


@router.delete("/{workspace_id}/views/{view_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_view(
    workspace_id: str = Path(..., min_length=1),
    view_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> Response:
    """Remove a saved view, the owner's or a team admin's call."""
    delete_saved_view(repositories, context, view_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/{workspace_id}/views/{view_id}/favorite", response_model=ViewRead)
def favorite_view(
    workspace_id: str = Path(..., min_length=1),
    view_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> ViewRead:
    """Star a view the caller may read, so it lists under their favorites."""
    return ViewRead.from_row(set_view_favorite(repositories, context, view_id, True), favorite=True)


@router.delete("/{workspace_id}/views/{view_id}/favorite", response_model=ViewRead)
def unfavorite_view(
    workspace_id: str = Path(..., min_length=1),
    view_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> ViewRead:
    """Unstar a view, a no-op when it was not starred."""
    return ViewRead.from_row(set_view_favorite(repositories, context, view_id, False), favorite=False)
