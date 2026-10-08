"""The `issues` table: the content every other domain hangs off.

Issues are workspace scoped rather than team scoped so a link and a "my issues"
read can cross teams without a second write path. The team is a field, and
the index composites carry it, which is what keeps a team-filtered query one
partition read while leaving the fan-out possible.

Five composite attributes are denormalised onto every row, each one the hash key of
an index design section 3 fixes. They are recomputed on every write from the fields
they are built out of, so a row cannot end up indexed under a stale team, status
or parent. A null-valued composite is left off the item entirely, which leaves the
index sparse: an unassigned issue costs nothing in `ws_assignee-updated_at-index`.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Callable, Literal, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field, PrivateAttr, TypeAdapter
from webbpulse.dynamodb import ConditionFailed, Page, Repository, new_ulid, read_all_pages

from app.common.db.dynamo.base import build_repository, delete_partition, utc_now
from app.common.db.dynamo.tables import ISSUES

STATUS_UPDATED_INDEX = "ws_team-status_updated-index"

KEY_NUMBER_INDEX = "ws_team-key_number-index"

TEAM_READ_PAGE = 500
"""The page size of a team walk: large enough that a typical team is one query."""

ASSIGNEE_UPDATED_INDEX = "ws_assignee-updated_at-index"

PARENT_CREATED_INDEX = "ws_parent-created_at-index"

CREATOR_INDEX = "created_by-workspace_id-index"

PROJECT_INDEX = "ws_team-project_id-index"
CYCLE_INDEX = "ws_team-cycle_id-index"

CHANGED_INDEX = "ws_team-changed_at-index"

CHANGED_AT = "changed_at"
"""The stamp every write moves, which the change feed index is ranged on.

Kept off the `Issue` model because it is bookkeeping for the list delta rather
than a field of the issue, and a reader never has to reason about two clocks.
"""

REVISION = "revision"
"""The counter every write to a user-owned field moves, which `replace` is conditioned on.

Kept off the `Issue` model's fields for the same reason as `changed_at`; the value
an issue was read with rides along as a private attribute instead, so a copy made
for a patch carries it into the write without any caller passing it.
"""

CONSUMER_OWNED_ATTRIBUTES: tuple[str, ...] = ("progress", "blocked_by_open_count")
"""Attributes only the rollup consumer writes, which `replace` never puts back.

A patch built from a read taken before a rollup landed would otherwise restore
the stale counts.
"""

REPLACE_REMOVABLE_ATTRIBUTES: tuple[str, ...] = (
    "ws_assignee",
    "ws_parent",
    "cycle_id",
    "project_id",
    "cycle_carried_from",
    "archived_at",
    "in_triage",
    "snoozed_until",
    "sla_started_at",
    "sla_breaches_at",
)
"""Attributes `as_issue_item` leaves off when empty, so `replace` removes them instead."""

REPLACE_ATTEMPTS = 3

REVISION_STEP: dict[str, int] = {":one": 1, ":zero": 0}
"""The expression values `REVISION_BUMP` reads."""

REVISION_BUMP = "#rev = if_not_exists(#rev, :zero) + :one"
"""The `SET` clause every write to a user-owned field carries, so a stale `replace` is refused."""


class IssueWriteConflict(ConditionFailed):
    """The issue was written by someone else after it was read, so this write was refused.

    A subclass of `ConditionFailed` so a caller that already maps a failed
    condition keeps working, while one that wants to answer 409 or retry can
    catch this first.
    """


Priority = Literal["none", "urgent", "high", "medium", "low"]

PRIORITIES: tuple[str, ...] = ("none", "urgent", "high", "medium", "low")

_DATETIME: TypeAdapter[datetime] = TypeAdapter(datetime)

PRIORITY_ORDER: dict[str, int] = {"urgent": 0, "high": 1, "medium": 2, "low": 3, "none": 4}
"""Descending priority as the contract means it: urgent first, none last.

A sort has to be total, so `none` sorts last rather than being dropped, and the
rank is written down once here instead of at each comparison.
"""


def new_issue_id() -> str:
    """A fresh issue id, time sortable so a scan of a partition reads in creation order."""
    return new_ulid()


def ws_team(workspace_id: str, team_id: str) -> str:
    """The hash key every team-scoped index shares."""
    return f"{workspace_id}#{team_id}"


def ws_team_status(workspace_id: str, team_id: str, status_id: str) -> str:
    """The board column's hash key, one partition per status of a team.

    Composite on the status rather than the team alone, because a busy team's
    board would otherwise concentrate every read on one partition.
    """
    return f"{workspace_id}#{team_id}#{status_id}"


ARCHIVED_SUFFIX = "#archived"


def archived_ws_team_status(workspace_id: str, team_id: str, status_id: str) -> str:
    """The status composite an archived issue carries instead of its live column's.

    Moving an archived issue to its own partition keeps every board column and
    the auto-archive sweep's status reads free of archived rows, without a new
    index or a filter that would still pay for the rows it drops.
    """
    return f"{ws_team_status(workspace_id, team_id, status_id)}{ARCHIVED_SUFFIX}"


TRIAGE_SUFFIX = "triage"


def triage_ws_team_status(workspace_id: str, team_id: str) -> str:
    """The status composite every live issue awaiting triage in one team carries.

    One partition per team rather than per status, so the triage inbox is one key
    read and no board column ever sees an issue nobody has accepted yet.
    """
    return f"{ws_team(workspace_id, team_id)}#{TRIAGE_SUFFIX}"


def status_partition_key(issue: Issue, status_id: str) -> str:
    """The status composite one issue belongs under: archived, triage or its live column."""
    if issue.archived_at is not None:
        return archived_ws_team_status(issue.workspace_id, issue.team_id, status_id)
    if issue.in_triage:
        return triage_ws_team_status(issue.workspace_id, issue.team_id)
    return ws_team_status(issue.workspace_id, issue.team_id, status_id)


def ws_assignee(workspace_id: str, assignee_id: str) -> str:
    """The "my issues" hash key, scoped to one workspace."""
    return f"{workspace_id}#{assignee_id}"


def ws_parent(workspace_id: str, parent_id: str) -> str:
    """The sub-issue listing hash key, which the rollup consumer recounts from."""
    return f"{workspace_id}#{parent_id}"


def issue_key(key_prefix: str, number: int) -> str:
    """The human key `ABC-123`, denormalised onto the issue at create time."""
    return f"{key_prefix.upper()}-{number}"


class Progress(BaseModel):
    """How many direct children an issue has, and how many are finished.

    Maintained by the rollup consumer rather than the request path, so a parent's
    counts never depend on a child write having read its parent first.
    """

    total: int = 0
    completed: int = 0


class Issue(BaseModel):
    """One issue: the row every index composite is derived from."""

    workspace_id: str
    issue_id: str = Field(default_factory=new_issue_id)
    team_id: str
    key: str
    number: int
    title: str
    body: str | None = None
    status_id: str
    priority: str = "none"
    assignee_id: str | None = None
    label_ids: list[str] = Field(default_factory=list)
    estimate: str | None = None
    start_date: str | None = None
    due_date: str | None = None
    parent_id: str | None = None
    cycle_id: str | None = None
    cycle_carried_from: str | None = None
    project_id: str | None = None
    project_milestone_id: str | None = None
    sort_order: str | None = None
    progress: Progress = Field(default_factory=Progress)
    blocked_by_open_count: int = 0
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    updated_by: str | None = None
    updated_source: str | None = None
    mentioned_user_ids: list[str] = Field(default_factory=list)
    archived_at: datetime | None = None
    in_triage: bool = False
    snoozed_until: datetime | None = None
    sla_started_at: datetime | None = None
    sla_breaches_at: datetime | None = None

    _revision: int | None = PrivateAttr(default=None)

    def read_revision(self) -> int | None:
        """The stored revision this issue was read at, or `None` when it was built rather than read."""
        return self._revision

    def at_revision(self, revision: int | None) -> Issue:
        """Stamp the stored revision this issue stands at, answering the issue itself."""
        self._revision = revision
        return self


def index_attributes(issue: Issue, status_id: str) -> dict[str, Any]:
    """The index composites for one issue, omitting every null-valued one.

    `status_id` is passed rather than read off the issue so a caller updating the
    status computes the composite from the value it is about to write, not from the
    one still on the row.
    """
    attributes: dict[str, Any] = {
        "ws_team": ws_team(issue.workspace_id, issue.team_id),
        "ws_team_status": status_partition_key(issue, status_id),
    }
    if issue.assignee_id:
        attributes["ws_assignee"] = ws_assignee(issue.workspace_id, issue.assignee_id)
    if issue.parent_id:
        attributes["ws_parent"] = ws_parent(issue.workspace_id, issue.parent_id)
    return attributes


INDEX_ATTRIBUTE_NAMES: tuple[str, ...] = (
    "ws_team",
    "ws_team_status",
    "ws_assignee",
    "ws_parent",
)
"""Every denormalised composite, so a read can strip them back off the row."""

ATTACHMENT_ATTRIBUTE_NAMES: tuple[str, ...] = ("cycle_id", "project_id")
"""The planning attachments that index an issue into `ws_team-<id>-index`.

Both indexes are sparse, so an unattached issue has to write no attribute at all
rather than a null: a row carrying `cycle_id: null` would still be indexed, and the
planning read would then have to filter out every issue in the team.
"""


SLA_FIELDS: tuple[str, ...] = ("sla_started_at", "sla_breaches_at")
"""The SLA timer fields, left off a row without an SLA so the sweep's filter skips it."""


def serialize_datetime(value: datetime) -> str:
    """One datetime as the stored string, the same form `model_dump(mode="json")` writes.

    A key condition compares strings, so a cutoff has to be rendered exactly the
    way `updated_at` was, or the comparison would order by format rather than time.
    """
    return str(_DATETIME.dump_python(value, mode="json"))


def as_issue_item(issue: Issue) -> dict[str, Any]:
    """One issue as the stored item, carrying its index composites.

    Written through this rather than the shared `as_item` because the composites
    depend on the issue's own fields and dropping one would silently unindex a row.
    """
    item = issue.model_dump(mode="json")
    item.update(index_attributes(issue, issue.status_id))
    optional = (*ATTACHMENT_ATTRIBUTE_NAMES, "cycle_carried_from", "archived_at", "in_triage", "snoozed_until")
    for attachment in (*optional, *SLA_FIELDS):
        if not item.get(attachment):
            item.pop(attachment, None)
    item[CHANGED_AT] = changed_stamp()
    return item


def changed_stamp() -> str:
    """The `changed_at` value a write made now carries, in the stored datetime form."""
    return serialize_datetime(utc_now())


def changed_bound(since: datetime) -> str:
    """`since` as a lower bound on `changed_at`, always with microseconds and in UTC.

    Stored stamps drop the fraction when it is zero, and `.` sorts before `Z`, so a
    bound without a fraction would sort after rows written later in the same
    second. A fixed width bound can only let such a row in twice, never drop it.
    """
    moment = since if since.tzinfo is not None else since.replace(tzinfo=UTC)
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def as_issue(item: Mapping[str, Any]) -> Issue:
    """One stored item as an `Issue`, ignoring the index composites.

    `number` comes back as a `Decimal` from a numeric attribute, which pydantic
    coerces to `int`, so the model stays the one shape the routes see.
    """
    fields = {
        key: value
        for key, value in item.items()
        if key not in INDEX_ATTRIBUTE_NAMES and key not in (CHANGED_AT, REVISION)
    }
    return Issue.model_validate(fields).at_revision(int(item.get(REVISION) or 0))


class IssueRepository:
    """Reads and writes `issues` rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(ISSUES, repository)

    def delete_workspace_rows(self, workspace_id: str) -> int:
        """Delete every row this table holds for one workspace, for the workspace purge."""
        return delete_partition(self._repository, ISSUES, workspace_id)

    def get(self, workspace_id: str, issue_id: str) -> Issue | None:
        """One issue of this workspace, or `None`."""
        if not workspace_id or not issue_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "issue_id": issue_id})
        return as_issue(item) if item is not None else None

    def get_many(self, workspace_id: str, issue_ids: list[str]) -> dict[str, Issue]:
        """The named issues keyed by id, skipping any that are gone.

        One `BatchGetItem` behind the links list, so rendering a pair's titles costs
        one call rather than one per link row.
        """
        wanted = [issue_id for issue_id in dict.fromkeys(issue_ids) if issue_id]
        if not workspace_id or not wanted:
            return {}
        items = self._repository.batch_get(
            [{"workspace_id": workspace_id, "issue_id": issue_id} for issue_id in wanted]
        )
        return {str(item["issue_id"]): as_issue(item) for item in items}

    def create(self, issue: Issue) -> Issue:
        """Store a new issue, raising `ConditionFailed` when the id is taken.

        The key was already allocated by the counter, so a collision here is an id
        reuse rather than a lost race, and it must never overwrite the other row.
        """
        self._repository.put(as_issue_item(issue), condition=Attr("issue_id").not_exists())
        return issue

    def replace(self, issue: Issue, *, condition: Any = None) -> Issue:
        """Write one issue over an existing row, recomputing its index composites.

        Every field and composite is rebuilt from the finished model so the
        composites stay consistent, but through an `UpdateItem` rather than a put,
        so the rollup counts in `CONSUMER_OWNED_ATTRIBUTES` are never written back
        stale. An issue that was read carries the revision it was read at, and
        the write is conditioned on the row still holding it; a write landing in
        between raises `IssueWriteConflict` rather than being silently reverted.
        `condition` is ANDed on, and a miss of it or of the existence check raises
        `ConditionFailed`.
        """
        item = as_issue_item(issue)
        for attribute in ("workspace_id", "issue_id", *CONSUMER_OWNED_ATTRIBUTES):
            item.pop(attribute, None)
        read_at = issue.read_revision()
        guard = Attr("issue_id").exists()
        if read_at is not None:
            if read_at:
                guard = guard & Attr(REVISION).eq(read_at)
            else:
                guard = guard & (Attr(REVISION).not_exists() | Attr(REVISION).eq(0))
        if condition is not None:
            guard = guard & condition
        names: dict[str, str] = {}
        values: dict[str, Any] = {}
        sets: list[str] = []
        for index, (attribute, value) in enumerate(item.items()):
            names[f"#a{index}"] = attribute
            values[f":a{index}"] = value
            sets.append(f"#a{index} = :a{index}")
        names["#rev"] = REVISION
        values.update(REVISION_STEP)
        sets.append(REVISION_BUMP)
        removes: list[str] = []
        for index, attribute in enumerate(name for name in REPLACE_REMOVABLE_ATTRIBUTES if name not in item):
            names[f"#r{index}"] = attribute
            removes.append(f"#r{index}")
        expression = "SET " + ", ".join(sets)
        if removes:
            expression += " REMOVE " + ", ".join(removes)
        key = {"workspace_id": issue.workspace_id, "issue_id": issue.issue_id}
        try:
            stored = self._repository.update(
                key,
                update_expression=expression,
                expression_names=names,
                expression_values=values,
                condition=guard,
                return_values="ALL_NEW",
            )
        except ConditionFailed as exc:
            if read_at is not None and self._moved_on(issue, read_at):
                raise IssueWriteConflict(exc.table, exc.condition, exc.key) from exc
            raise
        return as_issue(stored) if stored is not None else issue

    def _moved_on(self, issue: Issue, read_at: int) -> bool:
        """Whether the row still exists but no longer stands at the revision `issue` was read at."""
        current = self._repository.get({"workspace_id": issue.workspace_id, "issue_id": issue.issue_id})
        return current is not None and int(current.get(REVISION) or 0) != read_at

    def replace_with(
        self, issue: Issue, change: Callable[[Issue], Issue | None], *, attempts: int = REPLACE_ATTEMPTS
    ) -> Issue | None:
        """Apply `change` to `issue` and write it, re-reading and reapplying on a concurrent write.

        For writes the system makes on someone's behalf, where losing the race
        should mean redoing the change on the fresh row rather than failing.
        `change` answers `None` to skip the write. Answers the stored issue, or
        `None` when the issue is gone or `change` skipped it; raises
        `IssueWriteConflict` once `attempts` are spent.
        """
        current: Issue | None = issue
        for attempt in range(attempts):
            if current is None:
                return None
            planned = change(current)
            if planned is None:
                return None
            try:
                return self.replace(planned)
            except IssueWriteConflict:
                if attempt == attempts - 1:
                    raise
                current = self.get(issue.workspace_id, issue.issue_id)
            except ConditionFailed:
                return None
        return None

    def set_progress(self, workspace_id: str, issue_id: str, total: int, completed: int) -> Issue | None:
        """Write one issue's rollup counts, or `None` when the issue is gone.

        The only write the consumer makes, and it touches nothing else on the row,
        so a rollup landing beside a concurrent patch cannot revert a field.
        `updated_at` is deliberately left alone: a rollup is not a user edit and
        must not reorder the list view.
        """
        key = {"workspace_id": workspace_id, "issue_id": issue_id}
        try:
            item = self._repository.update(
                key,
                update_expression="SET #progress = :progress, #changed = :changed",
                expression_names={"#progress": "progress", "#changed": CHANGED_AT},
                expression_values={":progress": {"total": total, "completed": completed}, ":changed": changed_stamp()},
                condition=Attr("issue_id").exists(),
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
        return as_issue(item) if item is not None else None

    def carry_to_cycle(self, workspace_id: str, issue_id: str, from_cycle: str, to_cycle: str) -> Issue | None:
        """Move one issue from a closed cycle into the next, or `None` when it already left.

        Conditional on the issue still sitting in `from_cycle`, so a planner who
        moved it meanwhile keeps their choice and a repeated close is a no-op. The
        issue is stamped with the cycle it left, which is how the planning rollup
        tells a carry-over from a planner's own move. `updated_at` is left alone,
        because a close is not an edit and must not reorder the list view.
        """
        if not workspace_id or not issue_id or not from_cycle or not to_cycle:
            return None
        try:
            item = self._repository.update(
                {"workspace_id": workspace_id, "issue_id": issue_id},
                update_expression="SET #cycle = :to, #carried = :from, #changed = :changed, " + REVISION_BUMP,
                expression_names={
                    "#cycle": "cycle_id",
                    "#carried": "cycle_carried_from",
                    "#changed": CHANGED_AT,
                    "#rev": REVISION,
                },
                expression_values={":to": to_cycle, ":from": from_cycle, ":changed": changed_stamp(), **REVISION_STEP},
                condition=Attr("issue_id").exists() & Attr("cycle_id").eq(from_cycle),
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
        return as_issue(item) if item is not None else None

    def add_to_cycle(self, workspace_id: str, issue_id: str, cycle_id: str) -> Issue | None:
        """Put one issue with no cycle into `cycle_id`, or `None` when it already has one.

        Conditional on the issue carrying no cycle, so a planner's own choice made
        meanwhile always wins and a redelivered record is a no-op. `updated_at` is
        left alone, because the automatic add is not an edit to the issue.
        """
        if not workspace_id or not issue_id or not cycle_id:
            return None
        try:
            item = self._repository.update(
                {"workspace_id": workspace_id, "issue_id": issue_id},
                update_expression="SET #cycle = :cycle, #changed = :changed, " + REVISION_BUMP,
                expression_names={"#cycle": "cycle_id", "#changed": CHANGED_AT, "#rev": REVISION},
                expression_values={":cycle": cycle_id, ":changed": changed_stamp(), **REVISION_STEP},
                condition=Attr("issue_id").exists() & Attr("cycle_id").not_exists(),
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
        return as_issue(item) if item is not None else None

    def iter_for_cycle(self, workspace_id: str, team_id: str, cycle_id: str, *, max_items: int = 2000) -> list[Issue]:
        """Every issue of one team attached to one cycle, from the sparse cycle index."""
        if not workspace_id or not team_id or not cycle_id:
            return []
        items = self._repository.iter_query(
            Key("ws_team").eq(ws_team(workspace_id, team_id)) & Key("cycle_id").eq(cycle_id),
            index_name=CYCLE_INDEX,
            max_items=max_items,
        )
        return [as_issue(item) for item in items]

    def set_blocked_by_open_count(self, workspace_id: str, issue_id: str, count: int) -> Issue | None:
        """Write how many open issues block this one, or `None` when the issue is gone.

        A single-attribute update for the same reason as `set_progress`: it is a
        derived value, so it must not revert a concurrent patch or move
        `updated_at`.
        """
        key = {"workspace_id": workspace_id, "issue_id": issue_id}
        try:
            item = self._repository.update(
                key,
                update_expression="SET #blocked = :blocked, #changed = :changed",
                expression_names={"#blocked": "blocked_by_open_count", "#changed": CHANGED_AT},
                expression_values={":blocked": count, ":changed": changed_stamp()},
                condition=Attr("issue_id").exists(),
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
        return as_issue(item) if item is not None else None

    def clear_project_milestone(self, workspace_id: str, issue_id: str, milestone_id: str) -> Issue | None:
        """Take one milestone off one issue, or `None` when it no longer carries it.

        Conditional on the issue still pointing at that milestone, so a move made
        after the milestone was deleted is never undone. Like the progress write it
        touches nothing else and leaves `updated_at` alone, because it is a
        consequence of a planning change rather than an edit to the issue.
        """
        key = {"workspace_id": workspace_id, "issue_id": issue_id}
        try:
            item = self._repository.update(
                key,
                update_expression="REMOVE #milestone SET #changed = :changed, " + REVISION_BUMP,
                expression_names={"#milestone": "project_milestone_id", "#changed": CHANGED_AT, "#rev": REVISION},
                expression_values={":changed": changed_stamp(), **REVISION_STEP},
                condition=Attr("issue_id").exists() & Attr("project_milestone_id").eq(milestone_id),
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
        return as_issue(item) if item is not None else None

    def archive(
        self, issue: Issue, archived_at: datetime, *, expect_updated_at: datetime | None = None
    ) -> Issue | None:
        """Archive one issue, or `None` when it is gone, already archived or changed since it was read.

        Conditional on the issue still carrying the status it was read with and on
        no archive stamp, so a repeated sweep or a double click is a no-op and a
        status change landing meanwhile is never hidden. The sweep also passes the
        `updated_at` it saw, so an edit made after its read resets the clock rather
        than being archived out from under the editor. `updated_at` itself is left
        alone: an archive is not an edit and must not reorder the list view.
        """
        stamp = serialize_datetime(archived_at)
        condition = Attr("issue_id").exists() & Attr("archived_at").not_exists() & Attr("status_id").eq(issue.status_id)
        if expect_updated_at is not None:
            condition = condition & Attr("updated_at").eq(serialize_datetime(expect_updated_at))
        try:
            item = self._repository.update(
                {"workspace_id": issue.workspace_id, "issue_id": issue.issue_id},
                update_expression="SET #archived = :archived, #status_key = :status_key, #changed = :changed, "
                + REVISION_BUMP,
                expression_names={
                    "#archived": "archived_at",
                    "#status_key": "ws_team_status",
                    "#changed": CHANGED_AT,
                    "#rev": REVISION,
                },
                expression_values={
                    **REVISION_STEP,
                    ":archived": stamp,
                    ":changed": changed_stamp(),
                    ":status_key": archived_ws_team_status(issue.workspace_id, issue.team_id, issue.status_id),
                },
                condition=condition,
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
        return as_issue(item) if item is not None else None

    def unarchive(self, issue: Issue, actor_id: str, now: datetime, *, source: str | None = None) -> Issue | None:
        """Restore one archived issue, or `None` when it is gone, not archived or moved since it was read.

        Unlike the archive this bumps `updated_at`, because the sweep measures the
        archive period from it and would otherwise re-archive the issue within the
        hour.
        """
        try:
            item = self._repository.update(
                {"workspace_id": issue.workspace_id, "issue_id": issue.issue_id},
                update_expression="REMOVE #archived SET #status_key = :status_key, #updated = :now, #by = :by, "
                "#changed = :changed, #source = :source, " + REVISION_BUMP,
                expression_names={
                    "#rev": REVISION,
                    "#changed": CHANGED_AT,
                    "#source": "updated_source",
                    "#archived": "archived_at",
                    "#status_key": "ws_team_status",
                    "#updated": "updated_at",
                    "#by": "updated_by",
                },
                expression_values={
                    ":status_key": status_partition_key(
                        issue.model_copy(update={"archived_at": None}), issue.status_id
                    ),
                    ":now": serialize_datetime(now),
                    ":by": actor_id,
                    ":source": source,
                    ":changed": changed_stamp(),
                    **REVISION_STEP,
                },
                condition=Attr("issue_id").exists()
                & Attr("archived_at").exists()
                & Attr("status_id").eq(issue.status_id),
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
        return as_issue(item) if item is not None else None

    def iter_changed_since(
        self, workspace_id: str, team_id: str, since: datetime, *, max_items: int = 500
    ) -> list[tuple[Issue, datetime]]:
        """Every issue of one team written after `since` with its `changed_at`, oldest first.

        A key condition on the change feed index, so a poll that finds nothing pays
        for an empty query rather than for the team's rows. Archived rows come back
        too, because an archive is a change a cached list has to drop. The stamp is
        returned beside the issue because the model does not carry it and the
        caller's next cursor is built from it.
        """
        if not workspace_id or not team_id:
            return []
        items = self._repository.iter_query(
            Key("ws_team").eq(ws_team(workspace_id, team_id)) & Key(CHANGED_AT).gt(changed_bound(since)),
            index_name=CHANGED_INDEX,
            ascending=True,
            max_items=max_items,
        )
        return [(as_issue(item), _DATETIME.validate_python(item[CHANGED_AT])) for item in items]

    def iter_finished_before(
        self, workspace_id: str, team_id: str, status_id: str, cutoff: datetime, *, max_items: int = 200
    ) -> list[Issue]:
        """The live issues of one status column last updated before `cutoff`, oldest first.

        A key condition on the status index rather than a filter, so the sweep
        reads exactly the issues that are due and pays nothing for the rest of
        the column. Archived issues sit in their own partition and never appear.
        """
        if not workspace_id or not team_id or not status_id:
            return []
        items = self._repository.iter_query(
            Key("ws_team_status").eq(ws_team_status(workspace_id, team_id, status_id))
            & Key("updated_at").lt(serialize_datetime(cutoff)),
            index_name=STATUS_UPDATED_INDEX,
            ascending=True,
            max_items=max_items,
        )
        return [as_issue(item) for item in items]

    def iter_for_project(
        self, workspace_id: str, team_id: str, project_id: str, *, max_items: int = 5000
    ) -> list[Issue]:
        """Every issue of one team attached to one project, through the sparse project index."""
        if not workspace_id or not team_id or not project_id:
            return []
        items = self._repository.iter_query(
            Key("ws_team").eq(ws_team(workspace_id, team_id)) & Key("project_id").eq(project_id),
            index_name=PROJECT_INDEX,
            max_items=max_items,
        )
        return [as_issue(item) for item in items]

    def delete(self, workspace_id: str, issue_id: str) -> bool:
        """Hard-delete one issue row, reporting whether one was there."""
        if self.get(workspace_id, issue_id) is None:
            return False
        self._repository.delete({"workspace_id": workspace_id, "issue_id": issue_id})
        return True

    def get_by_number(self, workspace_id: str, team_id: str, number: int) -> Issue | None:
        """The issue holding one number in one team, or `None`.

        Reads `ws_team-key_number-index` rather than scanning the workspace, which
        is what makes `GET /issues/by-key/{key}` one query.
        """
        if not workspace_id or not team_id:
            return None
        page = self._repository.query(
            Key("ws_team").eq(ws_team(workspace_id, team_id)) & Key("number").eq(number),
            index_name=KEY_NUMBER_INDEX,
            limit=1,
        )
        if not page.items:
            return None
        return as_issue(page.items[0])

    def list_for_team(
        self,
        workspace_id: str,
        team_id: str,
        *,
        limit: int = 200,
        start_key: Mapping[str, Any] | None = None,
        ascending: bool = False,
    ) -> Page:
        """One page of a team's issues by number, newest first by default.

        `ws_team-key_number-index` is the only index covering a whole team in
        one query: the status index is partitioned per status by design, so a
        team-wide read would otherwise be one query per column.
        """
        return self._repository.query(
            Key("ws_team").eq(ws_team(workspace_id, team_id)),
            index_name=KEY_NUMBER_INDEX,
            limit=limit,
            start_key=dict(start_key) if start_key else None,
            ascending=ascending,
        )

    def read_team_newest(self, workspace_id: str, team_id: str, *, below: int | None, max_items: int) -> list[Issue]:
        """Up to `max_items` of a team's issues numbered below `below`, newest first.

        Follows `LastEvaluatedKey` across pages, so a large team is read to the
        budget rather than to the first page. `below` of `None` starts at the newest.
        A number rather than a start key is the resume point, so a walk across
        several teams fits in one cursor.
        """
        if not workspace_id or not team_id or max_items <= 0:
            return []
        condition = Key("ws_team").eq(ws_team(workspace_id, team_id))
        if below is not None:
            condition = condition & Key("number").lt(below)
        items = read_all_pages(
            self._repository.table.query,
            max_items=max_items,
            KeyConditionExpression=condition,
            IndexName=KEY_NUMBER_INDEX,
            ScanIndexForward=False,
            Limit=min(max_items, TEAM_READ_PAGE),
        )
        return [as_issue(item) for item in items]

    def page_after(self, workspace_id: str, team_id: str, after: int, *, limit: int = 25) -> list[Issue]:
        """Up to `limit` of a team's issues numbered above `after`, lowest first.

        The team purge's cursor. A number rather than a `LastEvaluatedKey`
        survives a round trip through a queue message as plain JSON, and it stays
        valid when the rows behind it are deleted.
        """
        if not workspace_id or not team_id:
            return []
        page = self._repository.query(
            Key("ws_team").eq(ws_team(workspace_id, team_id)) & Key("number").gt(after),
            index_name=KEY_NUMBER_INDEX,
            limit=limit,
            ascending=True,
        )
        return [as_issue(item) for item in page.items]

    def page_for_workspace(self, workspace_id: str, *, limit: int = 25) -> list[Issue]:
        """The first `limit` issues of the workspace partition, whatever their team.

        The workspace purge's sweep for issues its teams did not reach. It deletes what
        it reads, so it always asks for the first page again rather than a cursor.
        """
        if not workspace_id:
            return []
        page = self._repository.query(Key("workspace_id").eq(workspace_id), limit=limit, consistent=True)
        return [as_issue(item) for item in page.items]

    def list_for_status(
        self,
        workspace_id: str,
        team_id: str,
        status_id: str,
        *,
        limit: int = 200,
        start_key: Mapping[str, Any] | None = None,
        ascending: bool = False,
    ) -> Page:
        """One page of a board column, by `updated_at` and newest first by default."""
        return self._repository.query(
            Key("ws_team_status").eq(ws_team_status(workspace_id, team_id, status_id)),
            index_name=STATUS_UPDATED_INDEX,
            limit=limit,
            start_key=dict(start_key) if start_key else None,
            ascending=ascending,
        )

    def iter_archived_for_status(
        self, workspace_id: str, team_id: str, status_id: str, *, max_items: int = 200
    ) -> list[Issue]:
        """The archived issues of one status of a team, newest first by `updated_at`.

        Archived rows carry their own status composite, so this is a key read of
        exactly the archive and pays nothing for the live issues of the column.
        """
        if not workspace_id or not team_id or not status_id:
            return []
        items = self._repository.iter_query(
            Key("ws_team_status").eq(archived_ws_team_status(workspace_id, team_id, status_id)),
            index_name=STATUS_UPDATED_INDEX,
            ascending=False,
            max_items=max_items,
        )
        return [as_issue(item) for item in items]

    def iter_for_status(
        self, workspace_id: str, team_id: str, status_id: str, *, include_archived: bool, max_items: int = 5000
    ) -> list[Issue]:
        """Every issue of one team in one status: the live column, the team's triage issues in it, then its archive.

        What a status delete moves and a status hide counts. Every partition is a key
        read, so none pays for the rest of the team.
        """
        if not workspace_id or not team_id or not status_id:
            return []
        items = list(
            self._repository.iter_query(
                Key("ws_team_status").eq(ws_team_status(workspace_id, team_id, status_id)),
                index_name=STATUS_UPDATED_INDEX,
                max_items=max_items,
            )
        )
        issues = [as_issue(item) for item in items]
        issues += [
            issue
            for issue in self.iter_triage(workspace_id, team_id, max_items=max_items)
            if issue.status_id == status_id
        ]
        if include_archived:
            issues += self.iter_archived_for_status(workspace_id, team_id, status_id, max_items=max_items)
        return issues

    def iter_assigned_with_due_date(
        self, workspace_id: str, team_id: str, status_id: str, *, max_items: int = 5000
    ) -> list[Issue]:
        """Live issues of one team in one status that have both an assignee and a due date.

        What the due date reminder sweep reads. Archived and triage issues live in
        partitions of their own, so the status column alone holds exactly the live
        ones, and the filter keeps the rest of the column out of the answer.
        """
        if not workspace_id or not team_id or not status_id:
            return []
        items = self._repository.iter_query(
            Key("ws_team_status").eq(ws_team_status(workspace_id, team_id, status_id)),
            index_name=STATUS_UPDATED_INDEX,
            filter_expression=Attr("due_date").attribute_type("S") & Attr("assignee_id").attribute_type("S"),
            max_items=max_items,
        )
        return [as_issue(item) for item in items]

    def iter_assigned_with_sla(
        self, workspace_id: str, team_id: str, status_id: str, *, max_items: int = 5000
    ) -> list[Issue]:
        """Live issues of one team in one status that have both an assignee and an SLA deadline.

        What the SLA notice sweep reads, the same column scan as the due date sweep.
        """
        if not workspace_id or not team_id or not status_id:
            return []
        items = self._repository.iter_query(
            Key("ws_team_status").eq(ws_team_status(workspace_id, team_id, status_id)),
            index_name=STATUS_UPDATED_INDEX,
            filter_expression=Attr("sla_breaches_at").attribute_type("S") & Attr("assignee_id").attribute_type("S"),
            max_items=max_items,
        )
        return [as_issue(item) for item in items]

    def iter_triage(self, workspace_id: str, team_id: str, *, max_items: int = 1000) -> list[Issue]:
        """Every live issue of one team awaiting triage, newest first by `updated_at`."""
        if not workspace_id or not team_id:
            return []
        items = self._repository.iter_query(
            Key("ws_team_status").eq(triage_ws_team_status(workspace_id, team_id)),
            index_name=STATUS_UPDATED_INDEX,
            ascending=False,
            max_items=max_items,
        )
        return [as_issue(item) for item in items]

    def iter_with_label(self, workspace_id: str, team_id: str, label_id: str, *, max_items: int = 10000) -> list[Issue]:
        """Every issue of one team carrying one label, archived ones included.

        No index is keyed on a label, so this walks the team's number index with a
        filter. It runs only when a label is deleted, which is rare enough to pay it.
        """
        if not workspace_id or not team_id or not label_id:
            return []
        items = self._repository.iter_query(
            Key("ws_team").eq(ws_team(workspace_id, team_id)),
            index_name=KEY_NUMBER_INDEX,
            filter_expression=Attr("label_ids").contains(label_id),
            max_items=max_items,
        )
        return [as_issue(item) for item in items]

    def list_for_assignee(
        self,
        workspace_id: str,
        assignee_id: str,
        *,
        limit: int = 200,
        start_key: Mapping[str, Any] | None = None,
        ascending: bool = False,
    ) -> Page:
        """One page of "my issues" across every team of one workspace.

        Crossing teams is the point of the index, so the caller filters the page
        down to the teams they may see rather than the query doing it.
        """
        return self._repository.query(
            Key("ws_assignee").eq(ws_assignee(workspace_id, assignee_id)),
            index_name=ASSIGNEE_UPDATED_INDEX,
            limit=limit,
            start_key=dict(start_key) if start_key else None,
            ascending=ascending,
        )

    def issue_ids_created_by(self, workspace_id: str, user_id: str, *, max_items: int = 1000) -> list[str]:
        """The ids of the issues one person created in one workspace, capped.

        Reads the keys-only creator index, so the caller batch-reads the rows it
        keeps. The workspace is the index's range key and is matched by equality,
        which is what keeps one tenant's issues out of another's read.
        """
        if not workspace_id or not user_id:
            return []
        items = self._repository.iter_query(
            Key("created_by").eq(user_id) & Key("workspace_id").eq(workspace_id),
            index_name=CREATOR_INDEX,
            max_items=max_items,
        )
        return [str(item["issue_id"]) for item in items]

    def iter_for_assignee(self, workspace_id: str, assignee_id: str, *, max_items: int = 1000) -> list[Issue]:
        """Every issue assigned to one person in one workspace, newest first and capped."""
        if not workspace_id or not assignee_id:
            return []
        items = self._repository.iter_query(
            Key("ws_assignee").eq(ws_assignee(workspace_id, assignee_id)),
            index_name=ASSIGNEE_UPDATED_INDEX,
            max_items=max_items,
            ascending=False,
        )
        return [as_issue(item) for item in items]

    def list_children(
        self,
        workspace_id: str,
        parent_id: str,
        *,
        limit: int = 200,
        start_key: Mapping[str, Any] | None = None,
        ascending: bool = True,
    ) -> Page:
        """One page of an issue's direct children, oldest first as the contract says."""
        return self._repository.query(
            Key("ws_parent").eq(ws_parent(workspace_id, parent_id)),
            index_name=PARENT_CREATED_INDEX,
            limit=limit,
            start_key=dict(start_key) if start_key else None,
            ascending=ascending,
        )

    def iter_children(self, workspace_id: str, parent_id: str, *, max_items: int = 1000) -> list[Issue]:
        """Every direct child of one issue, which is what the rollup recounts from.

        Recounting rather than incrementing is what makes the consumer idempotent: a
        record delivered twice produces the same counts.
        """
        if not workspace_id or not parent_id:
            return []
        items = self._repository.iter_query(
            Key("ws_parent").eq(ws_parent(workspace_id, parent_id)),
            index_name=PARENT_CREATED_INDEX,
            max_items=max_items,
        )
        return [as_issue(item) for item in items]

    def has_children(self, workspace_id: str, parent_id: str) -> bool:
        """Whether one issue has any direct child.

        Read before parenting and before a creator's delete, both of which the
        contract makes conditional on childlessness.
        """
        if not workspace_id or not parent_id:
            return False
        page = self._repository.query(
            Key("ws_parent").eq(ws_parent(workspace_id, parent_id)),
            index_name=PARENT_CREATED_INDEX,
            limit=1,
        )
        return bool(page.items)
