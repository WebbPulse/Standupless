"""The `workspaces` table: the tenant every Standupless key is scoped to.

Slug uniqueness is enforced by a conditional create plus a read of `slug-index`.
DynamoDB has no unique constraint on a non-key attribute, so the index read
rejects a slug already taken and the condition on `id` rejects the id collision;
a simultaneous pair of creates on one slug is the residual race, and the loser is
reported as a conflict rather than silently overwriting.

This is the one repository whose reads are keyed by workspace id rather than
taking `workspace_id` first, because the id is the partition key.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository, new_ulid

from app.common.db.dynamo.base import as_item, build_repository, conditional_write, utc_now
from app.common.db.dynamo.tables import WORKSPACES

DEFAULT_PLAN = "free"

SLUG_INDEX = "slug-index"

SLUG_PATTERN = re.compile(r"^[a-z0-9-]{3,40}$")


def new_workspace_id() -> str:
    """A fresh workspace id, time sortable so creation order survives the key."""
    return new_ulid()


def is_valid_slug(slug: str) -> bool:
    """Whether this slug is the lowercase, hyphenated form the contract requires."""
    return bool(SLUG_PATTERN.match(slug))


class Workspace(BaseModel):
    """One tenant: its id, slug, display name and plan.

    The slug is the workspace's stable URL segment, unique across the product and
    indexed by `slug-index`, so a link survives a rename of the display name.
    """

    id: str = Field(default_factory=new_workspace_id)
    name: str
    slug: str
    plan: str = DEFAULT_PLAN
    created_at: datetime = Field(default_factory=utc_now)


class WorkspaceRepository:
    """Reads and writes `workspaces` rows through the shared package repository."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(WORKSPACES, repository)

    def get(self, workspace_id: str) -> Workspace | None:
        """The workspace with this id, or `None`."""
        if not workspace_id:
            return None
        item = self._repository.get({"id": workspace_id})
        return _as_workspace(item) if item is not None else None

    def get_by_slug(self, slug: str) -> Workspace | None:
        """The workspace holding this slug, or `None`, through `slug-index`."""
        normalized = slug.strip().lower()
        if not normalized:
            return None
        page = self._repository.query(Key("slug").eq(normalized), index_name=SLUG_INDEX, limit=1)
        if not page.items:
            return None
        return _as_workspace(page.items[0])

    def create(self, workspace: Workspace) -> Workspace:
        """Store a new workspace, raising `ConditionFailed` when the slug is taken.

        The index read rejects a slug already in use and the conditional put rejects
        an id collision, which together are the uniqueness the contract promises.
        """
        if self.get_by_slug(workspace.slug) is not None:
            raise ConditionFailed(WORKSPACES.suffix, "slug is already taken", {"slug": workspace.slug})
        with conditional_write(WORKSPACES.suffix, condition="id not_exists", key={"id": workspace.id}):
            self._repository.put(as_item(workspace), condition=Attr("id").not_exists())
        return workspace

    def rename(self, workspace_id: str, name: str) -> Workspace | None:
        """Change a workspace's display name, or `None` when it does not exist."""
        key = {"id": workspace_id}
        try:
            with conditional_write(WORKSPACES.suffix, condition="id exists", key=key):
                item = self._repository.update(
                    key,
                    update_expression="SET #name = :name",
                    expression_names={"#name": "name"},
                    expression_values={":name": name},
                    condition=Attr("id").exists(),
                    return_values="ALL_NEW",
                )
        except ConditionFailed:
            return None
        return _as_workspace(item) if item is not None else None

    def delete(self, workspace_id: str) -> bool:
        """Hard-delete one workspace row, reporting whether one was there."""
        if self.get(workspace_id) is None:
            return False
        self._repository.delete({"id": workspace_id})
        return True

    def get_many(self, workspace_ids: list[str]) -> dict[str, Workspace]:
        """The named workspaces keyed by id, skipping any that are gone.

        One `BatchGetItem` behind the workspace list, so showing a caller their
        memberships costs one call rather than one per membership.
        """
        wanted = [workspace_id for workspace_id in dict.fromkeys(workspace_ids) if workspace_id]
        if not wanted:
            return {}
        items = self._repository.batch_get([{"id": workspace_id} for workspace_id in wanted])
        return {str(item["id"]): _as_workspace(item) for item in items}


def _as_workspace(item: Mapping[str, Any]) -> Workspace:
    """One stored item as a `Workspace`."""
    return Workspace.model_validate(dict(item))
