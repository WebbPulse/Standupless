"""Recurring issue rows of the `team_config` table.

A team's schedules are rows at `team#<pid>#recurring#<id>`, each naming the
template it creates from and when it next runs. The hourly sweep finds every
active schedule with one filtered scan of this small table, as the auto-close
and cycle jobs find their settings rows, so no index or table of its own is
needed.

A run is claimed by moving `next_run_at` on with a write conditioned on the
value the sweep read, so two overlapping sweeps create one issue per run, and a
schedule edited or paused meanwhile is left for the next pass.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Mapping, Optional

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository

from app.common.db.dynamo.base import as_item, utc_now

RECURRING_ISSUE = "recurring_issue"
"""The `kind` a recurring issue row carries."""


def recurring_prefix(team_id: str) -> str:
    """The sort key prefix every recurring issue of one team shares."""
    return f"team#{team_id}#recurring#"


def recurring_key(team_id: str, recurring_id: str) -> str:
    """The sort key of one recurring issue."""
    return f"{recurring_prefix(team_id)}{recurring_id}"


class RecurringIssue(BaseModel):
    """A schedule that creates an issue from a template on a repeating rule.

    `next_run_at` is when the sweep next creates an issue, `None` while paused.
    `paused_reason` says why the sweep paused it, empty when a person did.
    """

    workspace_id: str
    config_key: str
    recurring_id: str
    team_id: str
    kind: str = RECURRING_ISSUE
    template_id: str
    frequency: str
    interval: int = 1
    weekdays: list[int] = Field(default_factory=list)
    day_of_month: Optional[int] = None
    time: str = "09:00"
    timezone: str = "UTC"
    starts_on: date
    paused: bool = False
    paused_reason: Optional[str] = None
    next_run_at: Optional[datetime] = None
    last_run_at: Optional[datetime] = None
    last_issue_id: Optional[str] = None
    last_issue_key: Optional[str] = None
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class RecurringRows:
    """The recurring issue reads and writes of `TeamConfigRepository`, kept in one place."""

    _repository: Repository

    def get_recurring(self, workspace_id: str, team_id: str, recurring_id: str) -> RecurringIssue | None:
        """One recurring issue of a team, or `None`."""
        if not workspace_id or not team_id or not recurring_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "config_key": recurring_key(team_id, recurring_id)})
        return RecurringIssue.model_validate(dict(item)) if item is not None else None

    def list_recurring(self, workspace_id: str, team_id: str, *, limit: int = 200) -> list[RecurringIssue]:
        """Every recurring issue of one team, oldest first."""
        if not workspace_id or not team_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("config_key").begins_with(recurring_prefix(team_id)),
            max_items=limit,
        )
        rows = [RecurringIssue.model_validate(dict(item)) for item in items]
        return sorted(rows, key=lambda row: (row.created_at, row.recurring_id))

    def create_recurring(self, row: RecurringIssue) -> RecurringIssue:
        """Store one new recurring issue, raising `ConditionFailed` on a key collision."""
        self._repository.put(as_item(row), condition=Attr("config_key").not_exists())
        return row

    def replace_recurring(self, row: RecurringIssue) -> RecurringIssue | None:
        """Store an edited recurring issue whole, or `None` when it was deleted meanwhile."""
        stored = row.model_copy(update={"updated_at": utc_now()})
        try:
            self._repository.put(as_item(stored), condition=Attr("config_key").exists())
        except ConditionFailed:
            return None
        return stored

    def claim_recurring_run(self, read: RecurringIssue, claimed: RecurringIssue) -> bool:
        """Store `claimed` only if the row still runs at the time `read` did, reporting whether it won.

        The condition is the read row's `next_run_at` and its active state, so a
        second sweep, an edit or a pause since the read loses the claim.
        """
        expected = as_item(read)["next_run_at"]
        try:
            self._repository.put(
                as_item(claimed),
                condition=Attr("next_run_at").eq(expected) & Attr("paused").eq(False),
            )
        except ConditionFailed:
            return False
        return True

    def delete_recurring(self, workspace_id: str, team_id: str, recurring_id: str) -> bool:
        """Remove one recurring issue, reporting whether one was there."""
        key = {"workspace_id": workspace_id, "config_key": recurring_key(team_id, recurring_id)}
        if self._repository.get(key) is None:
            return False
        self._repository.delete(key)
        return True

    def iter_active_recurring(self, *, page_size: int = 200) -> list[RecurringIssue]:
        """Every unpaused recurring issue across every workspace, for the hourly sweep."""
        found: list[RecurringIssue] = []
        start_key: Mapping[str, Any] | None = None
        while True:
            page = self._repository.scan(
                filter_expression=Attr("kind").eq(RECURRING_ISSUE) & Attr("paused").eq(False),
                limit=page_size,
                start_key=dict(start_key) if start_key else None,
            )
            found.extend(RecurringIssue.model_validate(dict(item)) for item in page.items)
            start_key = page.last_evaluated_key
            if not start_key:
                return sorted(found, key=lambda row: (row.workspace_id, row.config_key))

    def delete_team_recurring(self, workspace_id: str, team_id: str, *, batch: int = 100) -> int:
        """Remove every recurring issue of one team, for the team purge."""
        removed = 0
        while True:
            rows = self.list_recurring(workspace_id, team_id, limit=batch)
            if not rows:
                return removed
            removed += self._repository.delete_many(
                [{"workspace_id": workspace_id, "config_key": row.config_key} for row in rows]
            )
