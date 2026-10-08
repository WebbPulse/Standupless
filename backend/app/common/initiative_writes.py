"""Initiative list, create, patch, delete, project membership and updates, shared by the routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and an initiative an agent edits must pass the same rules a person's does.

An initiative is workspace level and spans teams, so it has no team to decide
visibility by. Every member but a guest reads every initiative and may create,
edit and post updates on one; the projects it rolls up are narrowed to the ones
the caller can see, so an initiative never reveals work on a hidden team. A
project joins an initiative through its own `initiative_id`, which is why it
belongs to at most one, and joining or leaving is an edit of that project. Only
the initiative's creator, its owner or a workspace admin deletes it.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import decode_cursor, decode_offset_cursor, encode_cursor, encode_offset_cursor
from app.common.api.schemas.planning import (
    MAX_LIMIT,
    UPDATES_DEFAULT_LIMIT,
    InitiativeCreate,
    InitiativeRead,
    InitiativeUpdate,
    InitiativeUpdateCreate,
    InitiativeUpdatePatch,
    InitiativeUpdateRead,
    ProjectRead,
)
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import (
    INITIATIVE_STATUSES,
    Initiative,
    InitiativeUpdateRow,
    Project,
    initiative_key,
    initiative_update_key,
    initiative_update_prefix,
    new_planning_id,
)
from app.common.planning_rules import (
    forbidden,
    load_readable_project,
    not_found,
    require_project_editor,
    require_workspace_member,
    unprocessable,
    visible_project_teams,
    visible_team_ids,
)
from app.common.project_cadence import workspace_interval

NOT_NULLABLE = ("name", "status")
"""Patch fields that may be omitted but never cleared, because every initiative has one."""


def require_initiative_access(context: AuthzContext) -> None:
    """Hold that the caller is a workspace member rather than a guest, or 403.

    A guest sees only the teams it was invited to, and an initiative spans the
    workspace, so it is refused outright rather than shown a partial one.
    """
    if context.is_guest:
        raise forbidden()


def load_initiative(repositories: Repositories, context: AuthzContext, initiative_id: str) -> Initiative:
    """One initiative of the caller's workspace, or a 403 for a guest and a 404 when absent."""
    require_initiative_access(context)
    initiative = repositories.planning.get_initiative(context.workspace_id, initiative_id)
    if initiative is None:
        raise not_found()
    return initiative


def require_initiative_target(repositories: Repositories, context: AuthzContext, initiative_id: str) -> None:
    """Hold that a project may be put in one initiative, or 403 for a guest and 422 when it is absent."""
    require_initiative_access(context)
    if repositories.planning.get_initiative(context.workspace_id, initiative_id) is None:
        raise unprocessable(f"No such initiative: {initiative_id}")


def visible_projects_by_initiative(repositories: Repositories, context: AuthzContext) -> dict[str, list[Project]]:
    """The projects the caller can see, grouped under the initiative each belongs to."""
    visible = set(visible_team_ids(repositories, context))
    grouped: dict[str, list[Project]] = {}
    for project in repositories.planning.list_projects(context.workspace_id):
        if project.initiative_id and visible_project_teams(project, visible):
            grouped.setdefault(project.initiative_id, []).append(project)
    return grouped


def read_initiative(repositories: Repositories, context: AuthzContext, initiative: Initiative) -> InitiativeRead:
    """One initiative in its response shape, rolled up from the projects this caller sees."""
    projects = visible_projects_by_initiative(repositories, context).get(initiative.initiative_id, [])
    return InitiativeRead.from_row(
        initiative,
        projects,
        default_interval_days=workspace_interval(repositories.workspaces, context.workspace_id),
    )


def get_initiative(repositories: Repositories, context: AuthzContext, initiative_id: str) -> InitiativeRead:
    """One initiative the caller may read, rolled up."""
    return read_initiative(repositories, context, load_initiative(repositories, context, initiative_id))


def list_initiatives(
    repositories: Repositories,
    context: AuthzContext,
    *,
    status_filter: Optional[str],
    cursor: Optional[str],
    limit: int,
) -> tuple[list[InitiativeRead], Optional[str]]:
    """One page of the workspace's initiatives by target date, undated last, and the next cursor."""
    require_initiative_access(context)
    if status_filter is not None and status_filter not in INITIATIVE_STATUSES:
        raise unprocessable(f"Unknown initiative status: {status_filter}")
    grouped = visible_projects_by_initiative(repositories, context)
    default_days = workspace_interval(repositories.workspaces, context.workspace_id)
    bodies = [
        InitiativeRead.from_row(row, grouped.get(row.initiative_id, []), default_interval_days=default_days)
        for row in repositories.planning.list_initiatives(context.workspace_id)
        if status_filter is None or row.status == status_filter
    ]
    scope = f"initiatives:{context.workspace_id}:{status_filter or 'all'}"
    offset = decode_offset_cursor(cursor, scope)
    window = bodies[offset : offset + limit]
    next_offset = offset + len(window)
    next_cursor = encode_offset_cursor(next_offset, scope) if next_offset < len(bodies) else None
    return window, next_cursor


def create_initiative(repositories: Repositories, context: AuthzContext, payload: InitiativeCreate) -> InitiativeRead:
    """Create an initiative with no projects yet; any member but a guest may."""
    require_initiative_access(context)
    if payload.owner_id is not None:
        require_workspace_member(repositories, context, payload.owner_id)
    initiative_id = new_planning_id()
    initiative = Initiative(
        workspace_id=context.workspace_id,
        planning_key=initiative_key(initiative_id),
        initiative_id=initiative_id,
        name=payload.name,
        description=payload.description,
        owner_id=payload.owner_id,
        status=payload.status,
        health=payload.health,
        target_date=payload.target_date,
        update_interval_days=payload.update_interval_days,
        created_by=context.user_id,
    )
    try:
        created = repositories.planning.create_initiative(initiative)
    except ConditionFailed as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error_code": "CONFLICT", "message": "That initiative already exists"},
        ) from exc
    return read_initiative(repositories, context, created)


def update_initiative(
    repositories: Repositories, context: AuthzContext, initiative_id: str, payload: InitiativeUpdate
) -> InitiativeRead:
    """Patch an initiative's fields; null clears the description, owner, health, date or cadence."""
    existing = load_initiative(repositories, context, initiative_id)
    fields: dict[str, Any] = payload.model_dump(exclude_unset=True)
    for name in NOT_NULLABLE:
        if name in fields and fields[name] is None:
            raise unprocessable(f"{name} must not be null")
    owner_id = fields.get("owner_id")
    if owner_id is not None and owner_id != existing.owner_id:
        require_workspace_member(repositories, context, owner_id)
    updated = existing.model_copy(update={**fields, "updated_at": utc_now()})
    try:
        stored = repositories.planning.replace_initiative(updated)
    except ConditionFailed as exc:
        raise not_found() from exc
    return read_initiative(repositories, context, stored)


def can_delete_initiative(context: AuthzContext, initiative: Initiative) -> bool:
    """Whether the caller may delete one initiative: its creator, its owner or a workspace admin."""
    return context.is_workspace_admin or context.user_id in (initiative.created_by, initiative.owner_id)


def delete_initiative(repositories: Repositories, context: AuthzContext, initiative_id: str) -> None:
    """Delete an initiative and its updates, leaving every project it held in place outside it.

    Every project carrying it is detached, the ones on teams the caller cannot
    see included, so no project is left pointing at an initiative that is gone.
    """
    initiative = load_initiative(repositories, context, initiative_id)
    if not can_delete_initiative(context, initiative):
        raise forbidden()
    for project in repositories.planning.list_projects(context.workspace_id):
        if project.initiative_id == initiative.initiative_id:
            repositories.planning.set_project_initiative(context.workspace_id, project.project_id, None)
    repositories.planning.delete_initiative_updates(context.workspace_id, initiative.initiative_id)
    repositories.planning.delete(context.workspace_id, initiative.planning_key)


def _membership_project(
    repositories: Repositories, context: AuthzContext, initiative_id: str, project_id: str
) -> tuple[Initiative, Project, list[str]]:
    """The initiative, a project the caller may edit and its visible teams, for a membership change."""
    initiative = load_initiative(repositories, context, initiative_id)
    project, teams = load_readable_project(repositories, context, project_id)
    require_project_editor(repositories, context, teams)
    return initiative, project, teams


def _project_read(repositories: Repositories, context: AuthzContext, project_id: str) -> ProjectRead:
    """One project as the caller reads it after a membership change."""
    project, teams = load_readable_project(repositories, context, project_id)
    return ProjectRead.from_row(
        project, teams, default_interval_days=workspace_interval(repositories.workspaces, context.workspace_id)
    )


def add_project_to_initiative(
    repositories: Repositories, context: AuthzContext, initiative_id: str, project_id: str
) -> ProjectRead:
    """Put a project in an initiative, moving it out of any other it was in."""
    initiative, project, _ = _membership_project(repositories, context, initiative_id, project_id)
    if project.initiative_id != initiative.initiative_id:
        if not repositories.planning.set_project_initiative(
            context.workspace_id, project.project_id, initiative.initiative_id
        ):
            raise not_found()
    return _project_read(repositories, context, project.project_id)


def remove_project_from_initiative(
    repositories: Repositories, context: AuthzContext, initiative_id: str, project_id: str
) -> ProjectRead:
    """Take a project out of an initiative, or 404 when it is not in that one."""
    initiative, project, _ = _membership_project(repositories, context, initiative_id, project_id)
    if project.initiative_id != initiative.initiative_id:
        raise not_found()
    if not repositories.planning.set_project_initiative(context.workspace_id, project.project_id, None):
        raise not_found()
    return _project_read(repositories, context, project.project_id)


def update_cursor_scope(workspace_id: str, initiative_id: str) -> str:
    """The scope a feed cursor is minted under, so it only resumes the same feed."""
    return f"initiative_updates:{workspace_id}:{initiative_id}"


def _start_key(cursor: str | None, workspace_id: str, initiative_id: str) -> Mapping[str, Any] | None:
    """A decoded cursor, or `None` when it would resume outside this initiative's updates."""
    start = decode_cursor(cursor, update_cursor_scope(workspace_id, initiative_id))
    if start is None:
        return None
    if start.get("workspace_id") != workspace_id:
        return None
    if not str(start.get("planning_key", "")).startswith(initiative_update_prefix(initiative_id)):
        return None
    return start


def can_edit_update(context: AuthzContext, initiative: Initiative, update: InitiativeUpdateRow) -> bool:
    """Whether the caller may edit or delete one update: its author, the initiative's owner or a workspace admin."""
    if context.is_workspace_admin:
        return True
    return context.user_id in (update.author_id, initiative.owner_id)


def _update_read(context: AuthzContext, initiative: Initiative, update: InitiativeUpdateRow) -> InitiativeUpdateRead:
    """One update in its response shape, with this caller's edit right."""
    return InitiativeUpdateRead.from_row(update, can_edit=can_edit_update(context, initiative, update))


def list_initiative_updates(
    repositories: Repositories,
    context: AuthzContext,
    initiative_id: str,
    *,
    cursor: str | None,
    limit: int | None,
) -> tuple[list[InitiativeUpdateRead], str | None]:
    """One page of an initiative's updates, newest first, and the next cursor."""
    initiative = load_initiative(repositories, context, initiative_id)
    size = max(1, min(limit or UPDATES_DEFAULT_LIMIT, MAX_LIMIT))
    rows, last_key = repositories.planning.list_initiative_updates(
        context.workspace_id,
        initiative.initiative_id,
        limit=size,
        start_key=_start_key(cursor, context.workspace_id, initiative.initiative_id),
    )
    return (
        [_update_read(context, initiative, row) for row in rows],
        encode_cursor(last_key, update_cursor_scope(context.workspace_id, initiative.initiative_id)),
    )


def create_initiative_update(
    repositories: Repositories, context: AuthzContext, initiative_id: str, payload: InitiativeUpdateCreate
) -> InitiativeUpdateRead:
    """Post an update on an initiative and mirror its health onto the initiative."""
    initiative = load_initiative(repositories, context, initiative_id)
    update_id = new_planning_id()
    update = InitiativeUpdateRow(
        workspace_id=context.workspace_id,
        planning_key=initiative_update_key(initiative.initiative_id, update_id),
        update_id=update_id,
        initiative_id=initiative.initiative_id,
        body=payload.body,
        health=payload.health,
        author_id=context.user_id,
        source=context.source,
    )
    try:
        created = repositories.planning.create_initiative_update(update)
    except ConditionFailed as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error_code": "CONFLICT", "message": "That update already exists"},
        ) from exc
    repositories.planning.record_initiative_health(
        context.workspace_id, initiative.initiative_id, health=created.health, last_update_at=created.created_at
    )
    return _update_read(context, initiative, created)


def _load_editable_update(
    repositories: Repositories, context: AuthzContext, initiative_id: str, update_id: str
) -> tuple[Initiative, InitiativeUpdateRow]:
    """An initiative and one of its updates the caller may change."""
    initiative = load_initiative(repositories, context, initiative_id)
    update = repositories.planning.get_initiative_update(context.workspace_id, initiative.initiative_id, update_id)
    if update is None:
        raise not_found()
    if not can_edit_update(context, initiative, update):
        raise forbidden()
    return initiative, update


def _is_latest(repositories: Repositories, update: InitiativeUpdateRow) -> bool:
    """Whether one update is its initiative's newest, the one the initiative row mirrors."""
    latest = repositories.planning.latest_initiative_update(update.workspace_id, update.initiative_id)
    return latest is not None and latest.update_id == update.update_id


def update_initiative_update(
    repositories: Repositories,
    context: AuthzContext,
    initiative_id: str,
    update_id: str,
    payload: InitiativeUpdatePatch,
) -> InitiativeUpdateRead:
    """Edit an update's body or health; a health change on the newest one moves the initiative."""
    initiative, existing = _load_editable_update(repositories, context, initiative_id, update_id)
    fields: dict[str, Any] = payload.model_dump(exclude_unset=True)
    for name in ("body", "health"):
        if name in fields and fields[name] is None:
            raise unprocessable(f"{name} must not be null")
    if not fields:
        return _update_read(context, initiative, existing)
    now = utc_now()
    edited = existing.model_copy(update={**fields, "updated_at": now, "edited_at": now})
    try:
        stored = repositories.planning.replace_initiative_update(edited)
    except ConditionFailed as exc:
        raise not_found() from exc
    if stored.health != existing.health and _is_latest(repositories, stored):
        repositories.planning.record_initiative_health(
            context.workspace_id, stored.initiative_id, health=stored.health, last_update_at=stored.created_at
        )
    return _update_read(context, initiative, stored)


def delete_initiative_update(
    repositories: Repositories, context: AuthzContext, initiative_id: str, update_id: str
) -> None:
    """Delete an update; removing the newest one falls the initiative back to the one before it."""
    _, existing = _load_editable_update(repositories, context, initiative_id, update_id)
    was_latest = _is_latest(repositories, existing)
    if not repositories.planning.delete(context.workspace_id, existing.planning_key):
        raise not_found()
    if not was_latest:
        return
    previous = repositories.planning.latest_initiative_update(context.workspace_id, existing.initiative_id)
    repositories.planning.record_initiative_health(
        context.workspace_id,
        existing.initiative_id,
        health=previous.health if previous is not None else None,
        last_update_at=previous.created_at if previous is not None else None,
    )
