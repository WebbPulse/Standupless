"""The `workspaces` table: the tenant every Standupless key is scoped to.

A workspace row is the minimum a multi-tenant product needs on day one: an id,
a name, the owner and the plan field the limit hooks will read. The issue
tracker's own entities arrive with the design doc and are not modelled here.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping

from boto3.dynamodb.conditions import Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import Repository

from app.common.core.config import settings
from app.common.db.dynamo.tables import WORKSPACES

DEFAULT_PLAN = "free"

OWNER_INDEX = "owner_user_id-index"


def utc_now() -> datetime:
    """The current UTC time, as a timezone-aware datetime."""
    return datetime.now(timezone.utc)


class Workspace(BaseModel):
    """One tenant: its id, slug, display name, owner and plan.

    The slug is the workspace's stable URL segment, unique across the product and
    indexed by `slug-index`, so a link survives a rename of the display name.
    """

    id: str
    name: str
    slug: str
    owner_user_id: str
    plan: str = DEFAULT_PLAN
    created_at: datetime = Field(default_factory=utc_now)


class WorkspaceRepository:
    """Reads and writes `workspaces` rows through the shared package repository.

    Constructing it makes no AWS call: the package repository builds its client
    on first use.
    """

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = repository if repository is not None else self._build_repository()

    @staticmethod
    def _build_repository() -> Repository:
        """The package repository for the `workspaces` table in this environment."""
        return Repository(
            WORKSPACES.suffix,
            prefix=settings.dynamodb_table_prefix,
            endpoint_url=settings.DYNAMODB_ENDPOINT_URL or None,
        )

    def create(self, workspace: Workspace) -> Workspace:
        """Store a new workspace row and return it as stored."""
        self._repository.put(workspace.model_dump(mode="json"))
        return workspace

    def list_for_user(self, user_id: str, *, limit: int = 100) -> list[Workspace]:
        """Every workspace this user owns, newest first.

        Queries the `owner_user_id-index` rather than scanning, so no read can
        span tenants. An unknown user answers an empty list.
        """
        if not user_id:
            return []
        page = self._repository.query(
            Key("owner_user_id").eq(user_id),
            index_name=OWNER_INDEX,
            limit=limit,
        )
        workspaces = [_as_workspace(item) for item in page.items]
        return sorted(workspaces, key=lambda workspace: workspace.created_at, reverse=True)


def _as_workspace(item: Mapping[str, Any]) -> Workspace:
    """One stored item as a `Workspace`."""
    return Workspace.model_validate(dict(item))
