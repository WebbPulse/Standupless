"""The `planning` table: a team's cycles and the workspace's projects, in one partition.

Both entities share the workspace partition and are told apart by their sort key
prefix. A cycle is filed under its team, so "this team's cycles" is one query. A
project spans one or more teams, so it is filed under the workspace alone and
"the workspace's projects" is one query; its teams are an attribute of the row.

Neither entity is ever written by the rollup path in the way a counter is. A
cycle's counters move through an atomic `ADD`, because a record arriving on one
shard must not lose a count to a read-modify-write racing another. A project's and
a milestone's counters are recounted from the issues and written with a targeted
`SET`. An edit of any of these rows never writes the counters back, so a patch
racing the consumer cannot restore a count the consumer already moved.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field, TypeAdapter
from webbpulse.dynamodb import ConditionFailed, Page, Repository, new_ulid

from app.common.db.dynamo.base import build_repository, delete_partition, utc_now
from app.common.db.dynamo.tables import PLANNING

TARGET_DATE_INDEX = "ws_team-target_date-index"

_DATETIME: TypeAdapter[datetime] = TypeAdapter(datetime)

CYCLE = "cycle"

PROJECT = "project"

ProjectStatus = Literal["backlog", "planned", "in_progress", "paused", "completed", "canceled"]

PROJECT_STATUSES: tuple[str, ...] = ("backlog", "planned", "in_progress", "paused", "completed", "canceled")

LEGACY_PROJECT_STATUSES: dict[str, str] = {"done": "completed"}
"""Earlier project status names and the status each now reads as.

Kept so a row written before the Linear-shaped statuses, and a client still
sending the old name, land on the status that means the same thing.
"""

PROJECT_KEY_PREFIX = "project#"

MILESTONE = "milestone"

MILESTONE_KEY_PREFIX = "milestone#"

PROJECT_UPDATE = "project_update"

PROJECT_UPDATE_KEY_PREFIX = "project_update#"

INITIATIVE = "initiative"

INITIATIVE_KEY_PREFIX = "initiative#"

INITIATIVE_UPDATE = "initiative_update"

INITIATIVE_UPDATE_KEY_PREFIX = "initiative_update#"

InitiativeStatus = Literal["planned", "active", "completed"]

INITIATIVE_STATUSES: tuple[str, ...] = ("planned", "active", "completed")

CycleStatus = Literal["upcoming", "active", "completed", "cancelled"]

CYCLE_STATUSES: tuple[str, ...] = ("upcoming", "active", "completed", "cancelled")

COUNT_BUCKETS: tuple[str, ...] = ("todo", "in_progress", "done", "cancelled")
"""The four buckets a rollup counts into, folded from the team's five categories.

Named here rather than in the consumer because both the consumer that writes them
and the reader that clamps them have to agree on the set, and a bucket added on one
side alone would silently stop being counted.
"""

CATEGORY_BUCKETS: dict[str, str] = {
    "backlog": "todo",
    "unstarted": "todo",
    "started": "in_progress",
    "completed": "done",
    "cancelled": "cancelled",
}
"""Which bucket each M1 status category folds into.

`backlog` and `unstarted` are both "not started yet" to a planning reader, which is
what makes four buckets enough for a cycle bar without losing the distinction the
board still draws from the categories themselves.
"""


POINT_PREFIX = "points_"
"""What an estimate-weighted bucket is stored under, beside its issue count.

Kept in the same `counts` map as the issue counts so one atomic `ADD` moves both,
and so a legacy row, which already carries the map, needs no migration.
"""

POINT_BUCKETS: tuple[str, ...] = tuple(f"{POINT_PREFIX}{bucket}" for bucket in COUNT_BUCKETS)
"""The estimate point buckets a cycle's rollup counts into."""

UNESTIMATED_PREFIX = "unestimated_"
"""What the count of a cycle's unestimated issues in one bucket is stored under.

Counted beside the points rather than folded into them, so a team turning on
"count unestimated issues" reads them as one point each at once and turning it off
again leaves no stray points behind in an incrementally moved counter.
"""

UNESTIMATED_BUCKETS: tuple[str, ...] = tuple(f"{UNESTIMATED_PREFIX}{bucket}" for bucket in COUNT_BUCKETS)
"""The unestimated issue buckets a cycle's rollup counts into."""

CARRY_COUNTERS: tuple[str, ...] = (
    "carried_in",
    "carried_out",
    "carried_in_points",
    "carried_out_points",
    "carried_in_unestimated",
    "carried_out_unestimated",
)
"""How many issues, how many points and how many unestimated issues a cycle close moved into or out of a cycle."""

CARRIED_ID_ATTRIBUTES: tuple[str, ...] = ("carried_out_issue_ids", "carried_in_issue_ids")
"""The cycle attributes naming the issues a close rolled out of and into it."""

COUNTER_KEYS: frozenset[str] = frozenset(COUNT_BUCKETS + POINT_BUCKETS + UNESTIMATED_BUCKETS + CARRY_COUNTERS)
"""Every key a rollup may move inside a planning row's `counts` map."""

CYCLE_HISTORY = "cycle_history"
"""The kind of one daily scope snapshot of a cycle."""


def new_planning_id() -> str:
    """A fresh cycle or project id, time sortable so a listing reads in creation order."""
    return new_ulid()


def cycle_key(team_id: str, cycle_id: str) -> str:
    """The sort key of one cycle."""
    return f"team#{team_id}#cycle#{cycle_id}"


def project_key(project_id: str) -> str:
    """The sort key of one project, filed under the workspace rather than a team."""
    return f"{PROJECT_KEY_PREFIX}{project_id}"


def milestone_prefix(project_id: str) -> str:
    """The sort key prefix every milestone of one project shares.

    Filed under its own `milestone#` prefix rather than under the project's key,
    so the workspace's project listing never reads a milestone row.
    """
    return f"{MILESTONE_KEY_PREFIX}{project_id}#"


def milestone_key(project_id: str, milestone_id: str) -> str:
    """The sort key of one project milestone."""
    return f"{milestone_prefix(project_id)}{milestone_id}"


def project_update_prefix(project_id: str) -> str:
    """The sort key prefix every update of one project shares.

    Its own `project_update#` prefix, which `begins_with("project#")` never
    matches, so the workspace's project listing never reads an update row.
    """
    return f"{PROJECT_UPDATE_KEY_PREFIX}{project_id}#"


def project_update_key(project_id: str, update_id: str) -> str:
    """The sort key of one project update, time sortable by its ULID."""
    return f"{project_update_prefix(project_id)}{update_id}"


def initiative_key(initiative_id: str) -> str:
    """The sort key of one initiative, filed under the workspace like a project."""
    return f"{INITIATIVE_KEY_PREFIX}{initiative_id}"


def initiative_update_prefix(initiative_id: str) -> str:
    """The sort key prefix every update of one initiative shares.

    `begins_with("initiative#")` never matches it, so the initiative listing
    never reads an update row.
    """
    return f"{INITIATIVE_UPDATE_KEY_PREFIX}{initiative_id}#"


def initiative_update_key(initiative_id: str, update_id: str) -> str:
    """The sort key of one initiative update, time sortable by its ULID."""
    return f"{initiative_update_prefix(initiative_id)}{update_id}"


def cycle_prefix(team_id: str) -> str:
    """The sort key prefix every cycle of one team shares."""
    return f"team#{team_id}#cycle#"


def cycle_history_prefix(team_id: str, cycle_id: str | None = None) -> str:
    """The sort key prefix of one cycle's daily snapshots, or of every cycle of a team.

    Filed under `cyclehist#` rather than under the cycle's own key, so a cycle
    listing that reads the `cycle#` prefix never pages through snapshot rows.
    """
    prefix = f"team#{team_id}#cyclehist#"
    return f"{prefix}{cycle_id}#" if cycle_id is not None else prefix


def cycle_history_key(team_id: str, cycle_id: str, day: str) -> str:
    """The sort key of one cycle's snapshot for one day."""
    return f"{cycle_history_prefix(team_id, cycle_id)}{day}"


def parse_cycle_key(planning_key: str) -> tuple[str, str] | None:
    """The team and cycle one cycle sort key names, or `None` for any other row."""
    if not planning_key.startswith("team#"):
        return None
    team_id, marker, cycle_id = planning_key[len("team#") :].partition("#cycle#")
    if not marker or not team_id or not cycle_id or "#" in cycle_id:
        return None
    return team_id, cycle_id


def planning_key_for(kind: str, team_id: str, entity_id: str) -> str:
    """The sort key one planning row takes, from its kind.

    The team is ignored for a project, whose key carries no team because it can
    belong to several.
    """
    if kind == CYCLE:
        return cycle_key(team_id, entity_id)
    return project_key(entity_id)


def normalise_project_status(value: str) -> str:
    """One project status in the current vocabulary, mapping a legacy name."""
    return LEGACY_PROJECT_STATUSES.get(value, value)


def ws_team(workspace_id: str, team_id: str) -> str:
    """The roadmap index's hash key, one partition per team of a workspace.

    Only cycles write it. A project belongs to several teams and so to no one
    partition of this index, which is why the roadmap reads projects from the
    workspace partition instead.
    """
    return f"{workspace_id}#{team_id}"


def derive_cycle_status(start_date: str, end_date: str, cancelled: bool, today: str | None = None) -> str:
    """One cycle's status from its dates and its flag, never stored.

    Deriving is what keeps a cycle from needing a scheduled write to change state at
    midnight: the status a reader sees is always the one the dates imply, and the
    only thing anyone writes is the explicit cancellation.
    """
    if cancelled:
        return "cancelled"
    now = today if today is not None else date.today().isoformat()
    if now < start_date:
        return "upcoming"
    if now > end_date:
        return "completed"
    return "active"


class RollupCounts(BaseModel):
    """How many of a cycle's or a project's issues sit in each bucket.

    Maintained by the stream consumer rather than the request path, so nothing here
    ever reads the `issues` table to answer a planning read. Counts are clamped at
    zero on the way out rather than conditionally on the way in, because a refused
    decrement would make a redelivery diverge.
    """

    todo: int = 0
    in_progress: int = 0
    done: int = 0
    cancelled: int = 0

    @property
    def total(self) -> int:
        """Every counted issue, which is what a progress bar divides by."""
        return self.todo + self.in_progress + self.done + self.cancelled

    @property
    def scope(self) -> int:
        """Everything the cycle still intends to finish: every bucket but cancelled."""
        return self.todo + self.in_progress + self.done

    @property
    def started(self) -> int:
        """What has been picked up, finished work included."""
        return self.in_progress + self.done

    def plus(self, other: "RollupCounts") -> "RollupCounts":
        """These counts and another's, bucket by bucket."""
        return RollupCounts(**{bucket: getattr(self, bucket) + getattr(other, bucket) for bucket in COUNT_BUCKETS})

    def as_map(self, prefix: str = "") -> dict[str, int]:
        """The buckets as a `counts` map, each key carrying `prefix`."""
        return {f"{prefix}{bucket}": getattr(self, bucket) for bucket in COUNT_BUCKETS}

    @classmethod
    def from_item(cls, item: Mapping[str, Any], prefix: str = "") -> "RollupCounts":
        """The counters off one stored row, each floored at zero.

        A counter can go negative when a decrement outlives its matching increment,
        which is the price of the atomic `ADD` that keeps two shards from losing a
        count; the floor is applied on read so a reader never sees it. `prefix`
        reads the estimate point buckets that share the same map.
        """
        values = item.get("counts")
        return cls.from_map(values if isinstance(values, Mapping) else {}, prefix)

    @classmethod
    def from_map(cls, source: Mapping[str, Any], prefix: str = "") -> "RollupCounts":
        """The buckets out of one `counts` map, each floored at zero."""
        return cls(**{bucket: max(0, int(source.get(f"{prefix}{bucket}", 0) or 0)) for bucket in COUNT_BUCKETS})


class CarryOver(BaseModel):
    """What cycle closes moved in and out of one cycle, in issues and points."""

    carried_in: int = 0
    carried_out: int = 0
    carried_in_points: int = 0
    carried_out_points: int = 0
    carried_in_unestimated: int = 0
    carried_out_unestimated: int = 0

    def counting_unestimated(self, counted: bool) -> "CarryOver":
        """The carry-over with each unestimated issue read as one point when the team counts them."""
        if not counted:
            return self
        return self.model_copy(
            update={
                "carried_in_points": self.carried_in_points + self.carried_in_unestimated,
                "carried_out_points": self.carried_out_points + self.carried_out_unestimated,
            }
        )

    @classmethod
    def from_item(cls, item: Mapping[str, Any]) -> "CarryOver":
        """The carry counters off one stored row, each floored at zero."""
        values = item.get("counts")
        source: Mapping[str, Any] = values if isinstance(values, Mapping) else {}
        return cls(**{name: max(0, int(source.get(name, 0) or 0)) for name in CARRY_COUNTERS})


class Cycle(BaseModel):
    """One time box of a team: its dates, its goal and its counters.

    `number` is the team's running cycle number, set on the cycles the automatic
    schedule creates and empty on one a planner made by hand. The two id lists
    name the issues a cycle close rolled out of this cycle and into it, stored as
    string sets so the rollup can add to them idempotently.
    """

    workspace_id: str
    planning_key: str
    cycle_id: str = Field(default_factory=new_planning_id)
    team_id: str
    kind: str = CYCLE
    name: str
    start_date: str
    end_date: str
    goal: str | None = None
    number: int | None = None
    cancelled: bool = False
    counts: RollupCounts = Field(default_factory=RollupCounts)
    points: RollupCounts = Field(default_factory=RollupCounts)
    unestimated: RollupCounts = Field(default_factory=RollupCounts)
    carry: CarryOver = Field(default_factory=CarryOver)
    carried_out_issue_ids: list[str] = Field(default_factory=list)
    carried_in_issue_ids: list[str] = Field(default_factory=list)
    rollup_rev: int = 0
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    def status(self, today: str | None = None) -> str:
        """This cycle's derived status, from its dates and its cancellation flag."""
        return derive_cycle_status(self.start_date, self.end_date, self.cancelled, today)

    def counted_points(self, count_unestimated: bool) -> RollupCounts:
        """The cycle's points, each unestimated issue adding one when its team counts them."""
        return self.points.plus(self.unestimated) if count_unestimated else self.points


class Project(BaseModel):
    """One time-bound body of work across one or more teams.

    `team_ids` is ordered and never empty: the first entry is the team a
    single-team reader treats as the project's own. Visibility is decided per
    caller against the whole list, so the row itself stays team agnostic.

    `icon`, `color`, `health`, `priority` and `member_ids` are the Linear project
    properties. Each defaults to empty, so a row stored before they existed reads
    back as an unprioritised project with no health, icon, colour or members.
    `update_interval_days` is the project's own update cadence; None follows the
    workspace default and 0 turns reminders off.
    """

    workspace_id: str
    planning_key: str
    project_id: str = Field(default_factory=new_planning_id)
    team_ids: list[str] = Field(min_length=1)
    kind: str = PROJECT
    name: str
    description: str | None = None
    lead_id: str | None = None
    start_date: str | None = None
    target_date: str | None = None
    status: str = "backlog"
    icon: str | None = None
    color: str | None = None
    health: str | None = None
    priority: str = "none"
    member_ids: list[str] = Field(default_factory=list)
    counts: RollupCounts = Field(default_factory=RollupCounts)
    points: RollupCounts = Field(default_factory=RollupCounts)
    last_update_at: datetime | None = None
    update_interval_days: int | None = None
    initiative_id: str | None = None
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class Initiative(BaseModel):
    """One workspace level goal that groups projects across teams, as in Linear.

    Membership is stored on each project's `initiative_id` rather than here, so a
    project belongs to at most one initiative and removing a project needs no
    second write. `health` and `last_update_at` mirror the newest update, as a
    project's do, and `update_interval_days` follows the same cadence rules.
    """

    workspace_id: str
    planning_key: str
    initiative_id: str = Field(default_factory=new_planning_id)
    kind: str = INITIATIVE
    name: str
    description: str | None = None
    owner_id: str | None = None
    status: str = "planned"
    health: str | None = None
    target_date: str | None = None
    last_update_at: datetime | None = None
    update_interval_days: int | None = None
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class InitiativeUpdateRow(BaseModel):
    """One written status update on an initiative, with the health it reported."""

    workspace_id: str
    planning_key: str
    update_id: str = Field(default_factory=new_planning_id)
    initiative_id: str
    kind: str = INITIATIVE_UPDATE
    body: str
    health: str
    author_id: str
    source: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    edited_at: datetime | None = None


class ProjectUpdateRow(BaseModel):
    """One written status update on a project, with the health it reported.

    The newest update is what the project's `health` and `last_update_at`
    mirror, so a reader of the project row sees the latest report without
    reading the update feed.
    """

    workspace_id: str
    planning_key: str
    update_id: str = Field(default_factory=new_planning_id)
    project_id: str
    kind: str = PROJECT_UPDATE
    body: str
    health: str
    author_id: str
    source: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    edited_at: datetime | None = None


class ProjectMilestone(BaseModel):
    """One ordered stage of a project, with its own target date and counters.

    `sort_order` is a base 62 fractional key, so a reorder rewrites only the row
    that moved. The row carries no `ws_team`, so it stays out of the roadmap index.
    """

    workspace_id: str
    planning_key: str
    milestone_id: str = Field(default_factory=new_planning_id)
    project_id: str
    kind: str = MILESTONE
    name: str
    description: str | None = None
    target_date: str | None = None
    sort_order: str
    counts: RollupCounts = Field(default_factory=RollupCounts)
    points: RollupCounts = Field(default_factory=RollupCounts)
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


def as_cycle_item(cycle: Cycle) -> dict[str, Any]:
    """One cycle as the stored item, carrying its roadmap index attributes.

    The cycle's `end_date` is what the roadmap draws it at, so that is what goes into
    the index's range attribute; a cycle is always dated, so it is always indexed.
    """
    item = cycle.model_dump(mode="json")
    counts = dict(item.pop("counts"))
    counts.update({f"{POINT_PREFIX}{bucket}": value for bucket, value in item.pop("points").items()})
    counts.update({f"{UNESTIMATED_PREFIX}{bucket}": value for bucket, value in item.pop("unestimated").items()})
    counts.update(item.pop("carry"))
    item["counts"] = counts
    for name in CARRIED_ID_ATTRIBUTES:
        ids = item.pop(name, None) or []
        if ids:
            item[name] = set(ids)
    item["ws_team"] = ws_team(cycle.workspace_id, cycle.team_id)
    item["target_date"] = cycle.end_date
    return item


PROJECT_OPTIONAL_FIELDS: tuple[str, ...] = (
    "target_date",
    "start_date",
    "lead_id",
    "description",
    "icon",
    "color",
    "health",
    "last_update_at",
    "update_interval_days",
    "initiative_id",
)
"""The project attributes a null value removes from the row rather than storing."""

INITIATIVE_OPTIONAL_FIELDS: tuple[str, ...] = (
    "description",
    "owner_id",
    "health",
    "target_date",
    "last_update_at",
    "update_interval_days",
)
"""The initiative attributes a null value removes from the row rather than storing."""

MILESTONE_OPTIONAL_FIELDS: tuple[str, ...] = ("target_date", "description")
"""The milestone attributes a null value removes from the row rather than storing."""

ROLLUP_ATTRIBUTES: frozenset[str] = frozenset({"counts", "rollup_rev"})
"""What only the rollup consumer writes, which an edit of the row leaves alone."""

KEY_ATTRIBUTES: frozenset[str] = frozenset({"workspace_id", "planning_key"})
"""The table's key, which an update names rather than sets."""


def _with_points_in_counts(item: dict[str, Any]) -> dict[str, Any]:
    """One dumped project or milestone with its points moved into the `counts` map, as a cycle stores them."""
    counts = dict(item.get("counts") or {})
    counts.update({f"{POINT_PREFIX}{bucket}": value for bucket, value in (item.pop("points", None) or {}).items()})
    item["counts"] = counts
    return item


def as_project_item(project: Project) -> dict[str, Any]:
    """One project as the stored item, outside the roadmap index.

    No `ws_team` is written, so a project never enters `ws_team-target_date-index`:
    it belongs to several teams and no single team partition could hold it. Null
    optional fields are dropped rather than stored, so a cleared date leaves no
    attribute behind.
    """
    item = _with_points_in_counts(project.model_dump(mode="json"))
    for name in PROJECT_OPTIONAL_FIELDS:
        if item.get(name) is None:
            item.pop(name, None)
    return item


def as_milestone_item(milestone: ProjectMilestone) -> dict[str, Any]:
    """One milestone as the stored item, null optional fields dropped."""
    item = _with_points_in_counts(milestone.model_dump(mode="json"))
    for name in MILESTONE_OPTIONAL_FIELDS:
        if item.get(name) is None:
            item.pop(name, None)
    return item


def _stored_time(value: datetime) -> str:
    """A datetime in the string form a model dump stores, so every row reads alike."""
    return str(_DATETIME.dump_python(value, mode="json"))


def as_project_update_item(update: ProjectUpdateRow) -> dict[str, Any]:
    """One project update as the stored item, an unedited one carrying no `edited_at`."""
    item = update.model_dump(mode="json")
    if item.get("edited_at") is None:
        item.pop("edited_at", None)
    return item


def as_project_update(item: Mapping[str, Any]) -> ProjectUpdateRow:
    """One stored item as a `ProjectUpdateRow`."""
    return ProjectUpdateRow.model_validate(dict(item))


def as_initiative_item(initiative: Initiative) -> dict[str, Any]:
    """One initiative as the stored item, null optional fields dropped."""
    item = initiative.model_dump(mode="json")
    for name in INITIATIVE_OPTIONAL_FIELDS:
        if item.get(name) is None:
            item.pop(name, None)
    return item


def as_initiative(item: Mapping[str, Any]) -> Initiative:
    """One stored item as an `Initiative`."""
    return Initiative.model_validate(dict(item))


def is_initiative(item: Mapping[str, Any]) -> bool:
    """Whether one stored row is an initiative."""
    return str(item.get("kind", "")) == INITIATIVE


def as_initiative_update_item(update: InitiativeUpdateRow) -> dict[str, Any]:
    """One initiative update as the stored item, an unedited one carrying no `edited_at`."""
    item = update.model_dump(mode="json")
    if item.get("edited_at") is None:
        item.pop("edited_at", None)
    return item


def as_initiative_update(item: Mapping[str, Any]) -> InitiativeUpdateRow:
    """One stored item as an `InitiativeUpdateRow`."""
    return InitiativeUpdateRow.model_validate(dict(item))


def is_initiative_update(item: Mapping[str, Any]) -> bool:
    """Whether one stored row is an initiative update."""
    return str(item.get("kind", "")) == INITIATIVE_UPDATE


def is_project_update(item: Mapping[str, Any]) -> bool:
    """Whether one stored row is a project update."""
    return str(item.get("kind", "")) == PROJECT_UPDATE


INDEX_ATTRIBUTE_NAMES: tuple[str, ...] = ("ws_team",)
"""The denormalised composites a read strips back off a stored row.

`target_date` is not stripped: it is a project's own field, and for a cycle it is
recomputed from `end_date` on every write, so reading it back costs nothing.
"""


def as_cycle(item: Mapping[str, Any]) -> Cycle:
    """One stored item as a `Cycle`, ignoring the index composites.

    `target_date` is dropped as well, because on a cycle it is a copy of `end_date`
    that the model does not carry.
    """
    fields = {key: value for key, value in item.items() if key not in INDEX_ATTRIBUTE_NAMES and key != "target_date"}
    fields["counts"] = RollupCounts.from_item(item)
    fields["points"] = RollupCounts.from_item(item, POINT_PREFIX)
    fields["unestimated"] = RollupCounts.from_item(item, UNESTIMATED_PREFIX)
    fields["carry"] = CarryOver.from_item(item)
    for name in CARRIED_ID_ATTRIBUTES:
        fields[name] = sorted(str(value) for value in (item.get(name) or ()))
    return Cycle.model_validate(fields)


def as_project(item: Mapping[str, Any]) -> Project:
    """One stored item as a `Project`, ignoring the index composites.

    A legacy status name is read as its current equivalent, so a row written
    before the status set grew still validates against the response schema.
    """
    fields = {key: value for key, value in item.items() if key not in INDEX_ATTRIBUTE_NAMES}
    fields["counts"] = RollupCounts.from_item(item)
    fields["points"] = RollupCounts.from_item(item, POINT_PREFIX)
    fields["status"] = normalise_project_status(str(item.get("status", "backlog")))
    return Project.model_validate(fields)


def as_milestone(item: Mapping[str, Any]) -> ProjectMilestone:
    """One stored item as a `ProjectMilestone`, its counters floored at zero."""
    fields = {key: value for key, value in item.items() if key not in INDEX_ATTRIBUTE_NAMES}
    fields["counts"] = RollupCounts.from_item(item)
    fields["points"] = RollupCounts.from_item(item, POINT_PREFIX)
    return ProjectMilestone.model_validate(fields)


def is_milestone(item: Mapping[str, Any]) -> bool:
    """Whether one stored row is a project milestone."""
    return str(item.get("kind", "")) == MILESTONE


def milestone_order(milestone: ProjectMilestone) -> tuple[str, str]:
    """The position a milestone reads at: its manual key, then its id."""
    return (milestone.sort_order, milestone.milestone_id)


def is_cycle(item: Mapping[str, Any]) -> bool:
    """Whether one stored row is a cycle rather than a project.

    Read off the row's own `kind` rather than parsed back out of the sort key, so a
    key format change does not silently reclassify every row.
    """
    return str(item.get("kind", "")) == CYCLE


def is_current_project(item: Mapping[str, Any]) -> bool:
    """Whether one row under the project prefix is a project in the current shape.

    The prefix `project#` also matches rows stranded by the team rename, keyed
    `project#<id>#cycle#<id>`, and a project row from before projects spanned teams
    carries no `team_ids`. Neither is readable as a project, so both are skipped.
    """
    return str(item.get("kind", "")) == PROJECT and bool(item.get("team_ids"))


class CycleSnapshot(BaseModel):
    """One cycle's counters as they stood at the end of one day.

    Written by the rollup consumer on every counter move, so the last write of a
    day is the day's closing value. `opening_*` is what the counters held before
    the first move ever recorded for the cycle, which is what the days before the
    first snapshot read as.
    """

    day: str
    rev: int = 0
    counts: RollupCounts = Field(default_factory=RollupCounts)
    points: RollupCounts = Field(default_factory=RollupCounts)
    unestimated: RollupCounts = Field(default_factory=RollupCounts)
    opening_counts: RollupCounts = Field(default_factory=RollupCounts)
    opening_points: RollupCounts = Field(default_factory=RollupCounts)
    opening_unestimated: RollupCounts = Field(default_factory=RollupCounts)

    def counted_points(self, count_unestimated: bool) -> RollupCounts:
        """The day's points, each unestimated issue adding one when its team counts them."""
        return self.points.plus(self.unestimated) if count_unestimated else self.points

    def counted_opening_points(self, count_unestimated: bool) -> RollupCounts:
        """The opening points, each unestimated issue adding one when its team counts them."""
        return self.opening_points.plus(self.opening_unestimated) if count_unestimated else self.opening_points

    @classmethod
    def from_item(cls, item: Mapping[str, Any]) -> "CycleSnapshot":
        """One stored snapshot row, its counters floored at zero."""
        opening = item.get("opening")
        opening_map: Mapping[str, Any] = opening if isinstance(opening, Mapping) else {}
        return cls(
            day=str(item.get("day", "")),
            rev=int(item.get("rev", 0) or 0),
            counts=RollupCounts.from_item(item),
            points=RollupCounts.from_item(item, POINT_PREFIX),
            unestimated=RollupCounts.from_item(item, UNESTIMATED_PREFIX),
            opening_counts=RollupCounts.from_map(opening_map),
            opening_points=RollupCounts.from_map(opening_map, POINT_PREFIX),
            opening_unestimated=RollupCounts.from_map(opening_map, UNESTIMATED_PREFIX),
        )


class PlanningRepository:
    """Reads and writes `planning` rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(PLANNING, repository)

    def delete_workspace_rows(self, workspace_id: str) -> int:
        """Delete every row this table holds for one workspace, for the workspace purge."""
        return delete_partition(self._repository, PLANNING, workspace_id)

    def get_cycle(self, workspace_id: str, team_id: str, cycle_id: str) -> Cycle | None:
        """One cycle of one team, or `None`.

        The team is a parameter rather than something looked up, because the sort
        key carries it: a caller that guesses a cycle id without its team reads
        nothing rather than another team's row.
        """
        item = self._get(workspace_id, cycle_key(team_id, cycle_id))
        if item is None or not is_cycle(item):
            return None
        return as_cycle(item)

    def get_project(self, workspace_id: str, project_id: str) -> Project | None:
        """One project of the workspace, or `None`.

        Whether the caller may see it is the route's decision, made against the
        row's `team_ids`, because the key no longer carries a team to guess.
        """
        item = self._get(workspace_id, project_key(project_id))
        if item is None or not is_current_project(item):
            return None
        return as_project(item)

    def get_milestone(self, workspace_id: str, project_id: str, milestone_id: str) -> ProjectMilestone | None:
        """One milestone of one project, or `None`.

        The project is part of the key, so a milestone id guessed against another
        project reads nothing.
        """
        if not project_id or not milestone_id:
            return None
        item = self._get(workspace_id, milestone_key(project_id, milestone_id))
        if item is None or not is_milestone(item):
            return None
        return as_milestone(item)

    def list_milestones(self, workspace_id: str, project_id: str, *, max_items: int = 500) -> list[ProjectMilestone]:
        """Every milestone of one project, in its manual order."""
        if not workspace_id or not project_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(milestone_prefix(project_id)),
            max_items=max_items,
        )
        rows = [as_milestone(item) for item in items if is_milestone(item)]
        return sorted(rows, key=milestone_order)

    def create_milestone(self, milestone: ProjectMilestone) -> ProjectMilestone:
        """Store a new milestone, raising `ConditionFailed` when the key is taken."""
        self._repository.put(as_milestone_item(milestone), condition=Attr("planning_key").not_exists())
        return milestone

    def replace_milestone(self, milestone: ProjectMilestone) -> ProjectMilestone:
        """Write one milestone's fields over an existing row, its stored counters kept.

        Raises `ConditionFailed` when the row is gone.
        """
        stored = self._replace_fields(as_milestone_item(milestone), MILESTONE_OPTIONAL_FIELDS)
        return as_milestone(stored)

    def delete_project_milestones(self, workspace_id: str, project_id: str, *, limit: int = 100) -> int:
        """Remove every milestone row of one project, returning how many went.

        Paged so a project with many milestones is still removed whole. The
        issues consumer clears the milestone off each issue from the stream.
        """
        if not workspace_id or not project_id:
            return 0
        removed = 0
        while True:
            page = self._query_prefix(workspace_id, milestone_prefix(project_id), limit, None)
            if not page.items:
                return removed
            removed += self._repository.delete_many(
                [{"workspace_id": workspace_id, "planning_key": item["planning_key"]} for item in page.items]
            )

    def get_project_update(self, workspace_id: str, project_id: str, update_id: str) -> ProjectUpdateRow | None:
        """One update of one project, or `None`; the project is part of the key."""
        if not project_id or not update_id:
            return None
        item = self._get(workspace_id, project_update_key(project_id, update_id))
        if item is None or not is_project_update(item):
            return None
        return as_project_update(item)

    def list_project_updates(
        self,
        workspace_id: str,
        project_id: str,
        *,
        limit: int,
        start_key: Mapping[str, Any] | None = None,
    ) -> tuple[list[ProjectUpdateRow], Mapping[str, Any] | None]:
        """One page of a project's updates, newest first, and the key to resume from.

        The ULID in the sort key orders updates by when they were posted, so a
        descending query under the project's prefix is the feed.
        """
        if not workspace_id or not project_id:
            return [], None
        page = self._repository.query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(project_update_prefix(project_id)),
            limit=limit,
            start_key=dict(start_key) if start_key else None,
            ascending=False,
        )
        rows = [as_project_update(item) for item in page.items if is_project_update(item)]
        return rows, page.last_evaluated_key

    def latest_project_update(self, workspace_id: str, project_id: str) -> ProjectUpdateRow | None:
        """The newest update of one project, or `None` when it has none."""
        rows, _ = self.list_project_updates(workspace_id, project_id, limit=1)
        return rows[0] if rows else None

    def create_project_update(self, update: ProjectUpdateRow) -> ProjectUpdateRow:
        """Store a new update, raising `ConditionFailed` when the key is taken."""
        self._repository.put(as_project_update_item(update), condition=Attr("planning_key").not_exists())
        return update

    def replace_project_update(self, update: ProjectUpdateRow) -> ProjectUpdateRow:
        """Write one update over an existing row, raising `ConditionFailed` when it is gone."""
        self._repository.put(as_project_update_item(update), condition=Attr("planning_key").exists())
        return update

    def record_project_health(
        self,
        workspace_id: str,
        project_id: str,
        *,
        health: str | None,
        last_update_at: datetime | None,
    ) -> bool:
        """Mirror the newest update onto its project row, returning whether the row was there.

        A targeted `SET` rather than a whole-item put, so the rollup counters
        the stream consumer moves concurrently are never written back stale. A
        `None` health leaves the project's health as it was, and a `None`
        `last_update_at` removes the attribute, which is what a project whose
        last update was deleted reads as.
        """
        if not workspace_id or not project_id:
            return False
        names: dict[str, str] = {"#updated": "updated_at", "#last": "last_update_at"}
        values: dict[str, Any] = {":updated": _stored_time(utc_now())}
        sets = ["#updated = :updated"]
        removes: list[str] = []
        if health is not None:
            names["#health"] = "health"
            values[":health"] = health
            sets.append("#health = :health")
        if last_update_at is not None:
            values[":last"] = _stored_time(last_update_at)
            sets.append("#last = :last")
        else:
            removes.append("#last")
        expression = "SET " + ", ".join(sets)
        if removes:
            expression += " REMOVE " + ", ".join(removes)
        try:
            self._repository.update(
                {"workspace_id": workspace_id, "planning_key": project_key(project_id)},
                update_expression=expression,
                expression_names=names,
                expression_values=values,
                condition=Attr("planning_key").exists() & Attr("kind").eq(PROJECT),
            )
        except ConditionFailed:
            return False
        return True

    def delete_project_updates(self, workspace_id: str, project_id: str, *, limit: int = 100) -> int:
        """Remove every update row of one project, returning how many went."""
        if not workspace_id or not project_id:
            return 0
        removed = 0
        while True:
            page = self._query_prefix(workspace_id, project_update_prefix(project_id), limit, None)
            if not page.items:
                return removed
            removed += self._repository.delete_many(
                [{"workspace_id": workspace_id, "planning_key": item["planning_key"]} for item in page.items]
            )

    def get_initiative(self, workspace_id: str, initiative_id: str) -> Initiative | None:
        """One initiative of the workspace, or `None`."""
        if not initiative_id:
            return None
        item = self._get(workspace_id, initiative_key(initiative_id))
        if item is None or not is_initiative(item):
            return None
        return as_initiative(item)

    def list_initiatives(self, workspace_id: str, *, max_items: int = 1000) -> list[Initiative]:
        """Every initiative of the workspace, by target date ascending, undated last.

        A bounded set a workspace plans by hand, read whole as projects are.
        """
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(INITIATIVE_KEY_PREFIX),
            max_items=max_items,
        )
        rows = [as_initiative(item) for item in items if is_initiative(item)]
        return sorted(rows, key=lambda row: (row.target_date is None, row.target_date or "", row.initiative_id))

    def create_initiative(self, initiative: Initiative) -> Initiative:
        """Store a new initiative, raising `ConditionFailed` when the key is taken."""
        self._repository.put(as_initiative_item(initiative), condition=Attr("planning_key").not_exists())
        return initiative

    def replace_initiative(self, initiative: Initiative) -> Initiative:
        """Write one initiative's fields over an existing row, raising `ConditionFailed` when it is gone."""
        stored = self._replace_fields(as_initiative_item(initiative), INITIATIVE_OPTIONAL_FIELDS)
        return as_initiative(stored)

    def set_project_initiative(self, workspace_id: str, project_id: str, initiative_id: str | None) -> bool:
        """Put one project in an initiative, or take it out with `None`, returning whether the row was there.

        A targeted `SET` or `REMOVE`, so the rollup counters the stream consumer
        moves concurrently are never written back stale.
        """
        if not workspace_id or not project_id:
            return False
        names = {"#initiative": "initiative_id", "#updated": "updated_at"}
        values: dict[str, Any] = {":updated": _stored_time(utc_now())}
        if initiative_id is None:
            expression = "SET #updated = :updated REMOVE #initiative"
        else:
            values[":initiative"] = initiative_id
            expression = "SET #initiative = :initiative, #updated = :updated"
        try:
            self._repository.update(
                {"workspace_id": workspace_id, "planning_key": project_key(project_id)},
                update_expression=expression,
                expression_names=names,
                expression_values=values,
                condition=Attr("planning_key").exists() & Attr("kind").eq(PROJECT),
            )
        except ConditionFailed:
            return False
        return True

    def get_initiative_update(
        self, workspace_id: str, initiative_id: str, update_id: str
    ) -> InitiativeUpdateRow | None:
        """One update of one initiative, or `None`; the initiative is part of the key."""
        if not initiative_id or not update_id:
            return None
        item = self._get(workspace_id, initiative_update_key(initiative_id, update_id))
        if item is None or not is_initiative_update(item):
            return None
        return as_initiative_update(item)

    def list_initiative_updates(
        self,
        workspace_id: str,
        initiative_id: str,
        *,
        limit: int,
        start_key: Mapping[str, Any] | None = None,
    ) -> tuple[list[InitiativeUpdateRow], Mapping[str, Any] | None]:
        """One page of an initiative's updates, newest first, and the key to resume from."""
        if not workspace_id or not initiative_id:
            return [], None
        page = self._repository.query(
            Key("workspace_id").eq(workspace_id)
            & Key("planning_key").begins_with(initiative_update_prefix(initiative_id)),
            limit=limit,
            start_key=dict(start_key) if start_key else None,
            ascending=False,
        )
        rows = [as_initiative_update(item) for item in page.items if is_initiative_update(item)]
        return rows, page.last_evaluated_key

    def latest_initiative_update(self, workspace_id: str, initiative_id: str) -> InitiativeUpdateRow | None:
        """The newest update of one initiative, or `None` when it has none."""
        rows, _ = self.list_initiative_updates(workspace_id, initiative_id, limit=1)
        return rows[0] if rows else None

    def create_initiative_update(self, update: InitiativeUpdateRow) -> InitiativeUpdateRow:
        """Store a new initiative update, raising `ConditionFailed` when the key is taken."""
        self._repository.put(as_initiative_update_item(update), condition=Attr("planning_key").not_exists())
        return update

    def replace_initiative_update(self, update: InitiativeUpdateRow) -> InitiativeUpdateRow:
        """Write one initiative update over an existing row, raising `ConditionFailed` when it is gone."""
        self._repository.put(as_initiative_update_item(update), condition=Attr("planning_key").exists())
        return update

    def record_initiative_health(
        self,
        workspace_id: str,
        initiative_id: str,
        *,
        health: str | None,
        last_update_at: datetime | None,
    ) -> bool:
        """Mirror the newest update onto its initiative row, returning whether the row was there.

        The same rule a project follows: a `None` health leaves the health as it
        was and a `None` `last_update_at` removes the attribute.
        """
        if not workspace_id or not initiative_id:
            return False
        names: dict[str, str] = {"#updated": "updated_at", "#last": "last_update_at"}
        values: dict[str, Any] = {":updated": _stored_time(utc_now())}
        sets = ["#updated = :updated"]
        removes: list[str] = []
        if health is not None:
            names["#health"] = "health"
            values[":health"] = health
            sets.append("#health = :health")
        if last_update_at is not None:
            values[":last"] = _stored_time(last_update_at)
            sets.append("#last = :last")
        else:
            removes.append("#last")
        expression = "SET " + ", ".join(sets)
        if removes:
            expression += " REMOVE " + ", ".join(removes)
        try:
            self._repository.update(
                {"workspace_id": workspace_id, "planning_key": initiative_key(initiative_id)},
                update_expression=expression,
                expression_names=names,
                expression_values=values,
                condition=Attr("planning_key").exists() & Attr("kind").eq(INITIATIVE),
            )
        except ConditionFailed:
            return False
        return True

    def delete_initiative_updates(self, workspace_id: str, initiative_id: str, *, limit: int = 100) -> int:
        """Remove every update row of one initiative, returning how many went."""
        if not workspace_id or not initiative_id:
            return 0
        removed = 0
        while True:
            page = self._query_prefix(workspace_id, initiative_update_prefix(initiative_id), limit, None)
            if not page.items:
                return removed
            removed += self._repository.delete_many(
                [{"workspace_id": workspace_id, "planning_key": item["planning_key"]} for item in page.items]
            )

    def _get(self, workspace_id: str, planning_key: str) -> Mapping[str, Any] | None:
        """One stored row by its full sort key, or `None`."""
        if not workspace_id or not planning_key:
            return None
        return self._repository.get({"workspace_id": workspace_id, "planning_key": planning_key})

    def create_cycle(self, cycle: Cycle) -> Cycle:
        """Store a new cycle, raising `ConditionFailed` when the key is taken."""
        self._repository.put(as_cycle_item(cycle), condition=Attr("planning_key").not_exists())
        return cycle

    def create_project(self, project: Project) -> Project:
        """Store a new project, raising `ConditionFailed` when the key is taken."""
        self._repository.put(as_project_item(project), condition=Attr("planning_key").not_exists())
        return project

    def replace_cycle(self, cycle: Cycle) -> Cycle:
        """Write one cycle's fields over an existing row, recomputing its index attributes.

        Every attribute but the counters is set from the finished model, so the
        roadmap's range value derived from `end_date` never goes stale, while the
        counters and the rollup revision stay what the consumer last wrote rather
        than what the caller read. Raises `ConditionFailed` when the row is gone.
        """
        stored = self._replace_fields(as_cycle_item(cycle), ())
        return as_cycle(stored)

    def replace_project(self, project: Project) -> Project:
        """Write one project's fields over an existing row, its stored counters kept.

        A cleared optional field is removed rather than written as a null, so an
        undated project really does leave the sparse index. Raises
        `ConditionFailed` when the row is gone.
        """
        stored = self._replace_fields(as_project_item(project), PROJECT_OPTIONAL_FIELDS)
        return as_project(stored)

    def _replace_fields(self, item: Mapping[str, Any], optional: tuple[str, ...]) -> Mapping[str, Any]:
        """Set every non-counter attribute of one row and remove the cleared optional ones.

        An update expression rather than a whole-item put, because a put would
        write back the counters the caller read and lose any move the consumer
        made in between. Returns the stored row after the write.
        """
        names: dict[str, str] = {}
        values: dict[str, Any] = {}
        sets: list[str] = []
        for index, (name, value) in enumerate(sorted(item.items())):
            if name in KEY_ATTRIBUTES or name in ROLLUP_ATTRIBUTES:
                continue
            names[f"#f{index}"] = name
            values[f":f{index}"] = value
            sets.append(f"#f{index} = :f{index}")
        removes: list[str] = []
        for index, name in enumerate(optional):
            if name in item:
                continue
            names[f"#r{index}"] = name
            removes.append(f"#r{index}")
        expression = "SET " + ", ".join(sets)
        if removes:
            expression += " REMOVE " + ", ".join(removes)
        stored = self._repository.update(
            {"workspace_id": item["workspace_id"], "planning_key": item["planning_key"]},
            update_expression=expression,
            expression_names=names,
            expression_values=values,
            condition=Attr("planning_key").exists(),
            return_values="ALL_NEW",
        )
        return stored if stored is not None else item

    def set_counts(self, workspace_id: str, planning_key: str, counts: Mapping[str, int]) -> bool:
        """Write one project's or milestone's issue counts as recounted, returning whether the row was there.

        The point buckets are written only when the caller passes them. A `SET` of
        each bucket rather than an `ADD`, because the caller counted the issues
        themselves: writing the same numbers twice is harmless, which is what makes
        a redelivered record safe without a claim. Conditional on the row
        existing, so a recount racing a delete does not resurrect the row.
        """
        if not workspace_id or not planning_key:
            return False
        names: dict[str, str] = {"#counts": "counts"}
        values: dict[str, Any] = {}
        clauses: list[str] = []
        buckets = [bucket for bucket in COUNT_BUCKETS + POINT_BUCKETS if bucket in counts or bucket in COUNT_BUCKETS]
        for index, bucket in enumerate(buckets):
            names[f"#b{index}"] = bucket
            values[f":v{index}"] = max(0, int(counts.get(bucket, 0)))
            clauses.append(f"#counts.#b{index} = :v{index}")
        try:
            self._repository.update(
                {"workspace_id": workspace_id, "planning_key": planning_key},
                update_expression="SET " + ", ".join(clauses),
                expression_names=names,
                expression_values=values,
                condition=Attr("planning_key").exists() & Attr("counts").exists(),
            )
        except ConditionFailed:
            return False
        return True

    def delete(self, workspace_id: str, planning_key: str) -> bool:
        """Remove one planning row, reporting whether one was there."""
        if self._get(workspace_id, planning_key) is None:
            return False
        self._repository.delete({"workspace_id": workspace_id, "planning_key": planning_key})
        return True

    def move_counts(self, workspace_id: str, planning_key: str, deltas: Mapping[str, int]) -> bool:
        """Move one row's counters by the named deltas, atomically.

        One `ADD` over a nested map, so a decrement on the bucket an issue left and
        an increment on the one it entered land in a single write and two records on
        different shards cannot lose a count between a read and a write. Conditional
        on the row existing, so a count against a deleted cycle is dropped rather
        than resurrecting the row as a bare counter bag.

        Returns whether the row was there to be moved.
        """
        return self._move(workspace_id, planning_key, deltas, revise=False) is not None

    def move_cycle_counts(
        self, workspace_id: str, planning_key: str, deltas: Mapping[str, int]
    ) -> Mapping[str, Any] | None:
        """Move one cycle's counters and bump its rollup revision, returning the row after.

        The revision orders the snapshot writes that follow: two moves racing on
        different shards each see the counters their own `ADD` produced, and the
        higher revision is the later state. `None` when the row is gone.
        """
        return self._move(workspace_id, planning_key, deltas, revise=True)

    def _move(
        self, workspace_id: str, planning_key: str, deltas: Mapping[str, int], *, revise: bool
    ) -> Mapping[str, Any] | None:
        """Apply one counter move, returning the stored row after it or `None`."""
        wanted = {bucket: delta for bucket, delta in deltas.items() if bucket in COUNTER_KEYS and delta}
        if not workspace_id or not planning_key or not wanted:
            return None

        names: dict[str, str] = {"#counts": "counts"}
        values: dict[str, Any] = {}
        clauses: list[str] = []
        for index, (bucket, delta) in enumerate(sorted(wanted.items())):
            names[f"#b{index}"] = bucket
            values[f":d{index}"] = delta
            clauses.append(f"#counts.#b{index} :d{index}")
        if revise:
            names["#rev"] = "rollup_rev"
            values[":one"] = 1
            clauses.append("#rev :one")

        try:
            item = self._repository.update(
                {"workspace_id": workspace_id, "planning_key": planning_key},
                update_expression="ADD " + ", ".join(clauses),
                expression_names=names,
                expression_values=values,
                condition=Attr("planning_key").exists() & Attr("counts").exists(),
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
        return item if item is not None else {}

    def record_carried_issue(self, workspace_id: str, planning_key: str, attribute: str, issue_id: str) -> bool:
        """Add one issue to a cycle's carried out or carried in set, returning whether the row was there.

        An `ADD` to a string set, so a redelivered record adds nothing twice, and
        conditional on the row existing so a deleted cycle is never resurrected.
        """
        if attribute not in CARRIED_ID_ATTRIBUTES or not workspace_id or not planning_key or not issue_id:
            return False
        try:
            self._repository.update(
                {"workspace_id": workspace_id, "planning_key": planning_key},
                update_expression="ADD #ids :ids",
                expression_names={"#ids": attribute},
                expression_values={":ids": {issue_id}},
                condition=Attr("planning_key").exists(),
            )
        except ConditionFailed:
            return False
        return True

    def write_cycle_snapshot(
        self,
        workspace_id: str,
        team_id: str,
        cycle_id: str,
        day: str,
        *,
        rev: int,
        counts: Mapping[str, Any],
        opening: Mapping[str, Any],
    ) -> bool:
        """Record one cycle's counters as the day's latest value, returning whether it landed.

        Conditional on the revision moving forward, so a move that finished second
        but carries the earlier state never overwrites the later one. `opening` is
        written only by the first snapshot a day row ever gets.
        """
        if not workspace_id or not team_id or not cycle_id or not day:
            return False
        try:
            self._repository.update(
                {"workspace_id": workspace_id, "planning_key": cycle_history_key(team_id, cycle_id, day)},
                update_expression=(
                    "SET #counts = :counts, #rev = :rev, #kind = :kind, #team = :team, #cycle = :cycle, "
                    "#day = :day, #opening = if_not_exists(#opening, :opening)"
                ),
                expression_names={
                    "#counts": "counts",
                    "#rev": "rev",
                    "#kind": "kind",
                    "#team": "team_id",
                    "#cycle": "cycle_id",
                    "#day": "day",
                    "#opening": "opening",
                },
                expression_values={
                    ":counts": dict(counts),
                    ":rev": rev,
                    ":kind": CYCLE_HISTORY,
                    ":team": team_id,
                    ":cycle": cycle_id,
                    ":day": day,
                    ":opening": dict(opening),
                },
                condition=Attr("planning_key").not_exists() | Attr("rev").lt(rev),
            )
        except ConditionFailed:
            return False
        return True

    def list_cycle_history(
        self, workspace_id: str, team_id: str, cycle_id: str, *, max_items: int = 400
    ) -> list[CycleSnapshot]:
        """Every daily snapshot of one cycle, oldest day first."""
        if not workspace_id or not team_id or not cycle_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id)
            & Key("planning_key").begins_with(cycle_history_prefix(team_id, cycle_id)),
            max_items=max_items,
        )
        rows = [CycleSnapshot.from_item(item) for item in items if str(item.get("kind", "")) == CYCLE_HISTORY]
        return sorted(rows, key=lambda row: row.day)

    def delete_cycle_history(self, workspace_id: str, team_id: str, cycle_id: str, *, limit: int = 100) -> int:
        """Remove every daily snapshot of one cycle, returning how many went."""
        if not workspace_id or not team_id or not cycle_id:
            return 0
        removed = 0
        while True:
            page = self._query_prefix(workspace_id, cycle_history_prefix(team_id, cycle_id), limit, None)
            if not page.items:
                return removed
            removed += self._repository.delete_many(
                [{"workspace_id": workspace_id, "planning_key": item["planning_key"]} for item in page.items]
            )

    def iter_cycles_ended_between(self, since: str, until: str, *, page_size: int = 200) -> list[Cycle]:
        """Every live cycle of every workspace whose end date falls in `[since, until]`.

        A scan of the roadmap index, which only cycles write, so its cost is the
        number of cycles rather than the size of the table. The cycle close runs it
        on a schedule and has no workspace to start from.
        """
        found: list[Cycle] = []
        start_key: Mapping[str, Any] | None = None
        while True:
            page = self._repository.scan(
                index_name=TARGET_DATE_INDEX,
                filter_expression=Attr("target_date").between(since, until) & Attr("kind").eq(CYCLE),
                limit=page_size,
                start_key=dict(start_key) if start_key else None,
            )
            found.extend(as_cycle(item) for item in page.items if is_cycle(item))
            start_key = page.last_evaluated_key
            if not start_key:
                return sorted(found, key=lambda row: (row.end_date, row.cycle_id))

    def list_cycles(
        self,
        workspace_id: str,
        team_id: str,
        *,
        limit: int = 100,
        start_key: Mapping[str, Any] | None = None,
    ) -> tuple[list[Cycle], Mapping[str, Any] | None]:
        """One page of a team's cycles, by start date ascending.

        The table's own sort key orders by cycle id rather than by date, so the page
        is sorted after the read. That is honest for a team's cycles, which are a
        bounded set a team plans by hand rather than an unbounded feed.
        """
        page = self._query_prefix(workspace_id, cycle_prefix(team_id), limit, start_key)
        rows = [as_cycle(item) for item in page.items if is_cycle(item)]
        return sorted(rows, key=lambda row: (row.start_date, row.cycle_id)), page.last_evaluated_key

    def list_projects(self, workspace_id: str, *, max_items: int = 1000) -> list[Project]:
        """Every project of the workspace, by target date ascending, undated last.

        One query under the workspace's project prefix. Projects are a bounded set
        a workspace plans by hand, so the route reads them whole, filters by what
        the caller may see and pages over the merged order, rather than paging a
        key range that visibility would then leave short.
        """
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(PROJECT_KEY_PREFIX),
            max_items=max_items,
        )
        rows = [as_project(item) for item in items if is_current_project(item)]
        return sorted(rows, key=lambda row: (row.target_date is None, row.target_date or "", row.project_id))

    def delete_cycles_page(self, workspace_id: str, team_id: str, *, limit: int = 100) -> int:
        """Remove one page of a team's cycle rows, returning how many went.

        The team purge calls this until it answers zero. Every row under the
        team's cycle prefix goes, whatever its kind, then every daily snapshot
        under its history prefix, because nothing else is filed under a deleted
        team's prefix.
        """
        page = self._query_prefix(workspace_id, cycle_prefix(team_id), limit, None)
        if not page.items:
            page = self._query_prefix(workspace_id, cycle_history_prefix(team_id), limit, None)
        if not page.items:
            return 0
        return self._repository.delete_many(
            [{"workspace_id": workspace_id, "planning_key": item["planning_key"]} for item in page.items]
        )

    def _query_prefix(
        self,
        workspace_id: str,
        prefix: str,
        limit: int,
        start_key: Mapping[str, Any] | None,
    ) -> Page:
        """One page of the rows under a sort key prefix."""
        return self._repository.query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(prefix),
            limit=limit,
            start_key=dict(start_key) if start_key else None,
        )

    def list_for_roadmap(self, workspace_id: str, team_id: str, *, max_items: int = 500) -> list[Cycle]:
        """Every cycle of one team, by end date ascending.

        Reads `ws_team-target_date-index`, which only cycles write, so the roadmap
        costs one query per team for its cycles and one workspace query for its
        projects.
        """
        if not workspace_id or not team_id:
            return []
        items = self._repository.iter_query(
            Key("ws_team").eq(ws_team(workspace_id, team_id)),
            index_name=TARGET_DATE_INDEX,
            max_items=max_items,
        )
        return [as_cycle(item) for item in items if is_cycle(item)]
