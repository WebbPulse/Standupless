"""Status and label writes: the workflow columns and tags a team's issues use.

Shared by the status and label routes and the MCP tools, because the integrations
image may not import another domain's code and a status or label an agent edits
must obey the same rules a team admin's does. The caller has already been held to
team admin for team writes and overrides, and to workspace admin for workspace
statuses and labels.

A workspace status or label is inherited by every team. A team route never edits
one: it answers 409 and the team changes it through its override, which hides it
or renames it in that team only.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status

from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.teams import LabelCreate, LabelUpdate, OverrideUpdate, StatusCreate, StatusUpdate
from app.common.db.dynamo.team_config import (
    STATUS_APPEARANCE_FIELDS,
    WORKSPACE_SCOPE,
    Label,
    Override,
    Status,
    new_config_id,
    override_key,
    status_key,
    workspace_label_key,
    workspace_status_key,
)
from app.common.issue_rules import unprocessable
from app.common.status_appearance import icon_fits

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

LAST_OF_CATEGORY = {
    "error_code": "CONFLICT",
    "message": "A team must keep one status in each category it uses",
}

LAST_VISIBLE = {
    "error_code": "CONFLICT",
    "message": "A team must keep one visible status in each category it uses",
}

INHERITED_STATUS = {
    "error_code": "CONFLICT",
    "message": "This status comes from the workspace. Change it in the workspace, or hide or rename it for the team.",
}

INHERITED_LABEL = {
    "error_code": "CONFLICT",
    "message": "This label comes from the workspace. Change it in the workspace, or hide or rename it for the team.",
}

NOT_INHERITED = {
    "error_code": "CONFLICT",
    "message": "Only a status or label inherited from the workspace can be hidden or renamed for a team.",
}


def _not_found() -> HTTPException:
    """The 404 every missing status, label or override answers."""
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)


def _conflict(detail: dict[str, str]) -> HTTPException:
    """A 409 carrying one of the conflict envelopes above."""
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


def ordered_statuses(
    repositories: Repositories, workspace_id: str, team_id: str, *, include_hidden: bool = False
) -> list[Status]:
    """Every effective status of one team in board order, hidden ones last and only when asked for."""
    rows = repositories.team_config.list_statuses(workspace_id, team_id, include_hidden=include_hidden)
    return sorted(rows, key=lambda row: (row.hidden, row.position, row.name))


def create_status(repositories: Repositories, workspace_id: str, team_id: str, payload: StatusCreate) -> Status:
    """Add a status, defaulting its position to the end of the list."""
    position = payload.position
    if position is None:
        existing = repositories.team_config.list_statuses(workspace_id, team_id)
        position = max((row.position for row in existing), default=-1) + 1

    status_id = new_config_id()
    return repositories.team_config.create_status(
        Status(
            workspace_id=workspace_id,
            config_key=status_key(team_id, status_id),
            team_id=team_id,
            status_id=status_id,
            name=payload.name,
            category=payload.category,
            position=position,
            color=payload.color,
            icon=payload.icon,
        )
    )


def update_status(
    repositories: Repositories, workspace_id: str, team_id: str, status_id: str, payload: StatusUpdate
) -> Status:
    """Rename, recategorise, recolor or move a status, or 404.

    An explicit null color or icon removes it so the status falls back to its
    category default. An icon from another category is a 422. Moving a status to
    a category its stored icon does not fit drops that icon rather than refusing
    the move, because the admin asked for the category, not about the icon.
    """
    given = payload.model_dump(exclude_unset=True)
    attributes = {name: value for name, value in given.items() if value is not None}
    clear = [name for name in STATUS_APPEARANCE_FIELDS if name in given and given[name] is None]

    existing = repositories.team_config.get_status(workspace_id, team_id, status_id)
    if existing is None:
        raise _not_found()
    if existing.scope == WORKSPACE_SCOPE:
        raise _conflict(INHERITED_STATUS)
    _fit_icon(existing, attributes, clear)
    if not attributes and not clear:
        return existing
    updated = repositories.team_config.update_status(workspace_id, team_id, status_id, clear=clear, **attributes)
    if updated is None:
        raise _not_found()
    return updated


def _fit_icon(existing: Status, attributes: dict[str, Any], clear: list[str]) -> None:
    """Refuse an icon from another category, and drop a stored icon a category move no longer fits."""
    category = attributes.get("category", existing.category)
    icon = attributes.get("icon")
    if icon is not None and not icon_fits(category, icon):
        raise unprocessable(f"icon {icon} does not fit the {category} category")
    if icon is None and "icon" not in clear and not icon_fits(category, existing.icon):
        clear.append("icon")


def delete_status(repositories: Repositories, workspace_id: str, team_id: str, status_id: str) -> None:
    """Delete a team status, refusing the last visible one of its category with a 409.

    The board renders a column per category, so removing the only status of one
    would leave a category that can be assigned but never displayed. Issues in the
    deleted status are not moved. An inherited status is a 409: the team hides it.
    """
    existing = repositories.team_config.get_status(workspace_id, team_id, status_id)
    if existing is None:
        raise _not_found()
    if existing.scope == WORKSPACE_SCOPE:
        raise _conflict(INHERITED_STATUS)
    if not _visible_siblings(repositories, workspace_id, team_id, existing):
        raise _conflict(LAST_OF_CATEGORY)
    repositories.team_config.delete_status(workspace_id, team_id, status_id)


def _visible_siblings(repositories: Repositories, workspace_id: str, team_id: str, row: Status) -> list[Status]:
    """The team's other visible statuses in the same category as `row`."""
    return [
        other
        for other in repositories.team_config.list_statuses(workspace_id, team_id, include_hidden=False)
        if other.category == row.category and other.status_id != row.status_id
    ]


def update_label(
    repositories: Repositories, workspace_id: str, team_id: str, label_id: str, payload: LabelUpdate
) -> Label:
    """Rename or recolour a team label, or 404, or 409 for an inherited one."""
    existing = repositories.team_config.get_label(workspace_id, team_id, label_id)
    if existing is None:
        raise _not_found()
    if existing.scope == WORKSPACE_SCOPE:
        raise _conflict(INHERITED_LABEL)
    attributes = payload.model_dump(exclude_unset=True, exclude_none=True)
    if not attributes:
        return existing
    updated = repositories.team_config.update_label(workspace_id, team_id, label_id, **attributes)
    if updated is None:
        raise _not_found()
    return updated


def delete_label(repositories: Repositories, workspace_id: str, team_id: str, label_id: str) -> None:
    """Delete a team label, unconditionally, as nothing depends on one existing; an inherited one is a 409."""
    existing = repositories.team_config.get_label(workspace_id, team_id, label_id)
    if existing is not None and existing.scope == WORKSPACE_SCOPE:
        raise _conflict(INHERITED_LABEL)
    repositories.team_config.delete_label(workspace_id, team_id, label_id)


def ordered_workspace_labels(repositories: Repositories, workspace_id: str) -> list[Label]:
    """Every workspace label, in case-insensitive name order."""
    return repositories.team_config.list_workspace_labels(workspace_id)


def ordered_workspace_statuses(repositories: Repositories, workspace_id: str) -> list[Status]:
    """Every workspace status, in board order."""
    rows = repositories.team_config.list_workspace_statuses(workspace_id)
    return sorted(rows, key=lambda row: (row.position, row.name))


def create_workspace_status(repositories: Repositories, workspace_id: str, payload: StatusCreate) -> Status:
    """Add a workspace status every team inherits, defaulting its position to the end."""
    position = payload.position
    if position is None:
        existing = repositories.team_config.list_workspace_statuses(workspace_id)
        position = max((row.position for row in existing), default=-1) + 1
    status_id = new_config_id()
    return repositories.team_config.create_status(
        Status(
            workspace_id=workspace_id,
            config_key=workspace_status_key(status_id),
            status_id=status_id,
            name=payload.name,
            category=payload.category,
            position=position,
            color=payload.color,
            icon=payload.icon,
            scope=WORKSPACE_SCOPE,
        )
    )


def update_workspace_status(
    repositories: Repositories, workspace_id: str, status_id: str, payload: StatusUpdate
) -> Status:
    """Rename, recategorise, recolor or move a workspace status, with the team rules for icons, or 404."""
    given = payload.model_dump(exclude_unset=True)
    attributes = {name: value for name, value in given.items() if value is not None}
    clear = [name for name in STATUS_APPEARANCE_FIELDS if name in given and given[name] is None]
    existing = repositories.team_config.get_workspace_status(workspace_id, status_id)
    if existing is None:
        raise _not_found()
    _fit_icon(existing, attributes, clear)
    if not attributes and not clear:
        return existing
    updated = repositories.team_config.update_workspace_status(workspace_id, status_id, clear=clear, **attributes)
    if updated is None:
        raise _not_found()
    return updated


def _team_ids(repositories: Repositories, workspace_id: str) -> list[str]:
    """Every live team of the workspace, the teams a workspace record reaches."""
    return [team.team_id for team in repositories.teams.list_for_workspace(workspace_id, limit=1000)]


def delete_workspace_status(repositories: Repositories, workspace_id: str, status_id: str) -> None:
    """Delete a workspace status, refusing with a 409 when any team would lose its last visible status of the category.

    The same rule a team delete holds, checked in every team that inherits it.
    Issues in the deleted status are not moved, as with a team delete, and every
    team's override of it goes too.
    """
    existing = repositories.team_config.get_workspace_status(workspace_id, status_id)
    if existing is None:
        raise _not_found()
    team_ids = _team_ids(repositories, workspace_id)
    for team_id in team_ids:
        row = repositories.team_config.get_status(workspace_id, team_id, status_id)
        if row is not None and not row.hidden and not _visible_siblings(repositories, workspace_id, team_id, row):
            raise _conflict(LAST_OF_CATEGORY)
    repositories.team_config.delete_workspace_status(workspace_id, status_id)
    repositories.team_config.delete_overrides_of(workspace_id, team_ids, "status", status_id)


def create_workspace_label(repositories: Repositories, workspace_id: str, payload: LabelCreate) -> Label:
    """Add a workspace label every team inherits."""
    label_id = new_config_id()
    return repositories.team_config.create_label(
        Label(
            workspace_id=workspace_id,
            config_key=workspace_label_key(label_id),
            label_id=label_id,
            name=payload.name,
            color=payload.color,
            scope=WORKSPACE_SCOPE,
        )
    )


def update_workspace_label(repositories: Repositories, workspace_id: str, label_id: str, payload: LabelUpdate) -> Label:
    """Rename or recolour a workspace label, or 404."""
    existing = repositories.team_config.get_workspace_label(workspace_id, label_id)
    if existing is None:
        raise _not_found()
    attributes = payload.model_dump(exclude_unset=True, exclude_none=True)
    if not attributes:
        return existing
    updated = repositories.team_config.update_workspace_label(workspace_id, label_id, **attributes)
    if updated is None:
        raise _not_found()
    return updated


def delete_workspace_label(repositories: Repositories, workspace_id: str, label_id: str) -> None:
    """Delete a workspace label and every team's override of it, unconditionally, as a team delete is."""
    repositories.team_config.delete_workspace_label(workspace_id, label_id)
    repositories.team_config.delete_overrides_of(workspace_id, _team_ids(repositories, workspace_id), "label", label_id)


def set_status_override(
    repositories: Repositories, workspace_id: str, team_id: str, status_id: str, payload: OverrideUpdate
) -> Status:
    """Hide, show, rename or clear the rename of an inherited status in one team.

    Hiding the team's last visible status of a category is a 409, for the same
    reason deleting it is.
    """
    existing = repositories.team_config.get_status(workspace_id, team_id, status_id)
    if existing is None:
        raise _not_found()
    if existing.scope != WORKSPACE_SCOPE:
        raise _conflict(NOT_INHERITED)
    override = _next_override(repositories, workspace_id, team_id, "status", status_id, payload)
    if override.hidden and not existing.hidden and not _visible_siblings(repositories, workspace_id, team_id, existing):
        raise _conflict(LAST_VISIBLE)
    _store_override(repositories, override)
    return _resolved(repositories.team_config.get_status(workspace_id, team_id, status_id))


def set_label_override(
    repositories: Repositories, workspace_id: str, team_id: str, label_id: str, payload: OverrideUpdate
) -> Label:
    """Hide, show, rename or clear the rename of an inherited label in one team."""
    existing = repositories.team_config.get_label(workspace_id, team_id, label_id)
    if existing is None:
        raise _not_found()
    if existing.scope != WORKSPACE_SCOPE:
        raise _conflict(NOT_INHERITED)
    _store_override(repositories, _next_override(repositories, workspace_id, team_id, "label", label_id, payload))
    return _resolved(repositories.team_config.get_label(workspace_id, team_id, label_id))


def clear_status_override(repositories: Repositories, workspace_id: str, team_id: str, status_id: str) -> Status:
    """Show an inherited status again under its workspace name."""
    existing = repositories.team_config.get_status(workspace_id, team_id, status_id)
    if existing is None:
        raise _not_found()
    if existing.scope != WORKSPACE_SCOPE:
        raise _conflict(NOT_INHERITED)
    repositories.team_config.delete_override(workspace_id, team_id, "status", status_id)
    return _resolved(repositories.team_config.get_status(workspace_id, team_id, status_id))


def clear_label_override(repositories: Repositories, workspace_id: str, team_id: str, label_id: str) -> Label:
    """Show an inherited label again under its workspace name."""
    existing = repositories.team_config.get_label(workspace_id, team_id, label_id)
    if existing is None:
        raise _not_found()
    if existing.scope != WORKSPACE_SCOPE:
        raise _conflict(NOT_INHERITED)
    repositories.team_config.delete_override(workspace_id, team_id, "label", label_id)
    return _resolved(repositories.team_config.get_label(workspace_id, team_id, label_id))


def _next_override(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    target: str,
    target_id: str,
    payload: OverrideUpdate,
) -> Override:
    """The override a patch leaves: the stored one with the given fields applied, an explicit null name clearing it."""
    current = repositories.team_config.get_override(workspace_id, team_id, target, target_id) or Override(
        workspace_id=workspace_id,
        config_key=override_key(team_id, target, target_id),
        team_id=team_id,
        target=target,
        target_id=target_id,
    )
    given = payload.model_dump(exclude_unset=True)
    update: dict[str, Any] = {}
    if given.get("hidden") is not None:
        update["hidden"] = given["hidden"]
    if "name" in given:
        update["name"] = given["name"] or None
    return current.model_copy(update=update)


def _store_override(repositories: Repositories, override: Override) -> None:
    """Write an override, or remove it when it no longer changes anything."""
    if override.hidden or override.name:
        repositories.team_config.put_override(override)
        return
    repositories.team_config.delete_override(
        override.workspace_id, override.team_id, override.target, override.target_id
    )


def _resolved(row: Any) -> Any:
    """A row read back after a write, or a 404 when it vanished in between."""
    if row is None:
        raise _not_found()
    return row
