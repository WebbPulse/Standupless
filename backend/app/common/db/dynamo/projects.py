"""The `projects` table: the isolation unit inside a workspace.

Key prefix uniqueness is per workspace, so the indexed attribute is the composite
`workspace_key_prefix` (`<workspace_id>#<KEY>`) rather than the bare prefix: a
bare-prefix index would be a cross-tenant hash key, which design section 2 forbids.
Uniqueness is the same conditional write plus index read the workspace slug uses.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Literal, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository, new_ulid

from app.common.db.dynamo.base import as_item, build_repository, conditional_write, utc_now
from app.common.db.dynamo.tables import PROJECTS

KEY_PREFIX_INDEX = "workspace_key_prefix-index"

KEY_PREFIX_PATTERN = re.compile(r"^[A-Z][A-Z0-9]{1,5}$")

EstimateScale = Literal["off", "fibonacci", "linear", "tshirt"]

ESTIMATE_SCALES: tuple[str, ...] = ("off", "fibonacci", "linear", "tshirt")

DEFAULT_ESTIMATE_SCALE = "off"


def new_project_id() -> str:
    """A fresh project id, time sortable so a listing reads in creation order."""
    return new_ulid()


def is_valid_key_prefix(key_prefix: str) -> bool:
    """Whether this key prefix is the uppercase form the contract requires."""
    return bool(KEY_PREFIX_PATTERN.match(key_prefix))


def workspace_key_prefix(workspace_id: str, key_prefix: str) -> str:
    """The composite the uniqueness index is keyed by, scoped to one workspace."""
    return f"{workspace_id}#{key_prefix.upper()}"


class Project(BaseModel):
    """One project: the unit a guest is granted and an issue key is allocated from."""

    workspace_id: str
    project_id: str = Field(default_factory=new_project_id)
    name: str
    key_prefix: str
    description: str | None = None
    estimate_scale: str = DEFAULT_ESTIMATE_SCALE
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class ProjectRepository:
    """Reads and writes `projects` rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(PROJECTS, repository)

    def get(self, workspace_id: str, project_id: str) -> Project | None:
        """One project of this workspace, or `None`."""
        if not workspace_id or not project_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "project_id": project_id})
        return _as_project(item) if item is not None else None

    def get_by_key_prefix(self, workspace_id: str, key_prefix: str) -> Project | None:
        """The project holding this key prefix in this workspace, or `None`."""
        if not workspace_id or not key_prefix:
            return None
        page = self._repository.query(
            Key("workspace_key_prefix").eq(workspace_key_prefix(workspace_id, key_prefix)),
            index_name=KEY_PREFIX_INDEX,
            limit=1,
        )
        if not page.items:
            return None
        return _as_project(page.items[0])

    def create(self, project: Project) -> Project:
        """Store a new project, raising `ConditionFailed` when the prefix is taken."""
        if self.get_by_key_prefix(project.workspace_id, project.key_prefix) is not None:
            raise ConditionFailed(
                PROJECTS.suffix,
                "key_prefix is already taken in this workspace",
                {"workspace_id": project.workspace_id, "key_prefix": project.key_prefix},
            )
        key = {"workspace_id": project.workspace_id, "project_id": project.project_id}
        with conditional_write(PROJECTS.suffix, condition="project_id not_exists", key=key):
            self._repository.put(
                as_item(project, workspace_key_prefix=workspace_key_prefix(project.workspace_id, project.key_prefix)),
                condition=Attr("project_id").not_exists(),
            )
        return project

    def update(self, workspace_id: str, project_id: str, **attributes: Any) -> Project | None:
        """Apply `attributes` to one project, or `None` when it does not exist.

        The key prefix is not updatable here: it is denormalised onto every issue
        key ever allocated, so changing it would orphan them.
        """
        values = {name: value for name, value in attributes.items() if value is not None}
        values["updated_at"] = utc_now().isoformat()
        key = {"workspace_id": workspace_id, "project_id": project_id}

        names = {f"#set{index}": name for index, name in enumerate(values)}
        expression_values = {f":set{index}": value for index, value in enumerate(values.values())}
        assignments = ", ".join(f"#set{index} = :set{index}" for index in range(len(values)))

        try:
            with conditional_write(PROJECTS.suffix, condition="the project row exists", key=key):
                item = self._repository.update(
                    key,
                    update_expression=f"SET {assignments}",
                    expression_values=expression_values,
                    expression_names=names,
                    condition=Attr("name").exists(),
                    return_values="ALL_NEW",
                )
        except ConditionFailed:
            return None
        return _as_project(item) if item is not None else None

    def list_for_workspace(self, workspace_id: str, *, limit: int = 200) -> list[Project]:
        """Every project of this workspace, oldest first."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(Key("workspace_id").eq(workspace_id), max_items=limit)
        return sorted((_as_project(item) for item in items), key=lambda row: row.created_at)

    def delete(self, workspace_id: str, project_id: str) -> bool:
        """Hard-delete one project row, reporting whether one was there."""
        if self.get(workspace_id, project_id) is None:
            return False
        self._repository.delete({"workspace_id": workspace_id, "project_id": project_id})
        return True


def _as_project(item: Mapping[str, Any]) -> Project:
    """One stored item as a `Project`, ignoring the uniqueness index attribute."""
    fields = {key: value for key, value in item.items() if key != "workspace_key_prefix"}
    return Project.model_validate(fields)
