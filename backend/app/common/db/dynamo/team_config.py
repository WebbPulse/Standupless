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
The auto-close period and target status are one row at `team#<pid>#autoclose`,
found by the same hourly run with a scan of its own.

A team's SLA rules are one row at `team#<pid>#sla`, read when an issue's
priority, status or triage state moves.

A team's triage switch is one row at `triage#<pid>`, outside the `team#` prefix so
one prefix query lists every team of a workspace that has triage on.

A team's standup digest settings are one row at `team#<pid>#standup#settings`
and each member's note for one digest date is a row at
`team#<pid>#standup#note#<date>#<uid>`, so one prefix read returns a day's notes
and the team purge clears both with one prefix.

Workspace statuses and labels live at `workspace#status#<sid>` and
`workspace#label#<lid>` and carry no `team_id`: every team inherits them live.
A team hides or renames one locally with an override row at
`team#<pid>#override#status#<sid>` or `team#<pid>#override#label#<lid>`. A team's
effective set is its own rows plus the workspace rows with its overrides applied,
each tagged with the `scope` it came from.

A label may be a group, `is_group`, holding child labels that name it in
`parent_id`. Groups nest one level and live in the scope of their children, so a
workspace group holds workspace labels and a team group that team's labels. A
team that hides a workspace group hides its children with it.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Callable, Iterable, Literal, Mapping, Sequence

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


SLA_SETTINGS = "sla_settings"
"""The `kind` a team's SLA settings row carries."""

SLA_PRIORITIES: tuple[str, ...] = ("urgent", "high", "medium", "low")
"""The priorities an SLA rule may be set for; an issue with no priority has none."""

MAX_SLA_HOURS = 2160
"""The longest SLA a rule may set, ninety days."""

DEFAULT_SLA_HOURS: dict[str, int | None] = {"urgent": 24, "high": 72, "medium": None, "low": None}
"""The rules a team that never saved its SLA settings reads as, ready to switch on."""


def sla_settings_key(team_id: str) -> str:
    """The sort key of one team's SLA settings row."""
    return f"team#{team_id}#sla"


AUTO_CLOSE_SETTINGS = "auto_close_settings"
"""The `kind` a team's auto-close settings row carries."""

AUTO_CLOSE_PERIODS: tuple[int, ...] = (1, 3, 6, 9, 12)
"""The months without an update after which a team may close a stale issue, Linear's own choices."""

STALE_CATEGORIES: tuple[str, ...] = ("backlog",)
"""The status categories whose untouched issues auto-close, besides those waiting in triage."""


def auto_close_settings_key(team_id: str) -> str:
    """The sort key of one team's auto-close settings row."""
    return f"team#{team_id}#autoclose"


TRIAGE_SETTINGS = "triage_settings"
"""The `kind` a team's triage settings row carries."""

TRIAGE_PREFIX = "triage#"


def triage_settings_key(team_id: str) -> str:
    """The sort key of one team's triage settings row."""
    return f"{TRIAGE_PREFIX}{team_id}"


def cycle_settings_key(team_id: str) -> str:
    """The sort key of one team's cycle settings row."""
    return f"team#{team_id}#cycles"


def transition_key(team_id: str, transition_id: str) -> str:
    """The sort key of one transition rule."""
    return f"team#{team_id}#transition#{transition_id}"


def transition_prefix(team_id: str) -> str:
    """The sort key prefix every transition rule of one team shares."""
    return f"team#{team_id}#transition#"


WORKSPACE_STATUS_PREFIX = "workspace#status#"
"""The sort key prefix every workspace status shares."""

WORKSPACE_LABEL_PREFIX = "workspace#label#"
"""The sort key prefix every workspace label shares."""

TEAM_SCOPE = "team"
"""The `scope` of a status or label a team owns."""

WORKSPACE_SCOPE = "workspace"
"""The `scope` of a status or label every team inherits from the workspace."""

EFFECTIVE_FIELDS: tuple[str, ...] = ("scope", "hidden", "inherited_name")
"""Fields resolved at read time, never stored on a status or label row."""

OverrideTarget = Literal["status", "label"]


def workspace_status_key(status_id: str) -> str:
    """The sort key of one workspace status."""
    return f"{WORKSPACE_STATUS_PREFIX}{status_id}"


def workspace_label_key(label_id: str) -> str:
    """The sort key of one workspace label."""
    return f"{WORKSPACE_LABEL_PREFIX}{label_id}"


def override_prefix(team_id: str, target: str = "") -> str:
    """The sort key prefix of a team's overrides, of one target kind when named."""
    return f"team#{team_id}#override#{target}#" if target else f"team#{team_id}#override#"


def override_key(team_id: str, target: str, target_id: str) -> str:
    """The sort key of one team's override of one workspace status or label."""
    return f"{override_prefix(team_id, target)}{target_id}"


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
    """One workflow status of a team or of the workspace, ordered by `position`.

    `color` and `icon` are absent on rows written before statuses could carry them,
    and absent means the category default, so those rows render as they always did.
    A workspace row stores no `team_id`; read through a team it carries that team's
    id, its `scope` is `workspace`, and the team's override sets `hidden` and, for
    a local rename, `name` with the workspace name kept in `inherited_name`.
    """

    workspace_id: str
    config_key: str
    team_id: str = ""
    status_id: str
    name: str
    category: str
    position: int = 0
    color: str | None = None
    icon: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    scope: str = TEAM_SCOPE
    hidden: bool = False
    inherited_name: str | None = None


class Label(BaseModel):
    """One label of a team or of the workspace, named and coloured.

    Read through a team, a workspace label carries the same resolved fields a
    workspace status does. `is_group` and `parent_id` are absent on rows that are
    neither a group nor in one, which is every row written before groups existed.
    """

    workspace_id: str
    config_key: str
    team_id: str = ""
    label_id: str
    name: str
    color: str
    is_group: bool = False
    parent_id: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    scope: str = TEAM_SCOPE
    hidden: bool = False
    inherited_name: str | None = None


class Override(BaseModel):
    """One team's local change to a workspace status or label: hidden, renamed, or both."""

    workspace_id: str
    config_key: str
    team_id: str
    target: str
    target_id: str
    hidden: bool = False
    name: str | None = None
    updated_at: datetime = Field(default_factory=utc_now)


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
    move_unfinished: bool = True
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


class SlaSettings(BaseModel):
    """How long an open issue of each priority may go before it breaches, one row per team.

    Off until a team turns it on. A priority whose hours are `None` has no rule,
    so an issue of that priority carries no SLA.
    """

    workspace_id: str
    config_key: str
    team_id: str
    kind: str = SLA_SETTINGS
    enabled: bool = False
    urgent_hours: int | None = DEFAULT_SLA_HOURS["urgent"]
    high_hours: int | None = DEFAULT_SLA_HOURS["high"]
    medium_hours: int | None = DEFAULT_SLA_HOURS["medium"]
    low_hours: int | None = DEFAULT_SLA_HOURS["low"]
    updated_at: datetime | None = None

    def hours_for(self, priority: str) -> int | None:
        """The SLA in hours an issue of `priority` gets, or `None` when no rule applies."""
        if not self.enabled or priority not in SLA_PRIORITIES:
            return None
        hours = getattr(self, f"{priority}_hours")
        return int(hours) if hours else None


def default_sla_settings(workspace_id: str, team_id: str) -> SlaSettings:
    """The SLA settings a team that never saved them reads as."""
    return SlaSettings(workspace_id=workspace_id, config_key=sla_settings_key(team_id), team_id=team_id)


class AutoCloseSettings(BaseModel):
    """After how many months without an update a team's backlog and triage issues close, one row per team.

    Off until a team picks a period, unlike auto-archive, because closing an
    open issue is a decision a team should opt into. `status_id` names the
    cancelled status they move to; `None`, or one since deleted, means the
    team's first visible cancelled status.
    """

    workspace_id: str
    config_key: str
    team_id: str
    kind: str = AUTO_CLOSE_SETTINGS
    period_months: int | None = None
    status_id: str | None = None
    updated_at: datetime | None = None


def default_auto_close_settings(workspace_id: str, team_id: str) -> AutoCloseSettings:
    """The auto-close setting a team that never chose one reads as: off."""
    return AutoCloseSettings(workspace_id=workspace_id, config_key=auto_close_settings_key(team_id), team_id=team_id)


class TriageSettings(BaseModel):
    """Whether a team routes issues filed by people outside it into its triage inbox.

    Off until a team turns it on, so a team that never saved the row behaves as
    it always has.
    """

    workspace_id: str
    config_key: str
    team_id: str
    kind: str = TRIAGE_SETTINGS
    enabled: bool = False
    updated_at: datetime | None = None


def default_triage_settings(workspace_id: str, team_id: str) -> TriageSettings:
    """The triage setting a team that never chose one reads as."""
    return TriageSettings(workspace_id=workspace_id, config_key=triage_settings_key(team_id), team_id=team_id)


class ArchiveTarget(BaseModel):
    """One team the archive sweep visits: its finished statuses and its period."""

    workspace_id: str
    team_id: str
    status_ids: list[str] = Field(default_factory=list)
    period_months: int = DEFAULT_ARCHIVE_PERIOD_MONTHS


def _stored(item: dict[str, Any]) -> dict[str, Any]:
    """A status or label item without its read-time fields, and without a team on a workspace row."""
    for name in EFFECTIVE_FIELDS:
        item.pop(name, None)
    if str(item.get("config_key", "")).startswith("workspace#") or not item.get("team_id"):
        item.pop("team_id", None)
    return item


def _status_item(status: Status) -> dict[str, Any]:
    """A status as a stored item, leaving out an unset color or icon rather than storing null."""
    item = _stored(as_item(status))
    for name in STATUS_APPEARANCE_FIELDS:
        if item.get(name) is None:
            item.pop(name, None)
    return item


LABEL_GROUP_FIELDS: tuple[str, ...] = ("is_group", "parent_id")
"""The label fields left off a row when unset, so an ungrouped label stores what it always did."""


def _label_item(label: Label) -> dict[str, Any]:
    """A label as a stored item, leaving out a false `is_group` and an unset `parent_id`."""
    item = _stored(as_item(label))
    for name in LABEL_GROUP_FIELDS:
        if not item.get(name):
            item.pop(name, None)
    return item


def _hide_children_of_hidden_groups(rows: list[Label]) -> list[Label]:
    """The labels with every child of a hidden group read as hidden too."""
    hidden_groups = {row.label_id for row in rows if row.is_group and row.hidden}
    if not hidden_groups:
        return rows
    return [
        row.model_copy(update={"hidden": True}) if row.parent_id in hidden_groups and not row.hidden else row
        for row in rows
    ]


def _override_item(override: Override) -> dict[str, Any]:
    """An override as a stored item, leaving out an unset name."""
    item = as_item(override)
    if item.get("name") is None:
        item.pop("name", None)
    return item


def _inherit(row: Any, team_id: str, override: Override | None) -> Any:
    """A workspace status or label as one team sees it, with the team's override applied."""
    update: dict[str, Any] = {"team_id": team_id, "scope": WORKSPACE_SCOPE}
    if override is not None:
        update["hidden"] = override.hidden
        if override.name:
            update["inherited_name"] = row.name
            update["name"] = override.name
    return row.model_copy(update=update)


def status_order(row: Status) -> tuple[bool, int, str]:
    """A status's place in a team's list: visible first, then by position."""
    return (row.hidden, row.position, row.status_id)


def label_order(row: Label) -> tuple[bool, str, str]:
    """A label's place in a team's list: visible first, then by name."""
    return (row.hidden, row.name.lower(), row.label_id)


STATUS_APPEARANCE_FIELDS: tuple[str, ...] = ("color", "icon")
"""The status fields a patch may clear, which are removed from the row rather than nulled."""


STANDUP_SETTINGS = "standup_settings"
"""The `kind` of a team's standup digest settings row."""

STANDUP_NOTE = "standup_note"
"""The `kind` of one member's standup note row."""

StandupCadence = Literal["off", "daily", "weekly"]

STANDUP_CADENCES: tuple[str, ...] = ("off", "daily", "weekly")

DEFAULT_STANDUP_SEND_TIME = "09:00"

DEFAULT_STANDUP_TIMEZONE = "UTC"

DEFAULT_STANDUP_WEEKDAY = 0


def standup_prefix(team_id: str) -> str:
    """The sort key prefix every standup row of one team shares."""
    return f"team#{team_id}#standup#"


def standup_settings_key(team_id: str) -> str:
    """The sort key of one team's standup digest settings row."""
    return f"{standup_prefix(team_id)}settings"


def standup_note_prefix(team_id: str, date: str) -> str:
    """The sort key prefix of one team's standup notes for one digest date."""
    return f"{standup_prefix(team_id)}note#{date}#"


def standup_note_key(team_id: str, date: str, user_id: str) -> str:
    """The sort key of one member's standup note for one digest date."""
    return f"{standup_note_prefix(team_id, date)}{user_id}"


class StandupSettings(BaseModel):
    """When a team's standup digest is cut, one row per team.

    `send_time` is a local `HH:MM` in `timezone`, which is also where each
    digest window starts and ends. `weekday` is the day a weekly digest goes
    out, Monday as 0. A team that never saved settings reads as the defaults
    with the digest off; the page still renders any day on demand.
    """

    workspace_id: str
    config_key: str
    team_id: str
    kind: str = STANDUP_SETTINGS
    cadence: str = "off"
    send_time: str = DEFAULT_STANDUP_SEND_TIME
    timezone: str = DEFAULT_STANDUP_TIMEZONE
    weekday: int = DEFAULT_STANDUP_WEEKDAY
    updated_at: datetime | None = None


def default_standup_settings(workspace_id: str, team_id: str) -> StandupSettings:
    """The standup settings a team that never configured them reads as."""
    return StandupSettings(workspace_id=workspace_id, config_key=standup_settings_key(team_id), team_id=team_id)


class StandupNote(BaseModel):
    """One member's free text note for one team's digest of one date."""

    workspace_id: str
    config_key: str
    team_id: str
    kind: str = STANDUP_NOTE
    date: str
    user_id: str
    body: str
    updated_at: datetime = Field(default_factory=utc_now)


class StandupRows:
    """The standup reads and writes of `TeamConfigRepository`, kept in one place."""

    _repository: Repository

    def get_standup_settings(self, workspace_id: str, team_id: str) -> StandupSettings | None:
        """One team's stored standup settings, or `None` when it never saved any."""
        if not workspace_id or not team_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "config_key": standup_settings_key(team_id)})
        return StandupSettings.model_validate(dict(item)) if item is not None else None

    def put_standup_settings(self, settings: StandupSettings) -> StandupSettings:
        """Store one team's standup settings whole, stamped with the time of the write."""
        stored = settings.model_copy(update={"updated_at": utc_now()})
        self._repository.put(as_item(stored))
        return stored

    def list_standup_notes(self, workspace_id: str, team_id: str, date: str, *, limit: int = 500) -> list[StandupNote]:
        """Every member's note for one team's digest of one date."""
        if not workspace_id or not team_id or not date:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("config_key").begins_with(standup_note_prefix(team_id, date)),
            max_items=limit,
        )
        return [StandupNote.model_validate(dict(item)) for item in items]

    def put_standup_note(self, workspace_id: str, team_id: str, date: str, user_id: str, body: str) -> StandupNote:
        """Store one member's note for one digest date, replacing any earlier one."""
        note = StandupNote(
            workspace_id=workspace_id,
            config_key=standup_note_key(team_id, date, user_id),
            team_id=team_id,
            date=date,
            user_id=user_id,
            body=body,
        )
        self._repository.put(as_item(note))
        return note

    def delete_standup_note(self, workspace_id: str, team_id: str, date: str, user_id: str) -> bool:
        """Remove one member's note for one digest date, reporting whether one was there."""
        key = {"workspace_id": workspace_id, "config_key": standup_note_key(team_id, date, user_id)}
        if self._repository.get(key) is None:
            return False
        self._repository.delete(key)
        return True


class TeamConfigRepository(StandupRows):
    """Reads and writes `team_config` rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(TEAM_CONFIG, repository)

    def delete_workspace_rows(self, workspace_id: str) -> int:
        """Delete every row this table holds for one workspace, for the workspace purge."""
        return delete_partition(self._repository, TEAM_CONFIG, workspace_id)

    def get_status(self, workspace_id: str, team_id: str, status_id: str) -> Status | None:
        """One status as a team sees it, its own or an inherited one, hidden included, or `None`."""
        if not workspace_id or not team_id or not status_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "config_key": status_key(team_id, status_id)})
        if item is not None:
            return Status.model_validate(dict(item))
        inherited = self.get_workspace_status(workspace_id, status_id)
        if inherited is None:
            return None
        return _inherit(inherited, team_id, self.get_override(workspace_id, team_id, "status", status_id))

    def get_label(self, workspace_id: str, team_id: str, label_id: str) -> Label | None:
        """One label as a team sees it, its own or an inherited one, hidden included, or `None`."""
        if not workspace_id or not team_id or not label_id:
            return None
        found = self._own_or_inherited_label(workspace_id, team_id, label_id)
        if found is None or found.hidden or not found.parent_id:
            return found
        group = self._own_or_inherited_label(workspace_id, team_id, found.parent_id)
        return found.model_copy(update={"hidden": True}) if group is not None and group.hidden else found

    def _own_or_inherited_label(self, workspace_id: str, team_id: str, label_id: str) -> Label | None:
        """One label of a team or one it inherits with the team's override, without its group's hiding."""
        item = self._repository.get({"workspace_id": workspace_id, "config_key": label_key(team_id, label_id)})
        if item is not None:
            return Label.model_validate(dict(item))
        inherited = self.get_workspace_label(workspace_id, label_id)
        if inherited is None:
            return None
        return _inherit(inherited, team_id, self.get_override(workspace_id, team_id, "label", label_id))

    def get_workspace_status(self, workspace_id: str, status_id: str) -> Status | None:
        """One workspace status as stored, or `None`."""
        if not workspace_id or not status_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "config_key": workspace_status_key(status_id)})
        return Status.model_validate({**item, "scope": WORKSPACE_SCOPE}) if item is not None else None

    def get_workspace_label(self, workspace_id: str, label_id: str) -> Label | None:
        """One workspace label as stored, or `None`."""
        if not workspace_id or not label_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "config_key": workspace_label_key(label_id)})
        return Label.model_validate({**item, "scope": WORKSPACE_SCOPE}) if item is not None else None

    def list_workspace_statuses(self, workspace_id: str, *, limit: int = 200) -> list[Status]:
        """Every workspace status, by position."""
        items = self._query(workspace_id, WORKSPACE_STATUS_PREFIX, limit)
        rows = [Status.model_validate({**item, "scope": WORKSPACE_SCOPE}) for item in items]
        return sorted(rows, key=status_order)

    def list_workspace_labels(self, workspace_id: str, *, limit: int = 200) -> list[Label]:
        """Every workspace label, by name."""
        items = self._query(workspace_id, WORKSPACE_LABEL_PREFIX, limit)
        rows = [Label.model_validate({**item, "scope": WORKSPACE_SCOPE}) for item in items]
        return sorted(rows, key=label_order)

    def get_override(self, workspace_id: str, team_id: str, target: str, target_id: str) -> Override | None:
        """One team's override of one workspace status or label, or `None`."""
        if not workspace_id or not team_id or not target_id:
            return None
        item = self._repository.get(
            {"workspace_id": workspace_id, "config_key": override_key(team_id, target, target_id)}
        )
        return Override.model_validate(dict(item)) if item is not None else None

    def list_overrides(self, workspace_id: str, team_id: str, target: str, *, limit: int = 500) -> list[Override]:
        """Every override one team holds of one target kind."""
        items = self._query(workspace_id, override_prefix(team_id, target), limit)
        return [Override.model_validate(dict(item)) for item in items]

    def put_override(self, override: Override) -> Override:
        """Store one override whole, stamped with the time of the write."""
        stored = override.model_copy(update={"updated_at": utc_now()})
        self._repository.put(_override_item(stored))
        return stored

    def delete_override(self, workspace_id: str, team_id: str, target: str, target_id: str) -> bool:
        """Remove one override, reporting whether one was there."""
        if self.get_override(workspace_id, team_id, target, target_id) is None:
            return False
        self._repository.delete({"workspace_id": workspace_id, "config_key": override_key(team_id, target, target_id)})
        return True

    def delete_overrides_of(self, workspace_id: str, team_ids: Iterable[str], target: str, target_id: str) -> int:
        """Remove every named team's override of one workspace status or label."""
        keys = [
            {"workspace_id": workspace_id, "config_key": override_key(team_id, target, target_id)}
            for team_id in dict.fromkeys(team_ids)
        ]
        return self._repository.delete_many(keys) if keys else 0

    def create_status(self, status: Status) -> Status:
        """Store one status, raising `ConditionFailed` on a key collision."""
        self._create(status.workspace_id, status.config_key, _status_item(status))
        return status

    def create_label(self, label: Label) -> Label:
        """Store one label, raising `ConditionFailed` on a key collision."""
        self._create(label.workspace_id, label.config_key, _label_item(label))
        return label

    def _create(self, workspace_id: str, config_key: str, item: dict[str, Any]) -> None:
        """Write one config row only when the sort key is free."""
        self._repository.put(item, condition=Attr("config_key").not_exists())

    def default_statuses(
        self, workspace_id: str, team_id: str, *, categories: Iterable[str] = STATUS_CATEGORIES
    ) -> list[Status]:
        """The default status set for a new team, limited to `categories`, built but not written.

        Separated from writing them so the same rows can go into a transaction
        with the team row rather than following it as a second write.
        """
        wanted = set(categories)
        statuses: list[Status] = []
        for name, category, position in DEFAULT_STATUSES:
            if category not in wanted:
                continue
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

    def default_workspace_statuses(
        self, workspace_id: str, *, categories: Iterable[str] = STATUS_CATEGORIES
    ) -> list[Status]:
        """The default workspace status set, limited to `categories`, built but not written."""
        wanted = set(categories)
        statuses: list[Status] = []
        for name, category, position in DEFAULT_STATUSES:
            if category not in wanted:
                continue
            status_id = new_config_id()
            statuses.append(
                Status(
                    workspace_id=workspace_id,
                    config_key=workspace_status_key(status_id),
                    status_id=status_id,
                    name=name,
                    category=category,
                    position=position,
                    scope=WORKSPACE_SCOPE,
                )
            )
        return statuses

    def create_status_action(self, status: Status) -> dict[str, Any]:
        """A transaction Put for one status, holding the same key-free condition."""
        return self._repository.put_action(_status_item(status), condition=Attr("config_key").not_exists())

    def seed_statuses(self, workspace_id: str, team_id: str) -> list[Status]:
        """Write the default status set for a new team, in contract order."""
        return [self.create_status(status) for status in self.default_statuses(workspace_id, team_id)]

    def list_statuses(
        self, workspace_id: str, team_id: str, *, include_hidden: bool = True, limit: int = 200
    ) -> list[Status]:
        """A team's effective statuses: its own plus the inherited ones with its overrides applied.

        Hidden statuses come last, so a pick of the first status of a category
        lands on a visible one, and are left out when `include_hidden` is false.
        """
        own = [Status.model_validate(dict(item)) for item in self._query(workspace_id, status_prefix(team_id), limit)]
        inherited = self._query(workspace_id, WORKSPACE_STATUS_PREFIX, limit) if team_id else []
        overrides = (
            {row.target_id: row for row in self.list_overrides(workspace_id, team_id, "status")} if inherited else {}
        )
        rows = own + [
            _inherit(Status.model_validate(dict(item)), team_id, overrides.get(str(item["status_id"])))
            for item in inherited
        ]
        return sorted((row for row in rows if include_hidden or not row.hidden), key=status_order)

    def list_labels(
        self, workspace_id: str, team_id: str, *, include_hidden: bool = True, limit: int = 200
    ) -> list[Label]:
        """A team's effective labels: its own plus the inherited ones with its overrides applied, by name."""
        own = [Label.model_validate(dict(item)) for item in self._query(workspace_id, label_prefix(team_id), limit)]
        inherited = self._query(workspace_id, WORKSPACE_LABEL_PREFIX, limit) if team_id else []
        overrides = (
            {row.target_id: row for row in self.list_overrides(workspace_id, team_id, "label")} if inherited else {}
        )
        rows = _hide_children_of_hidden_groups(
            own
            + [
                _inherit(Label.model_validate(dict(item)), team_id, overrides.get(str(item["label_id"])))
                for item in inherited
            ]
        )
        return sorted((row for row in rows if include_hidden or not row.hidden), key=label_order)

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
        """Apply `attributes` to one team status and remove the `clear` ones, or `None` when it does not exist."""
        item = self._patch(workspace_id, status_key(team_id, status_id), attributes, clear, Attr("team_id").exists())
        return Status.model_validate(dict(item)) if item is not None else None

    def update_workspace_status(
        self, workspace_id: str, status_id: str, *, clear: Sequence[str] = (), **attributes: Any
    ) -> Status | None:
        """Apply `attributes` to one workspace status and remove the `clear` ones, or `None` when it does not exist."""
        item = self._patch(workspace_id, workspace_status_key(status_id), attributes, clear, Attr("status_id").exists())
        return Status.model_validate({**item, "scope": WORKSPACE_SCOPE}) if item is not None else None

    def _patch(
        self,
        workspace_id: str,
        config_key: str,
        attributes: Mapping[str, Any],
        clear: Sequence[str],
        condition: Any,
    ) -> Mapping[str, Any] | None:
        """Set and remove attributes of one existing config row, or `None` when it does not exist."""
        if not clear:
            return self._update(workspace_id, config_key, attributes, condition)
        values = {name: value for name, value in attributes.items() if value is not None}
        names = {f"#set{index}": name for index, name in enumerate(values)}
        names.update({f"#rm{index}": name for index, name in enumerate(clear)})
        expression = "REMOVE " + ", ".join(f"#rm{index}" for index in range(len(clear)))
        if values:
            assignments = ", ".join(f"#set{index} = :set{index}" for index in range(len(values)))
            expression = f"SET {assignments} {expression}"
        try:
            return self._repository.update(
                {"workspace_id": workspace_id, "config_key": config_key},
                update_expression=expression,
                expression_values={f":set{index}": value for index, value in enumerate(values.values())} or None,
                expression_names=names,
                condition=condition,
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None

    def update_label(
        self, workspace_id: str, team_id: str, label_id: str, *, clear: Sequence[str] = (), **attributes: Any
    ) -> Label | None:
        """Apply `attributes` to one team label and remove the `clear` ones, or `None` when it does not exist."""
        item = self._patch(workspace_id, label_key(team_id, label_id), attributes, clear, Attr("team_id").exists())
        return Label.model_validate(dict(item)) if item is not None else None

    def update_workspace_label(
        self, workspace_id: str, label_id: str, *, clear: Sequence[str] = (), **attributes: Any
    ) -> Label | None:
        """Apply `attributes` to one workspace label and remove the `clear` ones, or `None` when it does not exist."""
        item = self._patch(workspace_id, workspace_label_key(label_id), attributes, clear, Attr("label_id").exists())
        return Label.model_validate({**item, "scope": WORKSPACE_SCOPE}) if item is not None else None

    def _update(
        self, workspace_id: str, config_key: str, attributes: Mapping[str, Any], condition: Any = None
    ) -> Mapping[str, Any] | None:
        """Apply attributes to one config row, or read it back when none were given."""
        values = {name: value for name, value in attributes.items() if value is not None}
        key = {"workspace_id": workspace_id, "config_key": config_key}
        if not values:
            return self._repository.get(key)
        try:
            return self._repository.set_attributes(
                key, values, condition=condition if condition is not None else Attr("team_id").exists()
            )
        except ConditionFailed:
            return None

    def delete_status(self, workspace_id: str, team_id: str, status_id: str) -> bool:
        """Remove one team status, reporting whether one was there."""
        key = {"workspace_id": workspace_id, "config_key": status_key(team_id, status_id)}
        if self._repository.get(key) is None:
            return False
        self._repository.delete(key)
        return True

    def delete_label(self, workspace_id: str, team_id: str, label_id: str) -> bool:
        """Remove one team label, reporting whether one was there."""
        key = {"workspace_id": workspace_id, "config_key": label_key(team_id, label_id)}
        if self._repository.get(key) is None:
            return False
        self._repository.delete(key)
        return True

    def delete_workspace_status(self, workspace_id: str, status_id: str) -> bool:
        """Remove one workspace status, reporting whether one was there."""
        if self.get_workspace_status(workspace_id, status_id) is None:
            return False
        self._repository.delete({"workspace_id": workspace_id, "config_key": workspace_status_key(status_id)})
        return True

    def delete_workspace_label(self, workspace_id: str, label_id: str) -> bool:
        """Remove one workspace label, reporting whether one was there."""
        if self.get_workspace_label(workspace_id, label_id) is None:
            return False
        self._repository.delete({"workspace_id": workspace_id, "config_key": workspace_label_key(label_id)})
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
        items = self._repository.iter_scan(
            filter_expression=Attr("kind").eq(CYCLE_SETTINGS) & Attr("enabled").eq(True),
            page_size=page_size,
        )
        found = [CycleSettings.model_validate(dict(item)) for item in items]
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

    def get_sla_settings(self, workspace_id: str, team_id: str) -> SlaSettings | None:
        """One team's stored SLA settings, or `None` when it never saved them."""
        if not workspace_id or not team_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "config_key": sla_settings_key(team_id)})
        return SlaSettings.model_validate(dict(item)) if item is not None else None

    def put_sla_settings(self, settings: SlaSettings) -> SlaSettings:
        """Store one team's SLA settings whole, stamped with the time of the write."""
        stored = settings.model_copy(update={"updated_at": utc_now()})
        self._repository.put(as_item(stored))
        return stored

    def get_auto_close_settings(self, workspace_id: str, team_id: str) -> AutoCloseSettings | None:
        """One team's stored auto-close setting, or `None` when it never saved one."""
        if not workspace_id or not team_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "config_key": auto_close_settings_key(team_id)})
        return AutoCloseSettings.model_validate(dict(item)) if item is not None else None

    def put_auto_close_settings(self, settings: AutoCloseSettings) -> AutoCloseSettings:
        """Store one team's auto-close setting whole, stamped with the time of the write."""
        stored = settings.model_copy(update={"updated_at": utc_now()})
        self._repository.put(as_item(stored))
        return stored

    def iter_auto_close_settings(self, *, page_size: int = 200) -> list[AutoCloseSettings]:
        """Every team's auto-close setting with a period, across every workspace.

        One filtered scan of this small table, as the cycle and archive jobs do,
        so the sweep visits only the teams that turned auto-close on.
        """
        found: list[AutoCloseSettings] = []
        start_key: Mapping[str, Any] | None = None
        while True:
            page = self._repository.scan(
                filter_expression=Attr("kind").eq(AUTO_CLOSE_SETTINGS) & Attr("period_months").gt(0),
                limit=page_size,
                start_key=dict(start_key) if start_key else None,
            )
            found.extend(AutoCloseSettings.model_validate(dict(item)) for item in page.items)
            start_key = page.last_evaluated_key
            if not start_key:
                return sorted(found, key=lambda row: (row.workspace_id, row.team_id))

    def get_triage_settings(self, workspace_id: str, team_id: str) -> TriageSettings | None:
        """One team's stored triage setting, or `None` when it never saved one."""
        if not workspace_id or not team_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "config_key": triage_settings_key(team_id)})
        return TriageSettings.model_validate(dict(item)) if item is not None else None

    def put_triage_settings(self, settings: TriageSettings) -> TriageSettings:
        """Store one team's triage setting whole, stamped with the time of the write."""
        stored = settings.model_copy(update={"updated_at": utc_now()})
        self._repository.put(as_item(stored))
        return stored

    def triage_team_ids(self, workspace_id: str) -> list[str]:
        """Every team of one workspace with triage on, from one prefix query."""
        return sorted(
            str(item["team_id"])
            for item in self._query(workspace_id, TRIAGE_PREFIX, 1000)
            if item.get("enabled") and item.get("team_id")
        )

    def iter_archive_targets(
        self, *, teams_of: Callable[[str], Iterable[str]] | None = None, page_size: int = 200
    ) -> list[ArchiveTarget]:
        """Every team with a finished status, with its archive period, across every workspace.

        One filtered scan of this small table picks up both the finished statuses
        and the settings rows, the same cost profile as the cycle job's scan, so
        the sweep never has to enumerate teams or issues to find its work. A team
        with only a settings row and no finished status has nothing to archive
        and is left out. A finished workspace status belongs to every team of its
        workspace, which `teams_of` names; without it those rows are skipped.
        """
        targets: dict[tuple[str, str], ArchiveTarget] = {}
        inherited: dict[str, list[str]] = {}
        items = self._repository.iter_scan(
            filter_expression=Attr("category").is_in(list(FINISHED_CATEGORIES)) | Attr("kind").eq(ARCHIVE_SETTINGS),
            page_size=page_size,
        )
        for item in items:
            workspace_id = str(item["workspace_id"])
            if not item.get("team_id"):
                if item.get("status_id"):
                    inherited.setdefault(workspace_id, []).append(str(item["status_id"]))
                continue
            team_id = str(item["team_id"])
            target = targets.setdefault(
                (workspace_id, team_id), ArchiveTarget(workspace_id=workspace_id, team_id=team_id)
            )
            if item.get("kind") == ARCHIVE_SETTINGS:
                target.period_months = int(item.get("period_months", DEFAULT_ARCHIVE_PERIOD_MONTHS))
            elif item.get("status_id"):
                target.status_ids.append(str(item["status_id"]))
        for workspace_id, status_ids in inherited.items():
            for team_id in teams_of(workspace_id) if teams_of is not None else ():
                target = targets.setdefault(
                    (workspace_id, team_id), ArchiveTarget(workspace_id=workspace_id, team_id=team_id)
                )
                target.status_ids.extend(sorted(status_ids))
        return sorted(
            (target for target in targets.values() if target.status_ids),
            key=lambda row: (row.workspace_id, row.team_id),
        )

    def delete_for_team(self, workspace_id: str, team_id: str, *, batch: int = 100) -> int:
        """Remove every status, label, override, transition, standup row and setting of one team.

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
        if self.get_triage_settings(workspace_id, team_id) is not None:
            self._repository.delete({"workspace_id": workspace_id, "config_key": triage_settings_key(team_id)})
            removed += 1
        if self.get_sla_settings(workspace_id, team_id) is not None:
            self._repository.delete({"workspace_id": workspace_id, "config_key": sla_settings_key(team_id)})
            removed += 1
        if self.get_auto_close_settings(workspace_id, team_id) is not None:
            self._repository.delete({"workspace_id": workspace_id, "config_key": auto_close_settings_key(team_id)})
            removed += 1
        for prefix in (
            status_prefix(team_id),
            label_prefix(team_id),
            override_prefix(team_id),
            transition_prefix(team_id),
            standup_prefix(team_id),
        ):
            while True:
                items = self._query(workspace_id, prefix, batch)
                if not items:
                    break
                removed += self._repository.delete_many(
                    [{"workspace_id": workspace_id, "config_key": item["config_key"]} for item in items]
                )
        return removed
