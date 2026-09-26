"""The `planning` table: a team's cycles and the workspace's projects, in one partition.

Both entities share the workspace partition and are told apart by their sort key
prefix. A cycle is filed under its team, so "this team's cycles" is one query. A
project spans one or more teams, so it is filed under the workspace alone and
"the workspace's projects" is one query; its teams are an attribute of the row.

Neither entity is ever written by the rollup path in the way a counter is. The
counters live on these rows and move through an atomic `ADD`, because a record
arriving on one shard must not lose a count to a read-modify-write racing another.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Page, Repository, new_ulid

from app.common.db.dynamo.base import build_repository, utc_now
from app.common.db.dynamo.tables import PLANNING

TARGET_DATE_INDEX = "ws_team-target_date-index"

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


def cycle_prefix(team_id: str) -> str:
    """The sort key prefix every cycle of one team shares."""
    return f"team#{team_id}#cycle#"


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

    @classmethod
    def from_item(cls, item: Mapping[str, Any]) -> "RollupCounts":
        """The counters off one stored row, each floored at zero.

        A counter can go negative when a decrement outlives its matching increment,
        which is the price of the atomic `ADD` that keeps two shards from losing a
        count; the floor is applied on read so a reader never sees it.
        """
        values = item.get("counts")
        source: Mapping[str, Any] = values if isinstance(values, Mapping) else {}
        return cls(**{bucket: max(0, int(source.get(bucket, 0) or 0)) for bucket in COUNT_BUCKETS})


class Cycle(BaseModel):
    """One time box of a team: its dates, its goal and its counters."""

    workspace_id: str
    planning_key: str
    cycle_id: str = Field(default_factory=new_planning_id)
    team_id: str
    kind: str = CYCLE
    name: str
    start_date: str
    end_date: str
    goal: str | None = None
    cancelled: bool = False
    counts: RollupCounts = Field(default_factory=RollupCounts)
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    def status(self, today: str | None = None) -> str:
        """This cycle's derived status, from its dates and its cancellation flag."""
        return derive_cycle_status(self.start_date, self.end_date, self.cancelled, today)


class Project(BaseModel):
    """One time-bound body of work across one or more teams.

    `team_ids` is ordered and never empty: the first entry is the team a
    single-team reader treats as the project's own. Visibility is decided per
    caller against the whole list, so the row itself stays team agnostic.
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
    counts: RollupCounts = Field(default_factory=RollupCounts)
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


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
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


def as_cycle_item(cycle: Cycle) -> dict[str, Any]:
    """One cycle as the stored item, carrying its roadmap index attributes.

    The cycle's `end_date` is what the roadmap draws it at, so that is what goes into
    the index's range attribute; a cycle is always dated, so it is always indexed.
    """
    item = cycle.model_dump(mode="json")
    item["ws_team"] = ws_team(cycle.workspace_id, cycle.team_id)
    item["target_date"] = cycle.end_date
    return item


def as_project_item(project: Project) -> dict[str, Any]:
    """One project as the stored item, outside the roadmap index.

    No `ws_team` is written, so a project never enters `ws_team-target_date-index`:
    it belongs to several teams and no single team partition could hold it. Null
    optional fields are dropped rather than stored, so a cleared date leaves no
    attribute behind.
    """
    item = project.model_dump(mode="json")
    for name in ("target_date", "start_date", "lead_id", "description"):
        if item.get(name) is None:
            item.pop(name, None)
    return item


def as_milestone_item(milestone: ProjectMilestone) -> dict[str, Any]:
    """One milestone as the stored item, null optional fields dropped."""
    item = milestone.model_dump(mode="json")
    for name in ("target_date", "description"):
        if item.get(name) is None:
            item.pop(name, None)
    return item


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
    return Cycle.model_validate(fields)


def as_project(item: Mapping[str, Any]) -> Project:
    """One stored item as a `Project`, ignoring the index composites.

    A legacy status name is read as its current equivalent, so a row written
    before the status set grew still validates against the response schema.
    """
    fields = {key: value for key, value in item.items() if key not in INDEX_ATTRIBUTE_NAMES}
    fields["counts"] = RollupCounts.from_item(item)
    fields["status"] = normalise_project_status(str(item.get("status", "backlog")))
    return Project.model_validate(fields)


def as_milestone(item: Mapping[str, Any]) -> ProjectMilestone:
    """One stored item as a `ProjectMilestone`, its counters floored at zero."""
    fields = {key: value for key, value in item.items() if key not in INDEX_ATTRIBUTE_NAMES}
    fields["counts"] = RollupCounts.from_item(item)
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


class PlanningRepository:
    """Reads and writes `planning` rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(PLANNING, repository)

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
        """Write one milestone over an existing row, its counters carried along."""
        self._repository.put(as_milestone_item(milestone), condition=Attr("planning_key").exists())
        return milestone

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
        """Write one cycle over an existing row, recomputing its index attributes.

        A patch goes through a whole-item put rather than an update expression
        because the roadmap's range value is derived from `end_date`, and rebuilding
        it from the finished model is what keeps the index from going stale. The
        counters are carried along from the model the caller read, which is why a
        patch reads the row first.
        """
        self._repository.put(as_cycle_item(cycle), condition=Attr("planning_key").exists())
        return cycle

    def replace_project(self, project: Project) -> Project:
        """Write one project over an existing row, recomputing its index attributes.

        Clearing `target_date` has to remove the attribute rather than write a null,
        which a whole-item put does and a `SET ... = :null` would not, so an undated
        project really does leave the sparse index.
        """
        self._repository.put(as_project_item(project), condition=Attr("planning_key").exists())
        return project

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
        wanted = {bucket: delta for bucket, delta in deltas.items() if bucket in COUNT_BUCKETS and delta}
        if not workspace_id or not planning_key or not wanted:
            return False

        names: dict[str, str] = {"#counts": "counts"}
        values: dict[str, Any] = {}
        clauses: list[str] = []
        for index, (bucket, delta) in enumerate(sorted(wanted.items())):
            names[f"#b{index}"] = bucket
            values[f":d{index}"] = delta
            clauses.append(f"#counts.#b{index} :d{index}")

        try:
            self._repository.update(
                {"workspace_id": workspace_id, "planning_key": planning_key},
                update_expression="ADD " + ", ".join(clauses),
                expression_names=names,
                expression_values=values,
                condition=Attr("planning_key").exists() & Attr("counts").exists(),
            )
        except ConditionFailed:
            return False
        return True

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
        team's cycle prefix goes, whatever its kind, because nothing else is filed
        under a deleted team's prefix.
        """
        page = self._query_prefix(workspace_id, cycle_prefix(team_id), limit, None)
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
