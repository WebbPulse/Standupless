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

from datetime import datetime
from typing import Any, Literal, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Page, Repository, new_ulid

from app.common.db.dynamo.base import build_repository, utc_now
from app.common.db.dynamo.tables import ISSUES

STATUS_UPDATED_INDEX = "ws_team-status_updated-index"

KEY_NUMBER_INDEX = "ws_team-key_number-index"

ASSIGNEE_UPDATED_INDEX = "ws_assignee-updated_at-index"

PARENT_CREATED_INDEX = "ws_parent-created_at-index"

Priority = Literal["none", "urgent", "high", "medium", "low"]

PRIORITIES: tuple[str, ...] = ("none", "urgent", "high", "medium", "low")

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
    project_id: str | None = None
    sort_order: str | None = None
    progress: Progress = Field(default_factory=Progress)
    blocked_by_open_count: int = 0
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


def index_attributes(issue: Issue, status_id: str) -> dict[str, Any]:
    """The index composites for one issue, omitting every null-valued one.

    `status_id` is passed rather than read off the issue so a caller updating the
    status computes the composite from the value it is about to write, not from the
    one still on the row.
    """
    attributes: dict[str, Any] = {
        "ws_team": ws_team(issue.workspace_id, issue.team_id),
        "ws_team_status": ws_team_status(issue.workspace_id, issue.team_id, status_id),
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


def as_issue_item(issue: Issue) -> dict[str, Any]:
    """One issue as the stored item, carrying its index composites.

    Written through this rather than the shared `as_item` because the composites
    depend on the issue's own fields and dropping one would silently unindex a row.
    """
    item = issue.model_dump(mode="json")
    item.update(index_attributes(issue, issue.status_id))
    for attachment in ATTACHMENT_ATTRIBUTE_NAMES:
        if not item.get(attachment):
            item.pop(attachment, None)
    return item


def as_issue(item: Mapping[str, Any]) -> Issue:
    """One stored item as an `Issue`, ignoring the index composites.

    `number` comes back as a `Decimal` from a numeric attribute, which pydantic
    coerces to `int`, so the model stays the one shape the routes see.
    """
    fields = {key: value for key, value in item.items() if key not in INDEX_ATTRIBUTE_NAMES}
    return Issue.model_validate(fields)


class IssueRepository:
    """Reads and writes `issues` rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(ISSUES, repository)

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

    def replace(self, issue: Issue) -> Issue:
        """Write one issue over an existing row, recomputing its index composites.

        A patch goes through a whole-item put rather than an `UPDATE` expression
        because four denormalised composites depend on the fields being changed;
        rebuilding them from the finished model is what keeps them consistent.
        """
        self._repository.put(as_issue_item(issue), condition=Attr("issue_id").exists())
        return issue

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
                update_expression="SET #progress = :progress",
                expression_names={"#progress": "progress"},
                expression_values={":progress": {"total": total, "completed": completed}},
                condition=Attr("issue_id").exists(),
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
        return as_issue(item) if item is not None else None

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
                update_expression="SET #blocked = :blocked",
                expression_names={"#blocked": "blocked_by_open_count"},
                expression_values={":blocked": count},
                condition=Attr("issue_id").exists(),
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
        return as_issue(item) if item is not None else None

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
