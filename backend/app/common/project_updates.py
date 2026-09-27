"""Project update list, create, edit and delete, shared by the update routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and an update an agent posts must pass the same edit rights and move the
project's health the same way a person's does.

The newest update is what the project row mirrors: posting one sets the
project's `health` and `last_update_at`, editing the newest one re-applies its
health, and deleting the newest one falls back to the one before it.
"""

from __future__ import annotations

from typing import Any, Mapping

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import decode_cursor, encode_cursor
from app.common.api.schemas.planning import (
    MAX_LIMIT,
    UPDATES_DEFAULT_LIMIT,
    ProjectUpdateCreate,
    ProjectUpdatePatch,
    ProjectUpdateRead,
)
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import (
    Project,
    ProjectUpdateRow,
    new_planning_id,
    project_update_key,
    project_update_prefix,
)
from app.common.planning_rules import (
    forbidden,
    load_readable_project,
    not_found,
    require_project_editor,
    team_role,
    unprocessable,
)


def cursor_scope(workspace_id: str, project_id: str) -> str:
    """The scope a feed cursor is minted under, so it only resumes the same feed."""
    return f"project_updates:{workspace_id}:{project_id}"


def _start_key(cursor: str | None, workspace_id: str, project_id: str) -> Mapping[str, Any] | None:
    """A decoded cursor, or `None` when it would resume outside this project's updates.

    The cursor is not signed, so the key it carries is held to this workspace and
    this project's prefix rather than trusted to be the one the feed minted.
    """
    start = decode_cursor(cursor, cursor_scope(workspace_id, project_id))
    if start is None:
        return None
    if start.get("workspace_id") != workspace_id:
        return None
    if not str(start.get("planning_key", "")).startswith(project_update_prefix(project_id)):
        return None
    return start


def can_edit_update(
    repositories: Repositories, context: AuthzContext, teams: list[str], update: ProjectUpdateRow
) -> bool:
    """Whether the caller may edit or delete one update.

    Its author may, and so may a workspace admin or an admin of any of the
    project's teams the caller sees, who moderate what is posted there.
    """
    if update.author_id == context.user_id or context.is_workspace_admin:
        return True
    return any(team_role(repositories, context, team_id) == "admin" for team_id in teams)


def _read(
    repositories: Repositories, context: AuthzContext, teams: list[str], update: ProjectUpdateRow
) -> ProjectUpdateRead:
    """One update in its response shape, with this caller's edit right."""
    return ProjectUpdateRead.from_row(update, can_edit=can_edit_update(repositories, context, teams, update))


def list_project_updates(
    repositories: Repositories,
    context: AuthzContext,
    project_id: str,
    *,
    cursor: str | None,
    limit: int | None,
) -> tuple[list[ProjectUpdateRead], str | None]:
    """One page of a readable project's updates, newest first, and the next cursor."""
    project, teams = load_readable_project(repositories, context, project_id)
    size = max(1, min(limit or UPDATES_DEFAULT_LIMIT, MAX_LIMIT))
    rows, last_key = repositories.planning.list_project_updates(
        context.workspace_id,
        project.project_id,
        limit=size,
        start_key=_start_key(cursor, context.workspace_id, project.project_id),
    )
    return (
        [_read(repositories, context, teams, row) for row in rows],
        encode_cursor(last_key, cursor_scope(context.workspace_id, project.project_id)),
    )


def create_project_update(
    repositories: Repositories, context: AuthzContext, project_id: str, payload: ProjectUpdateCreate
) -> ProjectUpdateRead:
    """Post an update on a project the caller may edit, and mirror its health onto the project."""
    project, teams = load_readable_project(repositories, context, project_id)
    require_project_editor(repositories, context, teams)
    update_id = new_planning_id()
    update = ProjectUpdateRow(
        workspace_id=context.workspace_id,
        planning_key=project_update_key(project.project_id, update_id),
        update_id=update_id,
        project_id=project.project_id,
        body=payload.body,
        health=payload.health,
        author_id=context.user_id,
    )
    try:
        created = repositories.planning.create_project_update(update)
    except ConditionFailed as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error_code": "CONFLICT", "message": "That update already exists"},
        ) from exc
    repositories.planning.record_project_health(
        context.workspace_id, project.project_id, health=created.health, last_update_at=created.created_at
    )
    return _read(repositories, context, teams, created)


def _load_editable(
    repositories: Repositories, context: AuthzContext, project_id: str, update_id: str
) -> tuple[Project, list[str], ProjectUpdateRow]:
    """A readable project, its visible teams and one of its updates the caller may change."""
    project, teams = load_readable_project(repositories, context, project_id)
    update = repositories.planning.get_project_update(context.workspace_id, project.project_id, update_id)
    if update is None:
        raise not_found()
    if not can_edit_update(repositories, context, teams, update):
        raise forbidden()
    return project, teams, update


def _is_latest(repositories: Repositories, update: ProjectUpdateRow) -> bool:
    """Whether one update is its project's newest, the one the project row mirrors."""
    latest = repositories.planning.latest_project_update(update.workspace_id, update.project_id)
    return latest is not None and latest.update_id == update.update_id


def update_project_update(
    repositories: Repositories,
    context: AuthzContext,
    project_id: str,
    update_id: str,
    payload: ProjectUpdatePatch,
) -> ProjectUpdateRead:
    """Edit an update's body or health; a health change on the newest one moves the project."""
    _, teams, existing = _load_editable(repositories, context, project_id, update_id)
    fields: dict[str, Any] = payload.model_dump(exclude_unset=True)
    for name in ("body", "health"):
        if name in fields and fields[name] is None:
            raise unprocessable(f"{name} must not be null")
    if not fields:
        return _read(repositories, context, teams, existing)
    now = utc_now()
    edited = existing.model_copy(update={**fields, "updated_at": now, "edited_at": now})
    try:
        stored = repositories.planning.replace_project_update(edited)
    except ConditionFailed as exc:
        raise not_found() from exc
    if stored.health != existing.health and _is_latest(repositories, stored):
        repositories.planning.record_project_health(
            context.workspace_id, stored.project_id, health=stored.health, last_update_at=stored.created_at
        )
    return _read(repositories, context, teams, stored)


def delete_project_update(repositories: Repositories, context: AuthzContext, project_id: str, update_id: str) -> None:
    """Delete an update; removing the newest one falls the project back to the one before it.

    With no update left the project keeps the health it last reported, as a
    health set by hand would stay, and only `last_update_at` is cleared.
    """
    _, _, existing = _load_editable(repositories, context, project_id, update_id)
    was_latest = _is_latest(repositories, existing)
    if not repositories.planning.delete(context.workspace_id, existing.planning_key):
        raise not_found()
    if not was_latest:
        return
    previous = repositories.planning.latest_project_update(context.workspace_id, existing.project_id)
    repositories.planning.record_project_health(
        context.workspace_id,
        existing.project_id,
        health=previous.health if previous is not None else None,
        last_update_at=previous.created_at if previous is not None else None,
    )
