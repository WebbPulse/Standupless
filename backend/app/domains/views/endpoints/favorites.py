"""Favorites routes: list, add, remove and reorder the caller's own favorites, and file them in folders.

A favorite is the caller's alone, so every route reads and writes only their
row, and the target is checked against what they may read on add and on every
listing. Removing never reads the target, so a favorite on something deleted can
still be cleared.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Path, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.favorites import (
    FavoriteFolderRead,
    FavoriteFolderWrite,
    FavoriteKindField,
    FavoriteListRead,
    FavoriteOrder,
    FavoriteRead,
    FavoriteRef,
)
from app.common.favorites import (
    add_favorite,
    create_folder,
    delete_folder,
    list_favorites,
    remove_favorite,
    rename_folder,
    reorder_favorites,
)

router = APIRouter()


@router.get("/{workspace_id}/favorites", response_model=FavoriteListRead)
def read_favorites(
    workspace_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> FavoriteListRead:
    """The caller's favorites in their order, each resolved to what the sidebar draws, and their folders."""
    return list_favorites(repositories, context)


@router.post("/{workspace_id}/favorites", response_model=FavoriteRead)
def create_favorite(
    payload: FavoriteRef,
    workspace_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> FavoriteRead:
    """Star an issue, project, cycle, view, team, document or initiative the caller may read."""
    return add_favorite(repositories, context, payload)


@router.put("/{workspace_id}/favorites/order", response_model=FavoriteListRead)
def order_favorites(
    payload: FavoriteOrder,
    workspace_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> FavoriteListRead:
    """Put the caller's favorites and folders in a new order, answering the reordered listing."""
    return reorder_favorites(repositories, context, payload)


@router.post("/{workspace_id}/favorites/folders", response_model=FavoriteFolderRead)
def create_favorite_folder(
    payload: FavoriteFolderWrite,
    workspace_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> FavoriteFolderRead:
    """Add an empty favorite folder below the caller's others."""
    return create_folder(repositories, context, payload.name)


@router.patch("/{workspace_id}/favorites/folders/{folder_id}", response_model=FavoriteFolderRead)
def update_favorite_folder(
    payload: FavoriteFolderWrite,
    workspace_id: str = Path(..., min_length=1),
    folder_id: str = Path(..., min_length=1, max_length=64),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> FavoriteFolderRead:
    """Rename one of the caller's favorite folders."""
    return rename_folder(repositories, context, folder_id, payload.name)


@router.delete("/{workspace_id}/favorites/folders/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_favorite_folder(
    workspace_id: str = Path(..., min_length=1),
    folder_id: str = Path(..., min_length=1, max_length=64),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> Response:
    """Delete one of the caller's favorite folders, its favorites moving to the top level; a no-op when absent."""
    delete_folder(repositories, context, folder_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/{workspace_id}/favorites/{kind}/{target_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_favorite(
    kind: FavoriteKindField,
    workspace_id: str = Path(..., min_length=1),
    target_id: str = Path(..., min_length=1, max_length=64),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> Response:
    """Unstar one favorite, a no-op when it was not starred."""
    remove_favorite(repositories, context, kind, target_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
