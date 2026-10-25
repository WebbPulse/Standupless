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

from app.common.bulk_import import IMPORT_BATCH_ATTRIBUTE
from app.common.db.dynamo.base import build_repository, delete_partition, utc_now
from app.common.db.dynamo.tables import PLANNING
from app.common.db.dynamo.update_threads import UpdateThreadStore

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

PROJECT_ACTIVITY = "project_activity"

PROJECT_ACTIVITY_KEY_PREFIX = "project_activity#"
"""Where a project's property changes are filed, one row per change, oldest first by ULID.

`begins_with("project#")` never matches it, so the project listing never reads an
activity row.
"""

PROJECT_RELATION = "project_relation"

PROJECT_RELATION_KEY_PREFIX = "project_relation#"
"""Where project to project dependencies are filed, one row per pair in the blocks direction.

`begins_with("project#")` never matches it, so the project listing never reads a
relation row.
"""

PROJECT_LABEL = "project_label"

PROJECT_LABEL_KEY_PREFIX = "project_label#"
"""Where the workspace's project labels are filed, one row per label.

`begins_with("project#")` never matches it, so the project listing never reads a
label row.
"""

PROJECT_STATUS = "project_status"

PROJECT_STATUS_KEY_PREFIX = "project_status#"
"""Where the workspace's own project statuses are filed, one row per status.

`begins_with("project#")` never matches it, so the project listing never reads a
status row. A workspace with no rows reads the six seeded defaults.
"""

PROJECT_LINK = "project_link"

PROJECT_LINK_KEY_PREFIX = "project_link#"
"""Where each project's Resources links are filed, one row per link.

`begins_with("project#")` never matches it, so the project listing never reads a
link row.
"""

PROJECT_LINKS_MAX = 50
"""How many Resources links one project may hold."""

INITIATIVE = "initiative"

INITIATIVE_KEY_PREFIX = "initiative#"

INITIATIVE_UPDATE = "initiative_update"

INITIATIVE_UPDATE_KEY_PREFIX = "initiative_update#"

PULSE_EVENT = "pulse_event"

PULSE_KEY_PREFIX = "pulse#"
"""Where the workspace's Pulse feed is filed, one row per event, newest last by ULID."""

PULSE_FOLLOW = "pulse_follow"

PULSE_FOLLOW_PREFIX = "pulse_follow#"
"""Where each person's explicit follows and unfollows of projects and initiatives are filed."""

PULSE_READ = "pulse_read"

PULSE_READ_PREFIX = "pulse_read#"
"""Where each person's Pulse read marker is filed."""

CYCLE_FEED = "cycle_feed"
"""The kind of one person's cycle calendar feed row for one team."""

PulseSubject = Literal["project", "initiative"]

PULSE_SUBJECTS: tuple[str, ...] = ("project", "initiative")

PULSE_EVENT_TYPES: tuple[str, ...] = (
    "project_update",
    "initiative_update",
    "project_health",
    "initiative_health",
    "milestone_completed",
)
"""What a Pulse event can report."""

MILESTONE_COMPLETED_ATTRIBUTE = "pulse_completed_at"
"""The milestone attribute that records its completion was posted to Pulse, so it is posted once."""

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

ESTIMATING_TEAMS = "estimating_teams"
"""How many teams with an estimate scale a project touches, stored in its and its milestones' `counts` map.

Written by the project recount beside the buckets, so a reader knows whether the
point buckets hold estimate points or, with no estimating team, issue counts.
"""


ProgressMeasure = Literal["points", "issues"]
"""The unit a project's, milestone's or initiative's progress reads in."""


def progress_measure(estimating_teams: int) -> ProgressMeasure:
    """Points when any team on the work estimates, otherwise issues, as Linear labels it."""
    return "points" if estimating_teams > 0 else "issues"


COUNTER_KEYS: frozenset[str] = frozenset(COUNT_BUCKETS + POINT_BUCKETS + UNESTIMATED_BUCKETS + CARRY_COUNTERS)
"""Every key a rollup may move inside a planning row's `counts` map."""

CYCLE_RECOUNT_KEYS: tuple[str, ...] = COUNT_BUCKETS + POINT_BUCKETS + UNESTIMATED_BUCKETS
"""The cycle counters a recount can rebuild from the issues a cycle holds now, carry counters excluded."""

CYCLE_HISTORY = "cycle_history"
"""The kind of one daily scope snapshot of a cycle."""

PROJECT_HISTORY = "project_history"
"""The kind of one daily scope snapshot of a project."""

PROJECT_HISTORY_KEY_PREFIX = "projecthist#"
"""Where a project's daily snapshots are filed, one row per day it moved.

`begins_with("project#")` never matches it, so the project listing never reads a
snapshot row.
"""


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


def project_activity_prefix(project_id: str) -> str:
    """The sort key prefix every activity row of one project shares."""
    return f"{PROJECT_ACTIVITY_KEY_PREFIX}{project_id}#"


def project_activity_key(project_id: str, activity_id: str) -> str:
    """The sort key of one project activity row, time sortable by its ULID."""
    return f"{project_activity_prefix(project_id)}{activity_id}"


def project_relation_key(blocker_id: str, blocked_id: str) -> str:
    """The sort key of one dependency, read as `blocker_id` blocks `blocked_id`.

    One row per pair in one direction, so a link and its inverse can never both
    be stored and a repeat link lands on the key that is already there.
    """
    return f"{PROJECT_RELATION_KEY_PREFIX}{blocker_id}#{blocked_id}"


def project_label_key(label_id: str) -> str:
    """The sort key of one project label row."""
    return f"{PROJECT_LABEL_KEY_PREFIX}{label_id}"


def project_status_key(status_id: str) -> str:
    """The sort key of one project status row."""
    return f"{PROJECT_STATUS_KEY_PREFIX}{status_id}"


def project_link_prefix(project_id: str) -> str:
    """The sort key prefix every Resources link of one project shares."""
    return f"{PROJECT_LINK_KEY_PREFIX}{project_id}#"


def project_link_key(project_id: str, link_id: str) -> str:
    """The sort key of one Resources link of a project."""
    return f"{project_link_prefix(project_id)}{link_id}"


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


def pulse_key(event_id: str) -> str:
    """The sort key of one Pulse event."""
    return f"{PULSE_KEY_PREFIX}{event_id}"


def pulse_follow_prefix(user_id: str) -> str:
    """The sort key prefix of one person's follow rows."""
    return f"{PULSE_FOLLOW_PREFIX}{user_id}#"


def pulse_follow_key(user_id: str, subject_type: str, subject_id: str) -> str:
    """The sort key of one person's follow row for one project or initiative."""
    return f"{pulse_follow_prefix(user_id)}{subject_type}#{subject_id}"


def pulse_read_key(user_id: str) -> str:
    """The sort key of one person's Pulse read marker."""
    return f"{PULSE_READ_PREFIX}{user_id}"


def cycle_prefix(team_id: str) -> str:
    """The sort key prefix every cycle of one team shares."""
    return f"team#{team_id}#cycle#"


def cycle_feed_prefix(team_id: str) -> str:
    """The sort key prefix every cycle calendar feed of one team shares.

    Filed under `cyclefeed#` rather than `cycle#`, so a cycle listing never reads a
    feed row, while the team purge still clears it beside the team's cycles.
    """
    return f"team#{team_id}#cyclefeed#"


def cycle_feed_key(team_id: str, user_id: str) -> str:
    """The sort key of one person's cycle calendar feed for one team."""
    return f"{cycle_feed_prefix(team_id)}{user_id}"


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


def project_history_prefix(project_id: str) -> str:
    """The sort key prefix of one project's daily snapshots."""
    return f"{PROJECT_HISTORY_KEY_PREFIX}{project_id}#"


def project_history_key(project_id: str, day: str) -> str:
    """The sort key of one project's snapshot for one day, ordered by day."""
    return f"{project_history_prefix(project_id)}{day}"


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
    import_batch_id: str | None = None

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
    `label_ids` are the workspace project labels it carries, empty by default.
    `update_interval_days` is the project's own update cadence; None follows the
    workspace default and 0 turns reminders off. `status_counts` is the rollup's
    count of open and closed issues per status id, beside the category buckets.
    `completed_at` is when the project last became completed or canceled, and
    None while it is open or on a row closed before the field existed.
    `sort_order` is the workspace-wide manual position, a base 62 fractional
    key; None on a row never placed, which the manual ordering puts last.
    `archived_at` is when the project was archived, None while it is live.
    `status` is the category the project's status sits in, which every rule
    reads, and `status_id` the workspace project status itself; None on a row
    written before custom statuses, which reads as its category's seeded default.
    `start_date_resolution` and `target_date_resolution` widen a date to its
    month, quarter, half or year, the date held at that period's first or last
    day; None is an exact day.
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
    start_date_resolution: str | None = None
    target_date_resolution: str | None = None
    status: str = "backlog"
    status_id: str | None = None
    icon: str | None = None
    color: str | None = None
    health: str | None = None
    priority: str = "none"
    member_ids: list[str] = Field(default_factory=list)
    label_ids: list[str] = Field(default_factory=list)
    counts: RollupCounts = Field(default_factory=RollupCounts)
    points: RollupCounts = Field(default_factory=RollupCounts)
    estimating_teams: int = 0
    status_counts: dict[str, int] = Field(default_factory=dict)
    last_update_at: datetime | None = None
    update_interval_days: int | None = None
    initiative_id: str | None = None
    completed_at: datetime | None = None
    sort_order: str | None = None
    archived_at: datetime | None = None
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    import_batch_id: str | None = None

    @property
    def measure(self) -> ProgressMeasure:
        """Whether progress reads in estimate points or in issues."""
        return progress_measure(self.estimating_teams)

    @property
    def progress(self) -> RollupCounts:
        """The buckets progress is measured by: points when a team estimates, issue counts otherwise."""
        return self.points if self.measure == "points" else self.counts

    @property
    def effective_status_id(self) -> str:
        """The project status the row sits in, its category's seeded default when none was stored."""
        return self.status_id or self.status


class Initiative(BaseModel):
    """One workspace level goal that groups projects across teams, as in Linear.

    Membership is stored on each project's `initiative_id` rather than here, so a
    project belongs to at most one initiative and removing a project needs no
    second write. `health` and `last_update_at` mirror the newest update, as a
    project's do, and `update_interval_days` follows the same cadence rules.
    `parent_initiative_id` nests it under another initiative as a sub-initiative,
    held on the child so a parent keeps no list of children to hold in step.
    `target_date_resolution` widens the target to its month, quarter, half or
    year, the date held at that period's last day; None is an exact day.
    `start_date` opens the initiative's span on the timeline, and
    `start_date_resolution` widens it the same way, held at the period's first day.
    `team_id` names a lead team, so the team's page lists it and a private
    team's initiative is seen only by that team's members; None keeps it
    workspace level, seen by every member but a guest.
    `sort_order` is the workspace-wide manual position, a base 62 fractional
    key shared by every viewer; None on a row never placed, which the manual
    ordering puts last.
    """

    workspace_id: str
    planning_key: str
    initiative_id: str = Field(default_factory=new_planning_id)
    kind: str = INITIATIVE
    name: str
    description: str | None = None
    owner_id: str | None = None
    team_id: str | None = None
    parent_initiative_id: str | None = None
    status: str = "planned"
    health: str | None = None
    start_date: str | None = None
    start_date_resolution: str | None = None
    target_date: str | None = None
    target_date_resolution: str | None = None
    last_update_at: datetime | None = None
    update_interval_days: int | None = None
    sort_order: str | None = None
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    import_batch_id: str | None = None


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


class MilestoneSnapshot(BaseModel):
    """One milestone's progress as a project update recorded it."""

    milestone_id: str
    name: str
    completed: int = 0
    total: int = 0


class ProjectUpdateSnapshot(BaseModel):
    """Where a project stood when an update was posted, for the report of what changed since the last one.

    `completed` and `total` are in `measure`, cancelled work left out of the
    total, and `percent` is their whole percent. The lead's and the status's
    names are copied so the report reads the same after either is renamed.
    """

    measure: str = "issues"
    completed: int = 0
    total: int = 0
    percent: int = 0
    target_date: str | None = None
    target_date_resolution: str | None = None
    lead_id: str | None = None
    lead_name: str | None = None
    status: str | None = None
    status_id: str | None = None
    status_name: str | None = None
    milestones: list[MilestoneSnapshot] = Field(default_factory=list)


class ProjectUpdateRow(BaseModel):
    """One written status update on a project, with the health it reported.

    The newest update is what the project's `health` and `last_update_at`
    mirror, so a reader of the project row sees the latest report without
    reading the update feed.

    `snapshot` is where the project stood when the update was posted and
    `previous_snapshot` the one the update before it recorded, so the report of
    what changed reads off one row. Both are None on an update posted before
    snapshots existed, and `hide_details` is the author's choice to hide it.
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
    import_batch_id: str | None = None
    snapshot: ProjectUpdateSnapshot | None = None
    previous_snapshot: ProjectUpdateSnapshot | None = None
    hide_details: bool = False


class ProjectActivityRow(BaseModel):
    """One recorded change to a project: created, a property changed, or a milestone added or removed.

    `field` names the property for a `field_changed` row and is None otherwise.
    `from_value` and `to_value` hold the property's old and new values, or the
    milestone's name for a milestone row, so the feed renders without reading
    back a milestone that may since have been deleted.
    """

    workspace_id: str
    planning_key: str
    activity_id: str = Field(default_factory=new_planning_id)
    project_id: str
    kind: str = PROJECT_ACTIVITY
    event: str
    field: str | None = None
    from_value: Any = None
    to_value: Any = None
    milestone_id: str | None = None
    link_id: str | None = None
    actor_id: str
    source: str | None = None
    created_at: datetime = Field(default_factory=utc_now)


class ProjectRelation(BaseModel):
    """One dependency between two projects of a workspace: `project_id` blocks `target_project_id`."""

    workspace_id: str
    planning_key: str
    relation_id: str = Field(default_factory=new_planning_id)
    project_id: str
    target_project_id: str
    kind: str = PROJECT_RELATION
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)

    def involves(self, project_id: str) -> bool:
        """Whether one project is either end of this dependency."""
        return project_id in (self.project_id, self.target_project_id)


class ProjectLabel(BaseModel):
    """One label of the workspace that tags projects, apart from the labels issues carry."""

    workspace_id: str
    planning_key: str = ""
    label_id: str = Field(default_factory=new_planning_id)
    kind: str = PROJECT_LABEL
    name: str
    color: str
    description: str | None = None
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    def model_post_init(self, _context: Any) -> None:
        """Derive the sort key from the id when none was given."""
        if not self.planning_key:
            self.planning_key = project_label_key(self.label_id)


class ProjectStatusRow(BaseModel):
    """One project status of the workspace, a named stage inside one fixed category.

    `category` is one of `PROJECT_STATUSES` and never changes, so every rule that
    reads a project's category holds however the status is renamed. `position`
    orders the statuses within their category. A null `color` draws the
    category's own tone.
    """

    workspace_id: str
    planning_key: str = ""
    status_id: str = Field(default_factory=new_planning_id)
    kind: str = PROJECT_STATUS
    name: str
    category: str
    color: str | None = None
    description: str | None = None
    position: int = 0
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    def model_post_init(self, _context: Any) -> None:
        """Derive the sort key from the id when none was given."""
        if not self.planning_key:
            self.planning_key = project_status_key(self.status_id)


class ProjectLink(BaseModel):
    """One external link in a project's Resources section.

    `title` is what the person typed and is None when they left it blank, in which
    case readers show the link's hostname. `sort_order` is a base 62 fractional
    key, so a reorder rewrites only the row that moved.
    """

    workspace_id: str
    planning_key: str = ""
    link_id: str = Field(default_factory=new_planning_id)
    project_id: str
    kind: str = PROJECT_LINK
    url: str
    title: str | None = None
    sort_order: str
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    def model_post_init(self, _context: Any) -> None:
        """Derive the sort key from the project and link ids when none was given."""
        if not self.planning_key:
            self.planning_key = project_link_key(self.project_id, self.link_id)


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
    estimating_teams: int = 0
    status_counts: dict[str, int] = Field(default_factory=dict)
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    import_batch_id: str | None = None

    @property
    def measure(self) -> ProgressMeasure:
        """Whether progress reads in estimate points or in issues."""
        return progress_measure(self.estimating_teams)

    @property
    def progress(self) -> RollupCounts:
        """The buckets progress is measured by: points when a team estimates, issue counts otherwise."""
        return self.points if self.measure == "points" else self.counts


class PulseEvent(BaseModel):
    """One entry of the workspace's Pulse feed: an update posted, a health change or a milestone completed.

    Filed under the workspace with a ULID sort key, so the feed is one descending
    query and who may read each entry is decided against its project's teams, or
    its initiative, as it is read. An update's entry is keyed by the update's own
    id, so an edit or a delete of the update finds it. The body, health and
    milestone name are copied onto the row, so the feed renders without a read
    per entry.
    """

    workspace_id: str
    planning_key: str
    event_id: str
    kind: str = PULSE_EVENT
    event_type: str
    subject_type: str
    project_id: str | None = None
    initiative_id: str | None = None
    milestone_id: str | None = None
    milestone_name: str | None = None
    update_id: str | None = None
    body: str | None = None
    health: str | None = None
    previous_health: str | None = None
    actor_id: str = ""
    source: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    edited_at: datetime | None = None


def as_pulse_event_item(event: PulseEvent) -> dict[str, Any]:
    """One Pulse event as the stored item, null fields dropped."""
    return {name: value for name, value in event.model_dump(mode="json").items() if value is not None}


def as_pulse_event(item: Mapping[str, Any]) -> PulseEvent:
    """One stored item as a `PulseEvent`."""
    return PulseEvent.model_validate(dict(item))


def is_pulse_event(item: Mapping[str, Any]) -> bool:
    """Whether one stored row is a Pulse event."""
    return str(item.get("kind", "")) == PULSE_EVENT


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
    if not item.get("import_batch_id"):
        item.pop("import_batch_id", None)
    return item


PROJECT_OPTIONAL_FIELDS: tuple[str, ...] = (
    "status_id",
    "target_date",
    "start_date",
    "start_date_resolution",
    "target_date_resolution",
    "lead_id",
    "description",
    "icon",
    "color",
    "health",
    "last_update_at",
    "update_interval_days",
    "initiative_id",
    "sort_order",
    "archived_at",
    "import_batch_id",
)
"""The project attributes a null value removes from the row rather than storing."""

INITIATIVE_OPTIONAL_FIELDS: tuple[str, ...] = (
    "description",
    "owner_id",
    "team_id",
    "parent_initiative_id",
    "health",
    "start_date",
    "start_date_resolution",
    "target_date",
    "target_date_resolution",
    "last_update_at",
    "update_interval_days",
    "sort_order",
    "import_batch_id",
)
"""The initiative attributes a null value removes from the row rather than storing."""

MILESTONE_OPTIONAL_FIELDS: tuple[str, ...] = ("target_date", "description", "import_batch_id")
"""The milestone attributes a null value removes from the row rather than storing."""

ROLLUP_ATTRIBUTES: frozenset[str] = frozenset({"counts", "status_counts", "rollup_rev"})
"""What only the rollup consumer writes, which an edit of the row leaves alone."""

KEY_ATTRIBUTES: frozenset[str] = frozenset({"workspace_id", "planning_key"})
"""The table's key, which an update names rather than sets."""


def _with_points_in_counts(item: dict[str, Any]) -> dict[str, Any]:
    """One dumped project or milestone with its points moved into the `counts` map, as a cycle stores them."""
    counts = dict(item.get("counts") or {})
    counts.update({f"{POINT_PREFIX}{bucket}": value for bucket, value in (item.pop("points", None) or {}).items()})
    counts[ESTIMATING_TEAMS] = int(item.pop(ESTIMATING_TEAMS, 0) or 0)
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


def _marked(item: dict[str, Any], keep_import_batch: bool) -> dict[str, Any]:
    """One item to write over a row, without the bulk import marker unless the importer's re-run keeps it.

    A person's edit of an imported row drops the marker, so that edit and every
    later one is announced as usual.
    """
    if not keep_import_batch or not item.get(IMPORT_BATCH_ATTRIBUTE):
        item.pop(IMPORT_BATCH_ATTRIBUTE, None)
    return item


def _stored_time(value: datetime) -> str:
    """A datetime in the string form a model dump stores, so every row reads alike."""
    return str(_DATETIME.dump_python(value, mode="json"))


def as_project_update_item(update: ProjectUpdateRow) -> dict[str, Any]:
    """One project update as the stored item, with no empty optional field and no `hide_details` left off."""
    item = update.model_dump(mode="json")
    for name in ("edited_at", "import_batch_id", "snapshot", "previous_snapshot"):
        if item.get(name) is None:
            item.pop(name, None)
    if not item.get("hide_details"):
        item.pop("hide_details", None)
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


def as_project_activity_item(row: ProjectActivityRow) -> dict[str, Any]:
    """One project activity row as the stored item, null fields dropped."""
    return {name: value for name, value in row.model_dump(mode="json").items() if value is not None}


def as_project_activity(item: Mapping[str, Any]) -> ProjectActivityRow:
    """One stored item as a `ProjectActivityRow`."""
    return ProjectActivityRow.model_validate(dict(item))


def is_project_activity(item: Mapping[str, Any]) -> bool:
    """Whether one stored row is a project activity row."""
    return str(item.get("kind", "")) == PROJECT_ACTIVITY


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


def status_counts_of(item: Mapping[str, Any]) -> dict[str, int]:
    """A stored row's issue count per status id, empty on a row the rollup has not recounted since it grew them."""
    values = item.get("status_counts")
    if not isinstance(values, Mapping):
        return {}
    return {str(status_id): max(0, int(count)) for status_id, count in values.items() if int(count) > 0}


def estimating_teams_of(item: Mapping[str, Any]) -> int:
    """A stored row's count of estimating teams, zero on a row the recount has not reached since it grew it."""
    values = item.get("counts")
    if not isinstance(values, Mapping):
        return 0
    return max(0, int(values.get(ESTIMATING_TEAMS, 0) or 0))


def as_project(item: Mapping[str, Any]) -> Project:
    """One stored item as a `Project`, ignoring the index composites.

    A legacy status name is read as its current equivalent, so a row written
    before the status set grew still validates against the response schema.
    """
    fields = {key: value for key, value in item.items() if key not in INDEX_ATTRIBUTE_NAMES}
    fields["counts"] = RollupCounts.from_item(item)
    fields["points"] = RollupCounts.from_item(item, POINT_PREFIX)
    fields[ESTIMATING_TEAMS] = estimating_teams_of(item)
    fields["status_counts"] = status_counts_of(item)
    fields["status"] = normalise_project_status(str(item.get("status", "backlog")))
    return Project.model_validate(fields)


def as_milestone(item: Mapping[str, Any]) -> ProjectMilestone:
    """One stored item as a `ProjectMilestone`, its counters floored at zero."""
    fields = {key: value for key, value in item.items() if key not in INDEX_ATTRIBUTE_NAMES}
    fields["counts"] = RollupCounts.from_item(item)
    fields["points"] = RollupCounts.from_item(item, POINT_PREFIX)
    fields[ESTIMATING_TEAMS] = estimating_teams_of(item)
    fields["status_counts"] = status_counts_of(item)
    return ProjectMilestone.model_validate(fields)


def is_project_relation(item: Mapping[str, Any]) -> bool:
    """Whether one stored row is a dependency between two projects."""
    return str(item.get("kind", "")) == PROJECT_RELATION


def as_project_relation(item: Mapping[str, Any]) -> ProjectRelation:
    """One stored item as a `ProjectRelation`."""
    return ProjectRelation.model_validate(dict(item))


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


class CycleFeed(BaseModel):
    """One person's cycle calendar feed for one team, holding only the token's hash.

    The token itself is answered once, when it is minted, and never stored, so a
    read of this table cannot reproduce a working feed URL.
    """

    workspace_id: str
    team_id: str
    user_id: str
    token_hash: str
    created_at: datetime = Field(default_factory=utc_now)


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


class ProjectSnapshot(BaseModel):
    """One project's recounted counters as they stood at the end of one day.

    Written by the project recount whenever the project's counts change, so the
    last write of a day is the day's closing value. `opening_*` is what the
    project held before that day's first recount, which is the close of the day
    before and, on the first snapshot ever written, what the earlier days read as.
    """

    day: str
    counts: RollupCounts = Field(default_factory=RollupCounts)
    points: RollupCounts = Field(default_factory=RollupCounts)
    estimating_teams: int = 0
    opening_counts: RollupCounts = Field(default_factory=RollupCounts)
    opening_points: RollupCounts = Field(default_factory=RollupCounts)

    @classmethod
    def from_item(cls, item: Mapping[str, Any]) -> "ProjectSnapshot":
        """One stored snapshot row, its counters floored at zero."""
        opening = item.get("opening")
        opening_map: Mapping[str, Any] = opening if isinstance(opening, Mapping) else {}
        return cls(
            day=str(item.get("day", "")),
            counts=RollupCounts.from_item(item),
            points=RollupCounts.from_item(item, POINT_PREFIX),
            estimating_teams=estimating_teams_of(item),
            opening_counts=RollupCounts.from_map(opening_map),
            opening_points=RollupCounts.from_map(opening_map, POINT_PREFIX),
        )


class PlanningRepository:
    """Reads and writes `planning` rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(PLANNING, repository)
        self.update_threads = UpdateThreadStore(self._repository)

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

    def list_workspace_milestones(self, workspace_id: str, *, max_items: int = 10_000) -> list[ProjectMilestone]:
        """Every milestone of every project in the workspace, in one query under the milestone prefix.

        The project list reads this once to mark milestones on the timeline rather
        than reading each project's milestones in turn.
        """
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(MILESTONE_KEY_PREFIX),
            max_items=max_items,
        )
        rows = [as_milestone(item) for item in items if is_milestone(item)]
        return sorted(rows, key=milestone_order)

    def create_milestone(self, milestone: ProjectMilestone) -> ProjectMilestone:
        """Store a new milestone, raising `ConditionFailed` when the key is taken."""
        self._repository.put(as_milestone_item(milestone), condition=Attr("planning_key").not_exists())
        return milestone

    def replace_milestone(self, milestone: ProjectMilestone, *, keep_import_batch: bool = False) -> ProjectMilestone:
        """Write one milestone's fields over an existing row, its stored counters kept.

        Raises `ConditionFailed` when the row is gone. The bulk import marker is
        cleared unless `keep_import_batch` says this is the importer's own re-run.
        """
        item = _marked(as_milestone_item(milestone), keep_import_batch)
        stored = self._replace_fields(item, MILESTONE_OPTIONAL_FIELDS)
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

    def replace_project_update(self, update: ProjectUpdateRow, *, keep_import_batch: bool = False) -> ProjectUpdateRow:
        """Write one update over an existing row, raising `ConditionFailed` when it is gone.

        The bulk import marker is cleared unless `keep_import_batch` says this is
        the importer's own re-run.
        """
        item = _marked(as_project_update_item(update), keep_import_batch)
        self._repository.put(item, condition=Attr("planning_key").exists())
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

    def record_project_activity(self, rows: list[ProjectActivityRow]) -> list[ProjectActivityRow]:
        """Store a project's activity rows in one batch.

        Unconditional, because each sort key carries a fresh ULID and a condition
        would only add a failure mode to a write that follows a change already stored.
        """
        if rows:
            self._repository.put_many([as_project_activity_item(row) for row in rows])
        return rows

    def list_project_activity(
        self,
        workspace_id: str,
        project_id: str,
        *,
        limit: int,
        start_key: Mapping[str, Any] | None = None,
    ) -> tuple[list[ProjectActivityRow], Mapping[str, Any] | None]:
        """One page of a project's activity, newest first, and the key to resume from."""
        if not workspace_id or not project_id:
            return [], None
        page = self._repository.query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(project_activity_prefix(project_id)),
            limit=limit,
            start_key=dict(start_key) if start_key else None,
            ascending=False,
        )
        rows = [as_project_activity(item) for item in page.items if is_project_activity(item)]
        return rows, page.last_evaluated_key

    def delete_project_activity(self, workspace_id: str, project_id: str, *, limit: int = 100) -> int:
        """Remove every activity row of one project, returning how many went."""
        if not workspace_id or not project_id:
            return 0
        removed = 0
        while True:
            page = self._query_prefix(workspace_id, project_activity_prefix(project_id), limit, None)
            if not page.items:
                return removed
            removed += self._repository.delete_many(
                [{"workspace_id": workspace_id, "planning_key": item["planning_key"]} for item in page.items]
            )

    def list_project_relations(self, workspace_id: str, *, max_items: int = 10_000) -> list[ProjectRelation]:
        """Every dependency between the workspace's projects, oldest first.

        One query under the relation prefix. Dependencies are a bounded set people
        draw by hand, so a reader takes them whole and filters by visibility.
        """
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(PROJECT_RELATION_KEY_PREFIX),
            max_items=max_items,
        )
        rows = [as_project_relation(item) for item in items if is_project_relation(item)]
        return sorted(rows, key=lambda row: row.relation_id)

    def get_project_relation(self, workspace_id: str, blocker_id: str, blocked_id: str) -> ProjectRelation | None:
        """The dependency of `blocker_id` blocking `blocked_id`, or `None`."""
        if not blocker_id or not blocked_id:
            return None
        item = self._get(workspace_id, project_relation_key(blocker_id, blocked_id))
        if item is None or not is_project_relation(item):
            return None
        return as_project_relation(item)

    def create_project_relation(self, relation: ProjectRelation) -> ProjectRelation:
        """Store a new dependency, raising `ConditionFailed` when the pair is already linked."""
        self._repository.put(relation.model_dump(mode="json"), condition=Attr("planning_key").not_exists())
        return relation

    def delete_project_relations_for(self, workspace_id: str, project_id: str) -> int:
        """Remove every dependency either end of which is one project, returning how many went."""
        if not workspace_id or not project_id:
            return 0
        keys = [
            {"workspace_id": workspace_id, "planning_key": row.planning_key}
            for row in self.list_project_relations(workspace_id)
            if row.involves(project_id)
        ]
        return self._repository.delete_many(keys) if keys else 0

    def get_project_label(self, workspace_id: str, label_id: str) -> ProjectLabel | None:
        """One project label of the workspace, or `None`."""
        if not label_id:
            return None
        item = self._get(workspace_id, project_label_key(label_id))
        if item is None or str(item.get("kind", "")) != PROJECT_LABEL:
            return None
        return ProjectLabel.model_validate(dict(item))

    def list_project_labels(self, workspace_id: str, *, max_items: int = 1000) -> list[ProjectLabel]:
        """Every project label of the workspace, by name."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(PROJECT_LABEL_KEY_PREFIX),
            max_items=max_items,
        )
        rows = [ProjectLabel.model_validate(dict(item)) for item in items if item.get("kind") == PROJECT_LABEL]
        return sorted(rows, key=lambda row: (row.name.casefold(), row.label_id))

    def put_project_label(self, label: ProjectLabel, *, create: bool) -> ProjectLabel:
        """Store a new project label or write an edited one, raising `ConditionFailed` on a taken or missing key."""
        item = label.model_dump(mode="json")
        if item.get("description") is None:
            item.pop("description", None)
        condition = Attr("planning_key").not_exists() if create else Attr("planning_key").exists()
        self._repository.put(item, condition=condition)
        return label

    def get_project_status(self, workspace_id: str, status_id: str) -> ProjectStatusRow | None:
        """One stored project status of the workspace, or `None`; the seeded defaults are not read here."""
        if not status_id:
            return None
        item = self._get(workspace_id, project_status_key(status_id))
        if item is None or str(item.get("kind", "")) != PROJECT_STATUS:
            return None
        return ProjectStatusRow.model_validate(dict(item))

    def list_project_statuses(self, workspace_id: str, *, max_items: int = 1000) -> list[ProjectStatusRow]:
        """Every stored project status of the workspace, by category then position; empty before the first edit."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(PROJECT_STATUS_KEY_PREFIX),
            max_items=max_items,
        )
        rows = [ProjectStatusRow.model_validate(dict(item)) for item in items if item.get("kind") == PROJECT_STATUS]
        order = {category: index for index, category in enumerate(PROJECT_STATUSES)}
        return sorted(rows, key=lambda row: (order.get(row.category, len(order)), row.position, row.status_id))

    def put_project_status(self, row: ProjectStatusRow, *, create: bool) -> ProjectStatusRow:
        """Store a new project status or write an edited one, raising `ConditionFailed` on a taken or missing key."""
        item = row.model_dump(mode="json")
        for name in ("color", "description"):
            if item.get(name) is None:
                item.pop(name, None)
        condition = Attr("planning_key").not_exists() if create else Attr("planning_key").exists()
        self._repository.put(item, condition=condition)
        return row

    def delete_project_status(self, workspace_id: str, status_id: str) -> None:
        """Remove one project status row; the projects in it are moved by the caller first."""
        if not workspace_id or not status_id:
            return
        self._repository.delete({"workspace_id": workspace_id, "planning_key": project_status_key(status_id)})

    def get_project_link(self, workspace_id: str, project_id: str, link_id: str) -> ProjectLink | None:
        """One Resources link of one project, or `None`; the project is part of the key."""
        if not project_id or not link_id:
            return None
        item = self._get(workspace_id, project_link_key(project_id, link_id))
        if item is None or str(item.get("kind", "")) != PROJECT_LINK:
            return None
        return ProjectLink.model_validate(dict(item))

    def list_project_links(self, workspace_id: str, project_id: str, *, max_items: int = 500) -> list[ProjectLink]:
        """Every Resources link of one project, in its manual order."""
        if not workspace_id or not project_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(project_link_prefix(project_id)),
            max_items=max_items,
        )
        rows = [ProjectLink.model_validate(dict(item)) for item in items if item.get("kind") == PROJECT_LINK]
        return sorted(rows, key=lambda row: (row.sort_order, row.link_id))

    def put_project_link(self, link: ProjectLink, *, create: bool) -> ProjectLink:
        """Store a new Resources link or write an edited one, raising `ConditionFailed` on a taken or missing key."""
        item = link.model_dump(mode="json")
        if item.get("title") is None:
            item.pop("title", None)
        condition = Attr("planning_key").not_exists() if create else Attr("planning_key").exists()
        self._repository.put(item, condition=condition)
        return link

    def delete_project_links(self, workspace_id: str, project_id: str, *, limit: int = 100) -> int:
        """Remove every Resources link row of one project, returning how many went."""
        if not workspace_id or not project_id:
            return 0
        removed = 0
        while True:
            page = self._query_prefix(workspace_id, project_link_prefix(project_id), limit, None)
            if not page.items:
                return removed
            removed += self._repository.delete_many(
                [{"workspace_id": workspace_id, "planning_key": item["planning_key"]} for item in page.items]
            )

    def delete_project_label(self, workspace_id: str, label_id: str) -> None:
        """Remove one project label row; the projects carrying it are cleared by the caller."""
        if not workspace_id or not label_id:
            return
        self._repository.delete({"workspace_id": workspace_id, "planning_key": project_label_key(label_id)})

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

    def replace_initiative(self, initiative: Initiative, *, keep_import_batch: bool = False) -> Initiative:
        """Write one initiative's fields over an existing row, raising `ConditionFailed` when it is gone.

        The bulk import marker is cleared unless `keep_import_batch` says this is
        the importer's own re-run.
        """
        item = _marked(as_initiative_item(initiative), keep_import_batch)
        stored = self._replace_fields(item, INITIATIVE_OPTIONAL_FIELDS)
        return as_initiative(stored)

    def set_project_initiative(self, workspace_id: str, project_id: str, initiative_id: str | None) -> Project | None:
        """Put one project in an initiative, or take it out with `None`, returning the row as written or `None`.

        A targeted `SET` or `REMOVE`, so the rollup counters the stream consumer
        moves concurrently are never written back stale. The row comes back from
        the write itself, because a read straight after it may not see the change.
        It is a person's change, so it clears the bulk import marker.
        """
        if not workspace_id or not project_id:
            return None
        names = {"#initiative": "initiative_id", "#updated": "updated_at", "#batch": IMPORT_BATCH_ATTRIBUTE}
        values: dict[str, Any] = {":updated": _stored_time(utc_now())}
        if initiative_id is None:
            expression = "SET #updated = :updated REMOVE #initiative, #batch"
        else:
            values[":initiative"] = initiative_id
            expression = "SET #initiative = :initiative, #updated = :updated REMOVE #batch"
        try:
            item = self._repository.update(
                {"workspace_id": workspace_id, "planning_key": project_key(project_id)},
                update_expression=expression,
                expression_names=names,
                expression_values=values,
                condition=Attr("planning_key").exists() & Attr("kind").eq(PROJECT),
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
        return as_project(item) if item is not None else None

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

    def create_pulse_event(self, event: PulseEvent) -> bool:
        """Store a new Pulse event, answering false when its key is already taken."""
        try:
            self._repository.put(as_pulse_event_item(event), condition=Attr("planning_key").not_exists())
        except ConditionFailed:
            return False
        return True

    def get_pulse_event(self, workspace_id: str, event_id: str) -> PulseEvent | None:
        """One Pulse event, or `None`."""
        if not event_id:
            return None
        item = self._get(workspace_id, pulse_key(event_id))
        if item is None or not is_pulse_event(item):
            return None
        return as_pulse_event(item)

    def revise_pulse_event(
        self, workspace_id: str, event_id: str, *, body: str, health: str, edited_at: datetime
    ) -> bool:
        """Carry an edited update's body and health onto its Pulse event, answering whether it was there."""
        if not workspace_id or not event_id:
            return False
        try:
            self._repository.update(
                {"workspace_id": workspace_id, "planning_key": pulse_key(event_id)},
                update_expression="SET #body = :body, #health = :health, #edited = :edited",
                expression_names={"#body": "body", "#health": "health", "#edited": "edited_at"},
                expression_values={":body": body, ":health": health, ":edited": _stored_time(edited_at)},
                condition=Attr("planning_key").exists() & Attr("kind").eq(PULSE_EVENT),
            )
        except ConditionFailed:
            return False
        return True

    def list_pulse_events(
        self,
        workspace_id: str,
        *,
        limit: int,
        start_key: Mapping[str, Any] | None = None,
    ) -> tuple[list[PulseEvent], Mapping[str, Any] | None]:
        """One page of the workspace's Pulse events, newest first, and the key to resume from."""
        if not workspace_id:
            return [], None
        page = self._repository.query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(PULSE_KEY_PREFIX),
            limit=limit,
            start_key=dict(start_key) if start_key else None,
            ascending=False,
        )
        rows = [as_pulse_event(item) for item in page.items if is_pulse_event(item)]
        return rows, page.last_evaluated_key

    def list_pulse_follows(
        self, workspace_id: str, user_id: str, *, max_items: int = 2000
    ) -> dict[tuple[str, str], bool]:
        """One person's explicit follows and unfollows, keyed by subject type and id."""
        if not workspace_id or not user_id:
            return {}
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(pulse_follow_prefix(user_id)),
            max_items=max_items,
        )
        return {
            (str(item.get("subject_type", "")), str(item.get("subject_id", ""))): bool(item.get("following"))
            for item in items
            if str(item.get("kind", "")) == PULSE_FOLLOW
        }

    def get_pulse_follow(self, workspace_id: str, user_id: str, subject_type: str, subject_id: str) -> bool | None:
        """Whether one person explicitly follows one subject, or `None` when they never chose."""
        item = self._get(workspace_id, pulse_follow_key(user_id, subject_type, subject_id))
        if item is None or str(item.get("kind", "")) != PULSE_FOLLOW:
            return None
        return bool(item.get("following"))

    def set_pulse_follow(
        self, workspace_id: str, user_id: str, subject_type: str, subject_id: str, *, following: bool
    ) -> None:
        """Record one person's explicit choice to follow or unfollow one subject."""
        self._repository.put(
            {
                "workspace_id": workspace_id,
                "planning_key": pulse_follow_key(user_id, subject_type, subject_id),
                "kind": PULSE_FOLLOW,
                "user_id": user_id,
                "subject_type": subject_type,
                "subject_id": subject_id,
                "following": following,
                "updated_at": _stored_time(utc_now()),
            }
        )

    def get_pulse_read(self, workspace_id: str, user_id: str) -> datetime | None:
        """When one person last read their Pulse, or `None` when they never have."""
        item = self._get(workspace_id, pulse_read_key(user_id))
        if item is None or str(item.get("kind", "")) != PULSE_READ:
            return None
        try:
            return _DATETIME.validate_python(item.get("read_at"))
        except ValueError:
            return None

    def set_pulse_read(self, workspace_id: str, user_id: str, read_at: datetime) -> None:
        """Record that one person has read their Pulse up to `read_at`."""
        self._repository.put(
            {
                "workspace_id": workspace_id,
                "planning_key": pulse_read_key(user_id),
                "kind": PULSE_READ,
                "user_id": user_id,
                "read_at": _stored_time(read_at),
            }
        )

    def get_cycle_feed(self, workspace_id: str, team_id: str, user_id: str) -> CycleFeed | None:
        """One person's cycle calendar feed for one team, or `None` when they hold none."""
        item = self._get(workspace_id, cycle_feed_key(team_id, user_id))
        if item is None or str(item.get("kind", "")) != CYCLE_FEED:
            return None
        return CycleFeed.model_validate(dict(item))

    def put_cycle_feed(self, feed: CycleFeed) -> CycleFeed:
        """Store one person's feed for one team, replacing and so revoking any earlier token."""
        item = feed.model_dump(mode="json")
        item["planning_key"] = cycle_feed_key(feed.team_id, feed.user_id)
        item["kind"] = CYCLE_FEED
        self._repository.put(item)
        return feed

    def delete_cycle_feed(self, workspace_id: str, team_id: str, user_id: str) -> bool:
        """Revoke one person's feed for one team, reporting whether one was there."""
        return self.delete(workspace_id, cycle_feed_key(team_id, user_id))

    def claim_milestone_completion(self, workspace_id: str, project_id: str, milestone_id: str) -> bool:
        """Mark a milestone's completion as posted to Pulse, answering false when it already was or is gone."""
        try:
            self._repository.update(
                {"workspace_id": workspace_id, "planning_key": milestone_key(project_id, milestone_id)},
                update_expression="SET #done = :now",
                expression_names={"#done": MILESTONE_COMPLETED_ATTRIBUTE},
                expression_values={":now": _stored_time(utc_now())},
                condition=Attr("planning_key").exists()
                & Attr("kind").eq(MILESTONE)
                & Attr(MILESTONE_COMPLETED_ATTRIBUTE).not_exists(),
            )
        except ConditionFailed:
            return False
        return True

    def clear_milestone_completion(self, workspace_id: str, project_id: str, milestone_id: str) -> bool:
        """Forget a reopened milestone's completion, so completing it again posts again."""
        try:
            self._repository.update(
                {"workspace_id": workspace_id, "planning_key": milestone_key(project_id, milestone_id)},
                update_expression="REMOVE #done",
                expression_names={"#done": MILESTONE_COMPLETED_ATTRIBUTE},
                condition=Attr(MILESTONE_COMPLETED_ATTRIBUTE).exists(),
            )
        except ConditionFailed:
            return False
        return True

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

    def replace_cycle(self, cycle: Cycle, *, keep_import_batch: bool = False) -> Cycle:
        """Write one cycle's fields over an existing row, recomputing its index attributes.

        Every attribute but the counters is set from the finished model, so the
        roadmap's range value derived from `end_date` never goes stale, while the
        counters and the rollup revision stay what the consumer last wrote rather
        than what the caller read. Raises `ConditionFailed` when the row is gone.
        The bulk import marker is cleared unless `keep_import_batch` says this is
        the importer's own re-run.
        """
        stored = self._replace_fields(_marked(as_cycle_item(cycle), keep_import_batch), (IMPORT_BATCH_ATTRIBUTE,))
        return as_cycle(stored)

    def replace_project(self, project: Project, *, keep_import_batch: bool = False) -> Project:
        """Write one project's fields over an existing row, its stored counters kept.

        A cleared optional field is removed rather than written as a null, so an
        undated project really does leave the sparse index. Raises
        `ConditionFailed` when the row is gone. The bulk import marker is cleared
        unless `keep_import_batch` says this is the importer's own re-run.
        """
        stored = self._replace_fields(_marked(as_project_item(project), keep_import_batch), PROJECT_OPTIONAL_FIELDS)
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

    def set_counts(
        self,
        workspace_id: str,
        planning_key: str,
        counts: Mapping[str, int],
        status_counts: Mapping[str, int] | None = None,
    ) -> bool:
        """Write one project's or milestone's issue counts as recounted, returning whether the row was there.

        The point buckets are written only when the caller passes them, and so is
        `status_counts`, the count per status id, which replaces the stored map
        whole because a status no issue sits in any more must drop out. A `SET` of
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
        buckets = [
            bucket
            for bucket in (*COUNT_BUCKETS, *POINT_BUCKETS, ESTIMATING_TEAMS)
            if bucket in counts or bucket in COUNT_BUCKETS
        ]
        for index, bucket in enumerate(buckets):
            names[f"#b{index}"] = bucket
            values[f":v{index}"] = max(0, int(counts.get(bucket, 0)))
            clauses.append(f"#counts.#b{index} = :v{index}")
        if status_counts is not None:
            names["#sc"] = "status_counts"
            values[":sc"] = {key: int(value) for key, value in status_counts.items() if value > 0}
            clauses.append("#sc = :sc")
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

    def read_cycle_counters(self, workspace_id: str, planning_key: str) -> tuple[dict[str, int], int] | None:
        """One cycle's raw `counts` map and rollup revision, unfloored, or `None` when the row is gone."""
        item = self._get(workspace_id, planning_key)
        if item is None:
            return None
        values = item.get("counts")
        source: Mapping[str, Any] = values if isinstance(values, Mapping) else {}
        return {str(key): int(value or 0) for key, value in source.items()}, int(item.get("rollup_rev", 0) or 0)

    def set_cycle_counts(
        self, workspace_id: str, planning_key: str, counts: Mapping[str, int], *, rev: int
    ) -> Mapping[str, Any] | None:
        """Write one cycle's recounted issue, point and unestimated buckets, returning the row after.

        Conditional on the rollup revision still being `rev`, so a counter move
        that landed after the caller read the row is never overwritten; the
        revision is bumped so the snapshot that follows orders after it. The carry
        counters are left alone. `None` when the row is gone or moved on.
        """
        wanted = {bucket: value for bucket, value in counts.items() if bucket in CYCLE_RECOUNT_KEYS}
        if not workspace_id or not planning_key or not wanted:
            return None
        names: dict[str, str] = {"#counts": "counts", "#rev": "rollup_rev"}
        values: dict[str, Any] = {":next": rev + 1}
        clauses: list[str] = ["#rev = :next"]
        for index, (bucket, value) in enumerate(sorted(wanted.items())):
            names[f"#b{index}"] = bucket
            values[f":v{index}"] = int(value)
            clauses.append(f"#counts.#b{index} = :v{index}")
        held = Attr("rollup_rev").eq(rev)
        if rev == 0:
            held = held | Attr("rollup_rev").not_exists()
        try:
            item = self._repository.update(
                {"workspace_id": workspace_id, "planning_key": planning_key},
                update_expression="SET " + ", ".join(clauses),
                expression_names=names,
                expression_values=values,
                condition=Attr("planning_key").exists() & Attr("counts").exists() & held,
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
        return item if item is not None else {}

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

    def write_project_snapshot(
        self,
        workspace_id: str,
        project_id: str,
        day: str,
        *,
        counts: Mapping[str, Any],
        opening: Mapping[str, Any],
    ) -> bool:
        """Record one project's recounted counters as the day's latest value, returning whether it landed.

        Unconditional on order, because each write is a whole recount rather than a
        move, so the next recount heals a write that landed out of turn. `opening`
        is written only by the first snapshot a day row ever gets.
        """
        if not workspace_id or not project_id or not day:
            return False
        self._repository.update(
            {"workspace_id": workspace_id, "planning_key": project_history_key(project_id, day)},
            update_expression=(
                "SET #counts = :counts, #kind = :kind, #project = :project, #day = :day, "
                "#opening = if_not_exists(#opening, :opening)"
            ),
            expression_names={
                "#counts": "counts",
                "#kind": "kind",
                "#project": "project_id",
                "#day": "day",
                "#opening": "opening",
            },
            expression_values={
                ":counts": {key: int(value or 0) for key, value in counts.items()},
                ":kind": PROJECT_HISTORY,
                ":project": project_id,
                ":day": day,
                ":opening": {key: int(value or 0) for key, value in opening.items()},
            },
        )
        return True

    def list_project_history(
        self, workspace_id: str, project_id: str, *, max_items: int = 1200
    ) -> list[ProjectSnapshot]:
        """Every daily snapshot of one project, oldest day first, one query on its own prefix."""
        if not workspace_id or not project_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(project_history_prefix(project_id)),
            max_items=max_items,
        )
        rows = [ProjectSnapshot.from_item(item) for item in items if str(item.get("kind", "")) == PROJECT_HISTORY]
        return sorted(rows, key=lambda row: row.day)

    def delete_project_history(self, workspace_id: str, project_id: str, *, limit: int = 100) -> int:
        """Remove every daily snapshot of one project, returning how many went."""
        if not workspace_id or not project_id:
            return 0
        removed = 0
        while True:
            page = self._query_prefix(workspace_id, project_history_prefix(project_id), limit, None)
            if not page.items:
                return removed
            removed += self._repository.delete_many(
                [{"workspace_id": workspace_id, "planning_key": item["planning_key"]} for item in page.items]
            )

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
        items = self._repository.iter_scan(
            index_name=TARGET_DATE_INDEX,
            filter_expression=Attr("target_date").between(since, until) & Attr("kind").eq(CYCLE),
            page_size=page_size,
        )
        found = [as_cycle(item) for item in items if is_cycle(item)]
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
            page = self._query_prefix(workspace_id, cycle_feed_prefix(team_id), limit, None)
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
