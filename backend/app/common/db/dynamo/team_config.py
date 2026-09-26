"""The `team_config` table: a team's statuses and labels, in one table.

Both entities share the partition and are told apart by the sort key prefix:
`team#<pid>#status#<sid>`, `team#<pid>#label#<lid>` and, from M5,
`team#<pid>#transition#<tid>`. The key is a prefix rather than a table per entity
because each is read as one prefix query inside one team.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository, new_ulid

from app.common.db.dynamo.base import as_item, build_repository, utc_now
from app.common.db.dynamo.tables import TEAM_CONFIG

StatusCategory = Literal["backlog", "unstarted", "started", "completed", "cancelled"]

STATUS_CATEGORIES: tuple[str, ...] = ("backlog", "unstarted", "started", "completed", "cancelled")

DEFAULT_STATUSES: tuple[tuple[str, str, int], ...] = (
    ("Backlog", "backlog", 0),
    ("Todo", "unstarted", 1),
    ("In Progress", "started", 2),
    ("Done", "completed", 3),
    ("Cancelled", "cancelled", 4),
)
"""The seed every new team gets, per the M1 contract."""


def new_config_id() -> str:
    """A fresh status or label id, time sortable so ties break by creation order."""
    return new_ulid()


TRIGGERS: tuple[str, ...] = ("pr_opened", "pr_ready_for_review", "pr_merged", "pr_closed")
"""What a transition rule may fire on, per the M5 contract."""

TriggerName = Literal["pr_opened", "pr_ready_for_review", "pr_merged", "pr_closed"]

DEFAULT_TRANSITIONS: tuple[tuple[str, str, int], ...] = (
    ("pr_opened", "started", 0),
    ("pr_merged", "completed", 1),
)
"""The design section 4 defaults, as a trigger and the status category it moves to.

Stored as a category rather than a status id because the rule has to mean something
in a team whose statuses were renamed, and because seeding rows at team create
time would leave every team that predates M5 without them and make "uses the
defaults" indistinguishable from "was configured to exactly the defaults".
"""


def transition_key(team_id: str, transition_id: str) -> str:
    """The sort key of one transition rule."""
    return f"team#{team_id}#transition#{transition_id}"


def transition_prefix(team_id: str) -> str:
    """The sort key prefix every transition rule of one team shares."""
    return f"team#{team_id}#transition#"


def status_key(team_id: str, status_id: str) -> str:
    """The sort key of one status."""
    return f"team#{team_id}#status#{status_id}"


def label_key(team_id: str, label_id: str) -> str:
    """The sort key of one label."""
    return f"team#{team_id}#label#{label_id}"


def status_prefix(team_id: str) -> str:
    """The sort key prefix every status of one team shares."""
    return f"team#{team_id}#status#"


def label_prefix(team_id: str) -> str:
    """The sort key prefix every label of one team shares."""
    return f"team#{team_id}#label#"


class Status(BaseModel):
    """One workflow status of a team, ordered by `position`."""

    workspace_id: str
    config_key: str
    team_id: str
    status_id: str
    name: str
    category: str
    position: int = 0
    created_at: datetime = Field(default_factory=utc_now)


class Label(BaseModel):
    """One label of a team, named and coloured."""

    workspace_id: str
    config_key: str
    team_id: str
    label_id: str
    name: str
    color: str
    created_at: datetime = Field(default_factory=utc_now)


class Transition(BaseModel):
    """One rule mapping a pull request event onto a status of the team."""

    workspace_id: str
    config_key: str
    team_id: str
    transition_id: str
    trigger: str
    status_id: str
    position: int = 0
    created_at: datetime = Field(default_factory=utc_now)


class TeamConfigRepository:
    """Reads and writes `team_config` rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(TEAM_CONFIG, repository)

    def get_status(self, workspace_id: str, team_id: str, status_id: str) -> Status | None:
        """One status of a team, or `None`."""
        if not workspace_id or not team_id or not status_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "config_key": status_key(team_id, status_id)})
        return Status.model_validate(dict(item)) if item is not None else None

    def get_label(self, workspace_id: str, team_id: str, label_id: str) -> Label | None:
        """One label of a team, or `None`."""
        if not workspace_id or not team_id or not label_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "config_key": label_key(team_id, label_id)})
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
        self._repository.put(item, condition=Attr("config_key").not_exists())

    def default_statuses(self, workspace_id: str, team_id: str) -> list[Status]:
        """The default status set for a new team, built but not written.

        Separated from writing them so the same rows can go into a transaction
        with the team row rather than following it as a second write.
        """
        statuses: list[Status] = []
        for name, category, position in DEFAULT_STATUSES:
            status_id = new_config_id()
            statuses.append(
                Status(
                    workspace_id=workspace_id,
                    config_key=status_key(team_id, status_id),
                    team_id=team_id,
                    status_id=status_id,
                    name=name,
                    category=category,
                    position=position,
                )
            )
        return statuses

    def create_status_action(self, status: Status) -> dict[str, Any]:
        """A transaction Put for one status, holding the same key-free condition."""
        return self._repository.put_action(as_item(status), condition=Attr("config_key").not_exists())

    def seed_statuses(self, workspace_id: str, team_id: str) -> list[Status]:
        """Write the default status set for a new team, in contract order."""
        return [self.create_status(status) for status in self.default_statuses(workspace_id, team_id)]

    def list_statuses(self, workspace_id: str, team_id: str, *, limit: int = 200) -> list[Status]:
        """Every status of one team, ordered by `position` as the contract says."""
        items = self._query(workspace_id, status_prefix(team_id), limit)
        statuses = [Status.model_validate(dict(item)) for item in items]
        return sorted(statuses, key=lambda row: (row.position, row.status_id))

    def list_labels(self, workspace_id: str, team_id: str, *, limit: int = 200) -> list[Label]:
        """Every label of one team, by name."""
        items = self._query(workspace_id, label_prefix(team_id), limit)
        labels = [Label.model_validate(dict(item)) for item in items]
        return sorted(labels, key=lambda row: row.name.lower())

    def _query(self, workspace_id: str, prefix: str, limit: int) -> list[Mapping[str, Any]]:
        """Every config row of one team under a sort key prefix."""
        if not workspace_id or not prefix:
            return []
        return list(
            self._repository.iter_query(
                Key("workspace_id").eq(workspace_id) & Key("config_key").begins_with(prefix),
                max_items=limit,
            )
        )

    def update_status(self, workspace_id: str, team_id: str, status_id: str, **attributes: Any) -> Status | None:
        """Apply `attributes` to one status, or `None` when it does not exist."""
        item = self._update(workspace_id, status_key(team_id, status_id), attributes)
        return Status.model_validate(dict(item)) if item is not None else None

    def update_label(self, workspace_id: str, team_id: str, label_id: str, **attributes: Any) -> Label | None:
        """Apply `attributes` to one label, or `None` when it does not exist."""
        item = self._update(workspace_id, label_key(team_id, label_id), attributes)
        return Label.model_validate(dict(item)) if item is not None else None

    def _update(self, workspace_id: str, config_key: str, attributes: Mapping[str, Any]) -> Mapping[str, Any] | None:
        """Apply attributes to one config row, or read it back when none were given."""
        values = {name: value for name, value in attributes.items() if value is not None}
        key = {"workspace_id": workspace_id, "config_key": config_key}
        if not values:
            return self._repository.get(key)
        try:
            return self._repository.set_attributes(key, values, condition=Attr("team_id").exists())
        except ConditionFailed:
            return None

    def delete_status(self, workspace_id: str, team_id: str, status_id: str) -> bool:
        """Remove one status, reporting whether one was there."""
        if self.get_status(workspace_id, team_id, status_id) is None:
            return False
        self._repository.delete({"workspace_id": workspace_id, "config_key": status_key(team_id, status_id)})
        return True

    def delete_label(self, workspace_id: str, team_id: str, label_id: str) -> bool:
        """Remove one label, reporting whether one was there."""
        if self.get_label(workspace_id, team_id, label_id) is None:
            return False
        self._repository.delete({"workspace_id": workspace_id, "config_key": label_key(team_id, label_id)})
        return True

    def get_transition(self, workspace_id: str, team_id: str, transition_id: str) -> Transition | None:
        """One transition rule of a team, or `None`."""
        if not workspace_id or not team_id or not transition_id:
            return None
        item = self._repository.get(
            {"workspace_id": workspace_id, "config_key": transition_key(team_id, transition_id)}
        )
        return Transition.model_validate(dict(item)) if item is not None else None

    def create_transition(self, transition: Transition) -> Transition:
        """Store one transition rule, raising `ConditionFailed` on a key collision."""
        self._create(transition.workspace_id, transition.config_key, as_item(transition))
        return transition

    def list_transitions(self, workspace_id: str, team_id: str, *, limit: int = 100) -> list[Transition]:
        """Every stored transition rule of one team, ordered by `position`.

        Empty means the team has never been configured, and the caller applies
        `DEFAULT_TRANSITIONS` instead. It deliberately does not fall back here: a
        repository that invented rows would make the CRUD routes unable to tell a
        configured team from an unconfigured one.
        """
        items = self._query(workspace_id, transition_prefix(team_id), limit)
        rows = [Transition.model_validate(dict(item)) for item in items]
        return sorted(rows, key=lambda row: (row.position, row.transition_id))

    def update_transition(
        self, workspace_id: str, team_id: str, transition_id: str, **attributes: Any
    ) -> Transition | None:
        """Apply `attributes` to one transition rule, or `None` when it does not exist."""
        item = self._update(workspace_id, transition_key(team_id, transition_id), attributes)
        return Transition.model_validate(dict(item)) if item is not None else None

    def delete_transition(self, workspace_id: str, team_id: str, transition_id: str) -> bool:
        """Remove one transition rule, reporting whether one was there."""
        if self.get_transition(workspace_id, team_id, transition_id) is None:
            return False
        self._repository.delete({"workspace_id": workspace_id, "config_key": transition_key(team_id, transition_id)})
        return True

    def delete_for_team(self, workspace_id: str, team_id: str, *, batch: int = 100) -> int:
        """Remove every status, label and transition of one team, returning how many went.

        Deletes a page at a time until each prefix reads empty, so a team of any
        size is purged and a retry after a crash resumes where the last one stopped.
        """
        removed = 0
        for prefix in (status_prefix(team_id), label_prefix(team_id), transition_prefix(team_id)):
            while True:
                items = self._query(workspace_id, prefix, batch)
                if not items:
                    break
                removed += self._repository.delete_many(
                    [{"workspace_id": workspace_id, "config_key": item["config_key"]} for item in items]
                )
        return removed
