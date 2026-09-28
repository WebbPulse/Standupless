"""Status and label writes: the workflow columns and tags a team's issues use.

Shared by the status and label routes and the MCP tools, because the integrations
image may not import another domain's code and a status or label an agent edits
must obey the same rules a team admin's does. The caller has already been held to
team admin.
"""

from __future__ import annotations

from fastapi import HTTPException, status

from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.teams import LabelUpdate, StatusCreate, StatusUpdate
from app.common.db.dynamo.team_config import Label, Status, new_config_id, status_key

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

LAST_OF_CATEGORY = {
    "error_code": "CONFLICT",
    "message": "A team must keep one status in each category it uses",
}


def ordered_statuses(repositories: Repositories, workspace_id: str, team_id: str) -> list[Status]:
    """Every status of one team, in board order."""
    rows = repositories.team_config.list_statuses(workspace_id, team_id)
    return sorted(rows, key=lambda row: (row.position, row.name))


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
        )
    )


def update_status(
    repositories: Repositories, workspace_id: str, team_id: str, status_id: str, payload: StatusUpdate
) -> Status:
    """Rename a status, recategorise it or move it in the order, or 404."""
    attributes = payload.model_dump(exclude_unset=True, exclude_none=True)
    if not attributes:
        existing = repositories.team_config.get_status(workspace_id, team_id, status_id)
        if existing is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
        return existing

    updated = repositories.team_config.update_status(workspace_id, team_id, status_id, **attributes)
    if updated is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return updated


def delete_status(repositories: Repositories, workspace_id: str, team_id: str, status_id: str) -> None:
    """Delete a status, refusing the last one of its category with a 409.

    The board renders a column per category, so removing the only status of one
    would leave a category that can be assigned but never displayed. Issues in the
    deleted status are not moved.
    """
    existing = repositories.team_config.get_status(workspace_id, team_id, status_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)

    siblings = [
        row
        for row in repositories.team_config.list_statuses(workspace_id, team_id)
        if row.category == existing.category and row.status_id != status_id
    ]
    if not siblings:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=LAST_OF_CATEGORY)

    repositories.team_config.delete_status(workspace_id, team_id, status_id)


def update_label(
    repositories: Repositories, workspace_id: str, team_id: str, label_id: str, payload: LabelUpdate
) -> Label:
    """Rename or recolour a label, or 404."""
    attributes = payload.model_dump(exclude_unset=True, exclude_none=True)
    if not attributes:
        existing = repositories.team_config.get_label(workspace_id, team_id, label_id)
        if existing is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
        return existing

    updated = repositories.team_config.update_label(workspace_id, team_id, label_id, **attributes)
    if updated is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return updated


def delete_label(repositories: Repositories, workspace_id: str, team_id: str, label_id: str) -> None:
    """Delete a label, unconditionally, as nothing depends on one existing."""
    repositories.team_config.delete_label(workspace_id, team_id, label_id)
