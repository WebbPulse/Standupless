"""Saved view routes: list, create, read, patch and delete.

A saved view stores a filter and never results. Running one is the M2 issue list
with the stored filter expanded into its query, which is why there is deliberately
no route returning a view's issues: a second read path would be a second place
team visibility is decided, and the invariant is that there is one.

Scope is derived from whether a team is named, never sent, and the owner comes
from the authorization context, so neither is something a caller can assert.
"""

from __future__ import annotations

from typing import Any, Optional

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
    malformed_filter_keys,
    unknown_filter_keys,
)
from app.domains.views.service import (
    invalid_filter,
    load_visible_view,
    not_found,
    require_team_member,
    require_team_reader,
    require_view_writer,
    unprocessable,
    visible_team_ids,
)

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
    rows: list[SavedView] = []

    if scope in ("mine", "all"):
        rows.extend(repositories.views.list_personal(workspace_id, context.user_id))

    if scope in ("team", "all"):
        if team_id:
            require_team_reader(repositories, context, team_id)
            wanted = [team_id]
        else:
            wanted = visible_team_ids(repositories, context)
        for candidate in wanted:
            rows.extend(repositories.views.list_for_team(workspace_id, candidate))

    if scope == "mine" and team_id:
        rows = [row for row in rows if row.team_id == team_id]

    ordered = sorted(rows, key=lambda row: (row.name.lower(), row.view_id))
    return ViewListRead(views=[ViewRead.from_row(row) for row in ordered])


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
    _check_filter(payload.filter)
    _check_sub_group(payload.group_by, payload.sub_group_by)

    if payload.team_id:
        require_team_member(repositories, context, payload.team_id)

    view_id = new_view_id()
    view = SavedView(
        workspace_id=workspace_id,
        view_key=view_key_for(context.user_id, payload.team_id, view_id),
        view_id=view_id,
        name=payload.name,
        kind=payload.kind,
        team_id=payload.team_id,
        filter=dict(payload.filter),
        sort=payload.sort,
        group_by=payload.group_by,
        sub_group_by=payload.sub_group_by,
        ordering=payload.ordering,
        visible_properties=list(payload.visible_properties) if payload.visible_properties is not None else None,
        layout=payload.layout or payload.kind,
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
    """Change a saved view's name, filter, sort, grouping or display settings."""
    _check_filter(payload.filter)

    view = load_visible_view(repositories, context, view_id)
    require_view_writer(repositories, context, view)

    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        return ViewRead.from_row(view)
    _check_sub_group(changes.get("group_by", view.group_by), changes.get("sub_group_by", view.sub_group_by))

    updated = repositories.views.update(workspace_id, view.view_key, **changes)
    if updated is None:
        raise not_found()
    return ViewRead.from_row(updated)


def _check_filter(value: Optional[dict[str, Any]]) -> None:
    """Refuse a filter the issue list could not run, naming the offending keys.

    Unknown keys and values of the wrong shape are both `INVALID_FILTER`, because
    either one would make the view match something other than what it says.
    """
    bad = sorted(set(unknown_filter_keys(value)) | set(malformed_filter_keys(value)))
    if bad:
        raise invalid_filter(bad)


def _check_sub_group(group_by: Optional[str], sub_group_by: Optional[str]) -> None:
    """Refuse a sub grouping with no grouping, or one repeating the grouping.

    Judged against the view as it will be after the write, so a patch that only
    moves one of the two is held to the other's stored value.
    """
    if sub_group_by is None:
        return
    if group_by is None:
        raise unprocessable("sub_group_by needs group_by")
    if sub_group_by == group_by:
        raise unprocessable("sub_group_by must differ from group_by")


@router.delete("/{workspace_id}/views/{view_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_view(
    workspace_id: str = Path(..., min_length=1),
    view_id: str = Path(..., min_length=1),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> Response:
    """Remove a saved view, the owner's or a team admin's call."""
    view = load_visible_view(repositories, context, view_id)
    require_view_writer(repositories, context, view)
    repositories.views.delete(workspace_id, view.view_key)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
