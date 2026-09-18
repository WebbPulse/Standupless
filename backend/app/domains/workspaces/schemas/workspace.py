"""Response schemas for the workspaces routes."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from app.common.db.dynamo.workspaces import Workspace


class WorkspaceRead(BaseModel):
    """One workspace as the API returns it."""

    id: str
    name: str
    plan: str
    created_at: datetime

    @classmethod
    def from_row(cls, workspace: Workspace) -> "WorkspaceRead":
        """Build the response shape from a stored workspace row."""
        return cls(
            id=workspace.id,
            name=workspace.name,
            plan=workspace.plan,
            created_at=workspace.created_at,
        )
