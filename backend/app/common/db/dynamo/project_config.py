"""The `project_config` table: a project's statuses and labels, in one table.

Both entities share the partition and are told apart by the sort key prefix:
`project#<pid>#status#<sid>` and `project#<pid>#label#<lid>`. Transition rules take
the same shape and arrive with M5, which is why the key is a prefix rather than a
second table per entity.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository, new_ulid

from app.common.db.dynamo.base import as_item, build_repository, conditional_write, utc_now
from app.common.db.dynamo.tables import PROJECT_CONFIG

StatusCategory = Literal["backlog", "unstarted", "started", "completed", "cancelled"]

STATUS_CATEGORIES: tuple[str, ...] = ("backlog", "unstarted", "started", "completed", "cancelled")

DEFAULT_STATUSES: tuple[tuple[str, str, int], ...] = (
    ("Backlog", "backlog", 0),
    ("Todo", "unstarted", 1),
    ("In Progress", "started", 2),
    ("Done", "completed", 3),
    ("Cancelled", "cancelled", 4),
)
"""The seed every new project gets, per the M1 contract."""


def new_config_id() -> str:
    """A fresh status or label id, time sortable so ties break by creation order."""
    return new_ulid()


def status_key(project_id: str, status_id: str) -> str:
    """The sort key of one status."""
    return f"project#{project_id}#status#{status_id}"


def label_key(project_id: str, label_id: str) -> str:
    """The sort key of one label."""
    return f"project#{project_id}#label#{label_id}"


def status_prefix(project_id: str) -> str:
    """The sort key prefix every status of one project shares."""
    return f"project#{project_id}#status#"


def label_prefix(project_id: str) -> str:
    """The sort key prefix every label of one project shares."""
    return f"project#{project_id}#label#"


class Status(BaseModel):
    """One workflow status of a project, ordered by `position`."""

    workspace_id: str
    config_key: str
    project_id: str
    status_id: str
    name: str
    category: str
    position: int = 0
    created_at: datetime = Field(default_factory=utc_now)


class Label(BaseModel):
    """One label of a project, named and coloured."""

    workspace_id: str
    config_key: str
    project_id: str
    label_id: str
    name: str
    color: str
    created_at: datetime = Field(default_factory=utc_now)


class ProjectConfigRepository:
    """Reads and writes `project_config` rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(PROJECT_CONFIG, repository)

    def get_status(self, workspace_id: str, project_id: str, status_id: str) -> Status | None:
        """One status of a project, or `None`."""
        if not workspace_id or not project_id or not status_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "config_key": status_key(project_id, status_id)})
        return Status.model_validate(dict(item)) if item is not None else None

    def get_label(self, workspace_id: str, project_id: str, label_id: str) -> Label | None:
        """One label of a project, or `None`."""
        if not workspace_id or not project_id or not label_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "config_key": label_key(project_id, label_id)})
        return Label.model_validate(dict(item)) if item is not None else None

    def create_status(self, status: Status) -> Status:
        """Store one status, raising `ConditionFailed` on a key collision."""
        self._create(status.workspace_id, status.config_key, as_item(status))
        return status

    def create_label(self, label: Label) -> Label:
        """Store one label, raising `ConditionFailed` on a key collision."""
        self._create(label.workspace_id, label.config_key, as_item(label))
        return label

    def _create(self, workspace_id: str, config_key: str, item: dict[str, Any]) -> None:
        """Write one config row only when the sort key is free."""
        key = {"workspace_id": workspace_id, "config_key": config_key}
        with conditional_write(PROJECT_CONFIG.suffix, condition="config_key not_exists", key=key):
            self._repository.put(item, condition=Attr("config_key").not_exists())

    def seed_statuses(self, workspace_id: str, project_id: str) -> list[Status]:
        """Write the default status set for a new project, in contract order."""
        seeded: list[Status] = []
        for name, category, position in DEFAULT_STATUSES:
            status_id = new_config_id()
            seeded.append(
                self.create_status(
                    Status(
                        workspace_id=workspace_id,
                        config_key=status_key(project_id, status_id),
                        project_id=project_id,
                        status_id=status_id,
                        name=name,
                        category=category,
                        position=position,
                    )
                )
            )
        return seeded

    def list_statuses(self, workspace_id: str, project_id: str, *, limit: int = 200) -> list[Status]:
        """Every status of one project, ordered by `position` as the contract says."""
        items = self._query(workspace_id, status_prefix(project_id), limit)
        statuses = [Status.model_validate(dict(item)) for item in items]
        return sorted(statuses, key=lambda row: (row.position, row.status_id))

    def list_labels(self, workspace_id: str, project_id: str, *, limit: int = 200) -> list[Label]:
        """Every label of one project, by name."""
        items = self._query(workspace_id, label_prefix(project_id), limit)
        labels = [Label.model_validate(dict(item)) for item in items]
        return sorted(labels, key=lambda row: row.name.lower())

    def _query(self, workspace_id: str, prefix: str, limit: int) -> list[Mapping[str, Any]]:
        """Every config row of one project under a sort key prefix."""
        if not workspace_id or not prefix:
            return []
        return list(
            self._repository.iter_query(
                Key("workspace_id").eq(workspace_id) & Key("config_key").begins_with(prefix),
                max_items=limit,
            )
        )

    def update_status(self, workspace_id: str, project_id: str, status_id: str, **attributes: Any) -> Status | None:
        """Apply `attributes` to one status, or `None` when it does not exist."""
        item = self._update(workspace_id, status_key(project_id, status_id), attributes)
        return Status.model_validate(dict(item)) if item is not None else None

    def update_label(self, workspace_id: str, project_id: str, label_id: str, **attributes: Any) -> Label | None:
        """Apply `attributes` to one label, or `None` when it does not exist."""
        item = self._update(workspace_id, label_key(project_id, label_id), attributes)
        return Label.model_validate(dict(item)) if item is not None else None

    def _update(self, workspace_id: str, config_key: str, attributes: Mapping[str, Any]) -> Mapping[str, Any] | None:
        """Apply attributes to one config row, aliasing every reserved name."""
        values = {name: value for name, value in attributes.items() if value is not None}
        if not values:
            item = self._repository.get({"workspace_id": workspace_id, "config_key": config_key})
            return item
        key = {"workspace_id": workspace_id, "config_key": config_key}
        names = {f"#n{index}": name for index, name in enumerate(values)}
        expression_values = {f":v{index}": value for index, value in enumerate(values.values())}
        assignments = ", ".join(f"#n{index} = :v{index}" for index in range(len(values)))
        try:
            with conditional_write(PROJECT_CONFIG.suffix, condition="config_key exists", key=key):
                return self._repository.update(
                    key,
                    update_expression=f"SET {assignments}",
                    expression_values=expression_values,
                    expression_names=names,
                    condition=Attr("config_key").exists(),
                    return_values="ALL_NEW",
                )
        except ConditionFailed:
            return None

    def delete_status(self, workspace_id: str, project_id: str, status_id: str) -> bool:
        """Remove one status, reporting whether one was there."""
        if self.get_status(workspace_id, project_id, status_id) is None:
            return False
        self._repository.delete({"workspace_id": workspace_id, "config_key": status_key(project_id, status_id)})
        return True

    def delete_label(self, workspace_id: str, project_id: str, label_id: str) -> bool:
        """Remove one label, reporting whether one was there."""
        if self.get_label(workspace_id, project_id, label_id) is None:
            return False
        self._repository.delete({"workspace_id": workspace_id, "config_key": label_key(project_id, label_id)})
        return True

    def delete_for_project(self, workspace_id: str, project_id: str) -> int:
        """Remove every status and label of one project, returning how many went.

        Called when a project is deleted, so its config does not outlive it in a
        table nothing else would ever read that partition prefix from.
        """
        removed = 0
        for prefix in (status_prefix(project_id), label_prefix(project_id)):
            for item in self._query(workspace_id, prefix, 1000):
                self._repository.delete({"workspace_id": workspace_id, "config_key": item["config_key"]})
                removed += 1
        return removed
