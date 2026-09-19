"""The `planning` table: a project's cycles and milestones, in one partition.

Both entities share the workspace partition and are told apart by their sort key
prefix, which keeps "this project's cycles" and "this project's milestones" each
one query rather than a partition read with a filter behind it.

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

TARGET_DATE_INDEX = "ws_project-target_date-index"

CYCLE = "cycle"

MILESTONE = "milestone"

MilestoneStatus = Literal["planned", "in_progress", "done"]

MILESTONE_STATUSES: tuple[str, ...] = ("planned", "in_progress", "done")

CycleStatus = Literal["upcoming", "active", "completed", "cancelled"]

CYCLE_STATUSES: tuple[str, ...] = ("upcoming", "active", "completed", "cancelled")

COUNT_BUCKETS: tuple[str, ...] = ("todo", "in_progress", "done", "cancelled")
"""The four buckets a rollup counts into, folded from the project's five categories.

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
    """A fresh cycle or milestone id, time sortable so a listing reads in creation order."""
    return new_ulid()


def cycle_key(project_id: str, cycle_id: str) -> str:
    """The sort key of one cycle."""
    return f"project#{project_id}#cycle#{cycle_id}"


def milestone_key(project_id: str, milestone_id: str) -> str:
    """The sort key of one milestone."""
    return f"project#{project_id}#milestone#{milestone_id}"


def cycle_prefix(project_id: str) -> str:
    """The sort key prefix every cycle of one project shares."""
    return f"project#{project_id}#cycle#"


def milestone_prefix(project_id: str) -> str:
    """The sort key prefix every milestone of one project shares."""
    return f"project#{project_id}#milestone#"


def planning_key_for(kind: str, project_id: str, entity_id: str) -> str:
    """The sort key one planning row takes, from its kind."""
    if kind == CYCLE:
        return cycle_key(project_id, entity_id)
    return milestone_key(project_id, entity_id)


def ws_project(workspace_id: str, project_id: str) -> str:
    """The roadmap index's hash key, one partition per project of a workspace."""
    return f"{workspace_id}#{project_id}"


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
    """How many of a cycle's or a milestone's issues sit in each bucket.

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
    """One time box of a project: its dates, its goal and its counters."""

    workspace_id: str
    planning_key: str
    cycle_id: str = Field(default_factory=new_planning_id)
    project_id: str
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


class Milestone(BaseModel):
    """One dated goal of a project: its target, its status and its counters."""

    workspace_id: str
    planning_key: str
    milestone_id: str = Field(default_factory=new_planning_id)
    project_id: str
    kind: str = MILESTONE
    name: str
    description: str | None = None
    target_date: str | None = None
    status: str = "planned"
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
    item["ws_project"] = ws_project(cycle.workspace_id, cycle.project_id)
    item["target_date"] = cycle.end_date
    return item


def as_milestone_item(milestone: Milestone) -> dict[str, Any]:
    """One milestone as the stored item, indexed only when it carries a target date.

    An undated milestone writes no `target_date` attribute at all, which leaves it
    out of the sparse index rather than sorting it under an empty string ahead of
    everything real.
    """
    item = milestone.model_dump(mode="json")
    item["ws_project"] = ws_project(milestone.workspace_id, milestone.project_id)
    if not milestone.target_date:
        item.pop("target_date", None)
    return item


INDEX_ATTRIBUTE_NAMES: tuple[str, ...] = ("ws_project",)
"""The denormalised composites a read strips back off a stored row.

`target_date` is not stripped: it is a milestone's own field, and for a cycle it is
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


def as_milestone(item: Mapping[str, Any]) -> Milestone:
    """One stored item as a `Milestone`, ignoring the index composites."""
    fields = {key: value for key, value in item.items() if key not in INDEX_ATTRIBUTE_NAMES}
    fields["counts"] = RollupCounts.from_item(item)
    return Milestone.model_validate(fields)


def is_cycle(item: Mapping[str, Any]) -> bool:
    """Whether one stored row is a cycle rather than a milestone.

    Read off the row's own `kind` rather than parsed back out of the sort key, so a
    key format change does not silently reclassify every row.
    """
    return str(item.get("kind", "")) == CYCLE


class PlanningRepository:
    """Reads and writes `planning` rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(PLANNING, repository)

    def get_cycle(self, workspace_id: str, project_id: str, cycle_id: str) -> Cycle | None:
        """One cycle of one project, or `None`.

        The project is a parameter rather than something looked up, because the sort
        key carries it: a caller that guesses a cycle id without its project reads
        nothing rather than another project's row.
        """
        item = self._get(workspace_id, cycle_key(project_id, cycle_id))
        if item is None or not is_cycle(item):
            return None
        return as_cycle(item)

    def get_milestone(self, workspace_id: str, project_id: str, milestone_id: str) -> Milestone | None:
        """One milestone of one project, or `None`."""
        item = self._get(workspace_id, milestone_key(project_id, milestone_id))
        if item is None or is_cycle(item):
            return None
        return as_milestone(item)

    def _get(self, workspace_id: str, planning_key: str) -> Mapping[str, Any] | None:
        """One stored row by its full sort key, or `None`."""
        if not workspace_id or not planning_key:
            return None
        return self._repository.get({"workspace_id": workspace_id, "planning_key": planning_key})

    def create_cycle(self, cycle: Cycle) -> Cycle:
        """Store a new cycle, raising `ConditionFailed` when the key is taken."""
        self._repository.put(as_cycle_item(cycle), condition=Attr("planning_key").not_exists())
        return cycle

    def create_milestone(self, milestone: Milestone) -> Milestone:
        """Store a new milestone, raising `ConditionFailed` when the key is taken."""
        self._repository.put(as_milestone_item(milestone), condition=Attr("planning_key").not_exists())
        return milestone

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

    def replace_milestone(self, milestone: Milestone) -> Milestone:
        """Write one milestone over an existing row, recomputing its index attributes.

        Clearing `target_date` has to remove the attribute rather than write a null,
        which a whole-item put does and a `SET ... = :null` would not, so an undated
        milestone really does leave the sparse index.
        """
        self._repository.put(as_milestone_item(milestone), condition=Attr("planning_key").exists())
        return milestone

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
        project_id: str,
        *,
        limit: int = 100,
        start_key: Mapping[str, Any] | None = None,
    ) -> tuple[list[Cycle], Mapping[str, Any] | None]:
        """One page of a project's cycles, by start date ascending.

        The table's own sort key orders by cycle id rather than by date, so the page
        is sorted after the read. That is honest for a project's cycles, which are a
        bounded set a team plans by hand rather than an unbounded feed.
        """
        page = self._query_prefix(workspace_id, cycle_prefix(project_id), limit, start_key)
        rows = [as_cycle(item) for item in page.items if is_cycle(item)]
        return sorted(rows, key=lambda row: (row.start_date, row.cycle_id)), page.last_evaluated_key

    def list_milestones(
        self,
        workspace_id: str,
        project_id: str,
        *,
        limit: int = 100,
        start_key: Mapping[str, Any] | None = None,
    ) -> tuple[list[Milestone], Mapping[str, Any] | None]:
        """One page of a project's milestones, by target date ascending, undated last."""
        page = self._query_prefix(workspace_id, milestone_prefix(project_id), limit, start_key)
        rows = [as_milestone(item) for item in page.items if not is_cycle(item)]
        ordered = sorted(rows, key=lambda row: (row.target_date is None, row.target_date or "", row.milestone_id))
        return ordered, page.last_evaluated_key

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

    def list_for_roadmap(self, workspace_id: str, project_id: str, *, max_items: int = 500) -> list[Mapping[str, Any]]:
        """Every dated planning row of one project, by date ascending.

        Reads `ws_project-target_date-index`, which is the one index ordering cycles
        and milestones together on the one date a roadmap draws them at. Undated
        milestones are outside the index by construction, so the roadmap route reads
        those from the project's own partition and appends them.
        """
        if not workspace_id or not project_id:
            return []
        return list(
            self._repository.iter_query(
                Key("ws_project").eq(ws_project(workspace_id, project_id)),
                index_name=TARGET_DATE_INDEX,
                max_items=max_items,
            )
        )

    def list_undated_milestones(self, workspace_id: str, project_id: str, *, max_items: int = 200) -> list[Milestone]:
        """Every milestone of one project with no target date, in creation order.

        Read from the partition rather than the index because that is exactly where
        an undated milestone is: leaving the index sparse is what keeps a dated
        roadmap query from paging through undated rows first.
        """
        if not workspace_id or not project_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(milestone_prefix(project_id)),
            max_items=max_items,
        )
        rows = [as_milestone(item) for item in items if not is_cycle(item) and not item.get("target_date")]
        return sorted(rows, key=lambda row: row.milestone_id)
