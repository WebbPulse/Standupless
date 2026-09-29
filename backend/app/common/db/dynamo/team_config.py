"""The `team_config` table: a team's statuses and labels, in one table.

Both entities share the partition and are told apart by the sort key prefix:
`team#<pid>#status#<sid>`, `team#<pid>#label#<lid>` and, from M5,
`team#<pid>#transition#<tid>`. The key is a prefix rather than a table per entity
because each is read as one prefix query inside one team.

A team's automatic cycle settings are one row at `team#<pid>#cycles`, carrying a
`kind` so the scheduled cycle job can find every enabled team with one filtered
scan of this small table rather than an index of its own.

The auto-archive period is one row at `team#<pid>#archive`, found by the hourly
archive sweep in the same scan as the finished statuses it reads issues from.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Mapping, Sequence

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository, new_ulid

from app.common.db.dynamo.base import as_item, build_repository, delete_partition, utc_now
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


CYCLE_SETTINGS = "cycle_settings"
"""The `kind` a team's cycle settings row carries."""

DEFAULT_CYCLE_DURATION_WEEKS = 2
"""How long an automatic cycle runs when the team has not chosen, as Linear defaults."""

DEFAULT_CYCLE_COOLDOWN_WEEKS = 0
"""The gap between automatic cycles when the team has not chosen: none."""

DEFAULT_CYCLE_START_WEEKDAY = 0
"""The weekday an automatic cycle starts on, Monday, counted as Python's `weekday()` does."""

DEFAULT_UPCOMING_CYCLES = 2
"""How many upcoming cycles are kept created ahead of the current one by default."""

MAX_UPCOMING_CYCLES = 15
"""The most upcoming cycles a team may keep created, Linear's own ceiling."""


ARCHIVE_SETTINGS = "archive_settings"
"""The `kind` a team's auto-archive settings row carries."""

ARCHIVE_PERIODS: tuple[int, ...] = (1, 3, 6, 9, 12)
"""The months after completion a team may archive issues at, Linear's own choices."""

DEFAULT_ARCHIVE_PERIOD_MONTHS = 6
"""How long a finished issue stays visible before it is archived, when the team has not chosen."""

FINISHED_CATEGORIES: tuple[str, ...] = ("completed", "cancelled")
"""The status categories whose issues auto-archive once the period has passed."""


def archive_settings_key(team_id: str) -> str:
    """The sort key of one team's auto-archive settings row."""
    return f"team#{team_id}#archive"


def cycle_settings_key(team_id: str) -> str:
    """The sort key of one team's cycle settings row."""
    return f"team#{team_id}#cycles"


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
    """One workflow status of a team, ordered by `position`.

    `color` and `icon` are absent on rows written before statuses could carry them,
    and absent means the category default, so those rows render as they always did.
    """

    workspace_id: str
    config_key: str
    team_id: str
    status_id: str
    name: str
    category: str
    position: int = 0
    color: str | None = None
    icon: str | None = None
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
    """One rule mapping a pull request event onto a status of the team.

    `branch_pattern` is a glob over the branch the pull request targets, empty for
    a rule that holds on any branch. Rows written before it existed read as empty,
    so they keep meaning what they did.
    """

    workspace_id: str
    config_key: str
    team_id: str
    transition_id: str
    trigger: str
    status_id: str
    branch_pattern: str = ""
    position: int = 0
    created_at: datetime = Field(default_factory=utc_now)


class CycleSettings(BaseModel):
    """How a team's cycles are created automatically, one row per team.

    A team that never saved the settings reads as the defaults with automatic
    cycles off, so turning the feature on is the only write that ever makes one.
    """

    workspace_id: str
    config_key: str
    team_id: str
    kind: str = CYCLE_SETTINGS
    enabled: bool = False
    duration_weeks: int = DEFAULT_CYCLE_DURATION_WEEKS
    cooldown_weeks: int = DEFAULT_CYCLE_COOLDOWN_WEEKS
    start_weekday: int = DEFAULT_CYCLE_START_WEEKDAY
    upcoming_count: int = DEFAULT_UPCOMING_CYCLES
    auto_add_started: bool = True
    updated_at: datetime | None = None


def default_cycle_settings(workspace_id: str, team_id: str) -> CycleSettings:
    """The settings a team that never configured cycles reads as."""
    return CycleSettings(workspace_id=workspace_id, config_key=cycle_settings_key(team_id), team_id=team_id)


class ArchiveSettings(BaseModel):
    """After how many months a team's finished issues are archived, one row per team.

    A team that never saved the setting reads as the six month default, which
    the sweep applies too, so auto-archive is on for every team as it is in Linear.
    """

    workspace_id: str
    config_key: str
    team_id: str
    kind: str = ARCHIVE_SETTINGS
    period_months: int = DEFAULT_ARCHIVE_PERIOD_MONTHS
    updated_at: datetime | None = None


def default_archive_settings(workspace_id: str, team_id: str) -> ArchiveSettings:
    """The auto-archive setting a team that never chose one reads as."""
    return ArchiveSettings(workspace_id=workspace_id, config_key=archive_settings_key(team_id), team_id=team_id)


class ArchiveTarget(BaseModel):
    """One team the archive sweep visits: its finished statuses and its period."""

    workspace_id: str
    team_id: str
    status_ids: list[str] = Field(default_factory=list)
    period_months: int = DEFAULT_ARCHIVE_PERIOD_MONTHS


def _status_item(status: Status) -> dict[str, Any]:
    """A status as a stored item, leaving out an unset color or icon rather than storing null."""
    item = as_item(status)
    for name in STATUS_APPEARANCE_FIELDS:
        if item.get(name) is None:
            item.pop(name, None)
    return item


STATUS_APPEARANCE_FIELDS: tuple[str, ...] = ("color", "icon")
"""The status fields a patch may clear, which are removed from the row rather than nulled."""


class TeamConfigRepository:
    """Reads and writes `team_config` rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(TEAM_CONFIG, repository)

    def delete_workspace_rows(self, workspace_id: str) -> int:
        """Delete every row this table holds for one workspace, for the workspace purge."""
        return delete_partition(self._repository, TEAM_CONFIG, workspace_id)

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
        self._create(status.workspace_id, status.config_key, _status_item(status))
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
        return self._repository.put_action(_status_item(status), condition=Attr("config_key").not_exists())

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

    def update_status(
        self, workspace_id: str, team_id: str, status_id: str, *, clear: Sequence[str] = (), **attributes: Any
    ) -> Status | None:
        """Apply `attributes` to one status and remove the `clear` ones, or `None` when it does not exist."""
        config_key = status_key(team_id, status_id)
        if not clear:
            item = self._update(workspace_id, config_key, attributes)
            return Status.model_validate(dict(item)) if item is not None else None
        values = {name: value for name, value in attributes.items() if value is not None}
        names = {f"#set{index}": name for index, name in enumerate(values)}
        names.update({f"#rm{index}": name for index, name in enumerate(clear)})
        expression = "REMOVE " + ", ".join(f"#rm{index}" for index in range(len(clear)))
        if values:
            assignments = ", ".join(f"#set{index} = :set{index}" for index in range(len(values)))
            expression = f"SET {assignments} {expression}"
        try:
            item = self._repository.update(
                {"workspace_id": workspace_id, "config_key": config_key},
                update_expression=expression,
                expression_values={f":set{index}": value for index, value in enumerate(values.values())} or None,
                expression_names=names,
                condition=Attr("team_id").exists(),
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
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

    def replace_transitions(self, workspace_id: str, team_id: str, rows: list[Transition]) -> list[Transition]:
        """Swap a team's whole rule set for `rows`, which may be empty to restore the defaults."""
        for existing in self.list_transitions(workspace_id, team_id):
            self._repository.delete({"workspace_id": workspace_id, "config_key": existing.config_key})
        return [self.create_transition(row) for row in rows]

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

    def get_cycle_settings(self, workspace_id: str, team_id: str) -> CycleSettings | None:
        """One team's stored cycle settings, or `None` when it never saved any."""
        if not workspace_id or not team_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "config_key": cycle_settings_key(team_id)})
        return CycleSettings.model_validate(dict(item)) if item is not None else None

    def put_cycle_settings(self, settings: CycleSettings) -> CycleSettings:
        """Store one team's cycle settings whole, stamped with the time of the write.

        A whole-row put rather than a conditional create, because the row is one
        team's single settings document and the last save is the one that stands.
        """
        stored = settings.model_copy(update={"updated_at": utc_now()})
        self._repository.put(as_item(stored))
        return stored

    def iter_enabled_cycle_settings(self, *, page_size: int = 200) -> list[CycleSettings]:
        """Every team's cycle settings with automatic cycles on, across every workspace.

        A filtered scan: the scheduled cycle job has no workspace to start from,
        and this table holds a handful of rows per team, so a scan costs little
        more than an index would while needing none.
        """
        found: list[CycleSettings] = []
        start_key: Mapping[str, Any] | None = None
        while True:
            page = self._repository.scan(
                filter_expression=Attr("kind").eq(CYCLE_SETTINGS) & Attr("enabled").eq(True),
                limit=page_size,
                start_key=dict(start_key) if start_key else None,
            )
            found.extend(CycleSettings.model_validate(dict(item)) for item in page.items)
            start_key = page.last_evaluated_key
            if not start_key:
                return sorted(found, key=lambda row: (row.workspace_id, row.team_id))

    def get_archive_settings(self, workspace_id: str, team_id: str) -> ArchiveSettings | None:
        """One team's stored auto-archive setting, or `None` when it never saved one."""
        if not workspace_id or not team_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "config_key": archive_settings_key(team_id)})
        return ArchiveSettings.model_validate(dict(item)) if item is not None else None

    def put_archive_settings(self, settings: ArchiveSettings) -> ArchiveSettings:
        """Store one team's auto-archive setting whole, stamped with the time of the write."""
        stored = settings.model_copy(update={"updated_at": utc_now()})
        self._repository.put(as_item(stored))
        return stored

    def iter_archive_targets(self, *, page_size: int = 200) -> list[ArchiveTarget]:
        """Every team with a finished status, with its archive period, across every workspace.

        One filtered scan of this small table picks up both the finished statuses
        and the settings rows, the same cost profile as the cycle job's scan, so
        the sweep never has to enumerate teams or issues to find its work. A team
        with only a settings row and no finished status has nothing to archive
        and is left out.
        """
        targets: dict[tuple[str, str], ArchiveTarget] = {}
        start_key: Mapping[str, Any] | None = None
        while True:
            page = self._repository.scan(
                filter_expression=Attr("category").is_in(list(FINISHED_CATEGORIES)) | Attr("kind").eq(ARCHIVE_SETTINGS),
                limit=page_size,
                start_key=dict(start_key) if start_key else None,
            )
            for item in page.items:
                workspace_id, team_id = str(item["workspace_id"]), str(item["team_id"])
                target = targets.setdefault(
                    (workspace_id, team_id), ArchiveTarget(workspace_id=workspace_id, team_id=team_id)
                )
                if item.get("kind") == ARCHIVE_SETTINGS:
                    target.period_months = int(item.get("period_months", DEFAULT_ARCHIVE_PERIOD_MONTHS))
                elif item.get("status_id"):
                    target.status_ids.append(str(item["status_id"]))
            start_key = page.last_evaluated_key
            if not start_key:
                break
        return sorted(
            (target for target in targets.values() if target.status_ids),
            key=lambda row: (row.workspace_id, row.team_id),
        )

    def delete_for_team(self, workspace_id: str, team_id: str, *, batch: int = 100) -> int:
        """Remove every status, label, transition and the cycle and archive settings of one team.

        Deletes a page at a time until each prefix reads empty, so a team of any
        size is purged and a retry after a crash resumes where the last one stopped.
        The cycle settings go first, so a deleting team stops being stocked with
        cycles by the scheduled job straight away.
        """
        removed = 0
        if self.get_cycle_settings(workspace_id, team_id) is not None:
            self._repository.delete({"workspace_id": workspace_id, "config_key": cycle_settings_key(team_id)})
            removed += 1
        if self.get_archive_settings(workspace_id, team_id) is not None:
            self._repository.delete({"workspace_id": workspace_id, "config_key": archive_settings_key(team_id)})
            removed += 1
        for prefix in (status_prefix(team_id), label_prefix(team_id), transition_prefix(team_id)):
            while True:
                items = self._query(workspace_id, prefix, batch)
                if not items:
                    break
                removed += self._repository.delete_many(
                    [{"workspace_id": workspace_id, "config_key": item["config_key"]} for item in items]
                )
        return removed
