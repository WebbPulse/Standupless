"""Saved view routes: list, create, read, patch and delete.

A saved view stores a filter and never results. Running one is the M2 issue list
with the stored filter expanded into its query, which is why there is deliberately
no route returning a view's issues: a second read path would be a second place
project visibility is decided, and the invariant is that there is one.

Scope is derived from whether a project is named, never sent, and the owner comes
from the authorization context, so neither is something a caller can assert.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Path, Query, Response, status
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.views import SavedView, new_view_id, view_key_for
from app.domains.views.schemas.view import (
    ScopeField,
    ViewCreate,
    ViewListRead,
    ViewRead,
    ViewUpdate,
    unknown_filter_keys,
)
from app.domains.views.service import (
    invalid_filter,
    load_visible_view,
    not_found,
    require_project_member,
    require_project_reader,
    require_view_writer,
    unprocessable,
    visible_project_ids,
)

router = APIRouter()


@router.get("/{workspace_id}/views", response_model=ViewListRead)
def list_views(
    workspace_id: str = Path(..., min_length=1),
    scope: ScopeField = Query(default="mine"),
    project_id: Optional[str] = Query(default=None),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> ViewListRead:
    """Saved views the caller may read, narrowed by scope.

    `all` is the caller's own views plus the project views of projects they can see,
    which for a guest is only the projects they hold a membership in, so the listing
    is built from what they may read rather than filtered afterwards.
    """
    rows: list[SavedView] = []

    if scope in ("mine", "all"):
        rows.extend(repositories.views.list_personal(workspace_id, context.user_id))

    if scope in ("project", "all"):
        if project_id:
            require_project_reader(repositories, context, project_id)
            wanted = [project_id]
        else:
            wanted = visible_project_ids(repositories, context)
        for candidate in wanted:
            rows.extend(repositories.views.list_for_project(workspace_id, candidate))

    if scope == "mine" and project_id:
        rows = [row for row in rows if row.project_id == project_id]

    ordered = sorted(rows, key=lambda row: (row.name.lower(), row.view_id))
    return ViewListRead(views=[ViewRead.from_row(row) for row in ordered])


@router.post("/{workspace_id}/views", response_model=ViewRead, status_code=status.HTTP_201_CREATED)
def create_view(
    payload: ViewCreate,
    workspace_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> ViewRead:
    """Save a new view, personal unless it names a project.

    A project view needs the caller to be a member of that project: a reader could
    otherwise leave a shared view on a project they cannot write in.
    """
    unknown = unknown_filter_keys(payload.filter)
    if unknown:
        raise invalid_filter(unknown)

    if payload.project_id:
        require_project_member(repositories, context, payload.project_id)

    view_id = new_view_id()
    view = SavedView(
        workspace_id=workspace_id,
        view_key=view_key_for(context.user_id, payload.project_id, view_id),
        view_id=view_id,
        name=payload.name,
        kind=payload.kind,
        project_id=payload.project_id,
        filter=dict(payload.filter),
        sort=payload.sort,
        group_by=payload.group_by,
        owner_id=context.user_id,
    )
    try:
        repositories.views.create(view)
    except ConditionFailed as exc:
        raise unprocessable("That view already exists") from exc
    return ViewRead.from_row(view)


@router.get("/{workspace_id}/views/{view_id}", response_model=ViewRead)
def read_view(
    workspace_id: str = Path(..., min_length=1),
    view_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> ViewRead:
    """One saved view the caller may read, or a 404."""
    return ViewRead.from_row(load_visible_view(repositories, context, view_id))


@router.patch("/{workspace_id}/views/{view_id}", response_model=ViewRead)
def update_view(
    payload: ViewUpdate,
    workspace_id: str = Path(..., min_length=1),
    view_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> ViewRead:
    """Change a saved view's name, filter, sort or grouping."""
    unknown = unknown_filter_keys(payload.filter)
    if unknown:
        raise invalid_filter(unknown)

    view = load_visible_view(repositories, context, view_id)
    require_view_writer(repositories, context, view)

    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        return ViewRead.from_row(view)

    updated = repositories.views.update(workspace_id, view.view_key, **changes)
    if updated is None:
        raise not_found()
    return ViewRead.from_row(updated)


@router.delete("/{workspace_id}/views/{view_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_view(
    workspace_id: str = Path(..., min_length=1),
    view_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> Response:
    """Remove a saved view, the owner's or a project admin's call."""
    view = load_visible_view(repositories, context, view_id)
    require_view_writer(repositories, context, view)
    repositories.views.delete(workspace_id, view.view_key)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
