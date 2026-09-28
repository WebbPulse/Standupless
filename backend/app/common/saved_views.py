"""Saved view reads and writes, shared by the view routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and which views a caller may read or change is decided once. Reads are built
from what the caller may read rather than filtered afterwards. A personal view is
its owner's alone, and a team view needs team membership to create and its owner or
a team admin to change or delete.
"""

from __future__ import annotations

from typing import Any, Optional, Sequence

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.views import (
    DISPLAY_SWITCHES,
    ViewCreate,
    ViewUpdate,
    malformed_filter_keys,
    unknown_filter_keys,
)
from app.common.db.dynamo.views import SavedView, new_view_id, view_key_for
from app.common.issue_rules import (
    not_found,
    require_team_member,
    require_team_reader,
    team_role,
    unprocessable,
    visible_team_ids,
)

FORBIDDEN = {"error_code": "FORBIDDEN", "message": "Not allowed"}


def invalid_filter(unknown: Sequence[str]) -> HTTPException:
    """The contract's `INVALID_FILTER` 422, naming the keys outside the set or of the wrong shape."""
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={
            "error_code": "INVALID_FILTER",
            "message": f"filter carries unknown or malformed keys: {', '.join(unknown)}",
        },
    )


def readable_views(
    repositories: Repositories, context: AuthzContext, scope: str, team_id: Optional[str]
) -> list[SavedView]:
    """Saved views the caller may read, narrowed by scope, in name order.

    `mine` is the caller's own views, `team` the shared views of one team or of
    every team they can see, and `all` both. For a guest the teams are only the
    ones they hold a membership in.
    """
    rows: list[SavedView] = []

    if scope in ("mine", "all"):
        rows.extend(repositories.views.list_personal(context.workspace_id, context.user_id))

    if scope in ("team", "all"):
        if team_id:
            require_team_reader(repositories, context, team_id)
            wanted = [team_id]
        else:
            wanted = visible_team_ids(repositories, context)
        for candidate in wanted:
            rows.extend(repositories.views.list_for_team(context.workspace_id, candidate))

    if scope == "mine" and team_id:
        rows = [row for row in rows if row.team_id == team_id]

    return sorted(rows, key=lambda row: (row.name.lower(), row.view_id))


def load_visible_view(repositories: Repositories, context: AuthzContext, view_id: str) -> SavedView:
    """One saved view the caller may read, or a 404.

    Looked for only under the keys this caller could hold, their own personal key
    and the team keys of the teams they can see, so a view they may not read is
    never found rather than found and refused.
    """
    view = repositories.views.find(
        context.workspace_id,
        view_id,
        context.user_id,
        visible_team_ids(repositories, context),
    )
    if view is None:
        raise not_found()
    return view


def require_view_writer(repositories: Repositories, context: AuthzContext, view: SavedView) -> None:
    """Hold that the caller may change one saved view, or 403.

    A personal view is its owner's alone, and a team view is the owner's or a team
    admin's. The view was already found, so only the verb is in doubt.
    """
    if view.owner_id == context.user_id:
        return
    if view.team_id and (context.is_workspace_admin or team_role(repositories, context, view.team_id) == "admin"):
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=FORBIDDEN)


def check_filter(value: Optional[dict[str, Any]]) -> None:
    """Refuse a filter the issue list could not run, naming the offending keys."""
    bad = sorted(set(unknown_filter_keys(value)) | set(malformed_filter_keys(value)))
    if bad:
        raise invalid_filter(bad)


def check_sub_group(group_by: Optional[str], sub_group_by: Optional[str]) -> None:
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


def create_saved_view(repositories: Repositories, context: AuthzContext, payload: ViewCreate) -> SavedView:
    """Save a new view, personal unless it names a team.

    A team view needs the caller to be a member of that team, so a reader cannot
    leave a shared view on a team they cannot write in. The owner is the caller.
    """
    check_filter(payload.filter)
    check_sub_group(payload.group_by, payload.sub_group_by)

    if payload.team_id:
        require_team_member(repositories, context, payload.team_id)

    view_id = new_view_id()
    view = SavedView(
        workspace_id=context.workspace_id,
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
        show_sub_issues=payload.show_sub_issues,
        show_completed=payload.show_completed,
        show_archived=payload.show_archived,
        owner_id=context.user_id,
    )
    try:
        repositories.views.create(view)
    except ConditionFailed as exc:
        raise unprocessable("That view already exists") from exc
    return view


def update_saved_view(
    repositories: Repositories, context: AuthzContext, view_id: str, payload: ViewUpdate
) -> SavedView:
    """Change a saved view's name, filter, sort, grouping or display settings.

    Only the fields the payload set are written. The display switches take true or
    false and never null, because a switch that could be neither would leave the
    client guessing what the view shows.
    """
    check_filter(payload.filter)

    view = load_visible_view(repositories, context, view_id)
    require_view_writer(repositories, context, view)

    changes = payload.model_dump(exclude_unset=True)
    for name in DISPLAY_SWITCHES:
        if name in changes and changes[name] is None:
            raise unprocessable(f"{name} must be true or false")
    if not changes:
        return view
    check_sub_group(changes.get("group_by", view.group_by), changes.get("sub_group_by", view.sub_group_by))

    updated = repositories.views.update(context.workspace_id, view.view_key, **changes)
    if updated is None:
        raise not_found()
    return updated


def delete_saved_view(repositories: Repositories, context: AuthzContext, view_id: str) -> SavedView:
    """Remove a saved view, the owner's or a team admin's call, answering the row removed."""
    view = load_visible_view(repositories, context, view_id)
    require_view_writer(repositories, context, view)
    repositories.views.delete(context.workspace_id, view.view_key)
    return view
