"""Response schemas for the workspaces routes.

Every list route answers an object, never a bare array, so a later cursor can be
added beside the items without breaking a client. `webbpulse.http.CursorPage` is
the shared model that will own this shape once the platform gains it, which
`docs/design.md` lists as an outstanding upstream gap; until then the envelope is
declared here and the field name matches what that model will carry.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from app.common.db.dynamo.workspaces import Workspace


class WorkspaceRead(BaseModel):
    """One workspace as the API returns it.

    `owner_user_id` is deliberately absent: it is a tenancy detail the list route
    has already applied, and echoing it tells a caller nothing it can act on.
    """

    id: str
    name: str
    slug: str
    plan: str
    created_at: datetime

    @classmethod
    def from_row(cls, workspace: Workspace) -> "WorkspaceRead":
        """Build the response shape from a stored workspace row."""
        return cls(
            id=workspace.id,
            name=workspace.name,
            slug=workspace.slug,
            plan=workspace.plan,
            created_at=workspace.created_at,
        )


class WorkspaceListRead(BaseModel):
    """The body `GET /api/workspaces` answers with.

    An object rather than an array, so pagination can arrive as a sibling field.
    """

    workspaces: list[WorkspaceRead]

    @classmethod
    def from_rows(cls, rows: list[Workspace]) -> "WorkspaceListRead":
        """Build the enveloped response from stored workspace rows."""
        return cls(workspaces=[WorkspaceRead.from_row(row) for row in rows])
