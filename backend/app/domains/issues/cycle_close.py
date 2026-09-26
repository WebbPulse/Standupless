"""The cycle close: when a cycle ends, its unfinished issues roll into the next one.

A cycle's status is derived from its dates, so nothing writes when one ends. This
sweep is what does: an EventBridge Scheduler schedule invokes the issues function
hourly with one synthetic record, the consumer route hands it here, and every
cycle that ended in the last week is closed.

It runs in the issues function because it writes issues, and planning never
writes the issues table. Each move is conditional on the issue still sitting in
the ended cycle, so a close is idempotent: a second run finds nothing left to
move, and a planner who moved an issue meanwhile keeps their choice. A cycle
with no next cycle to roll into is left alone until one is created, which the
lookback window then picks up.

The move stamps each issue with the cycle it left, and the planning rollup reads
that marker off the stream to count the carry-over on both cycles.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Mapping, Sequence

from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.planning import Cycle
from app.domains.issues.service import COMPLETED_CATEGORIES

_log = logging.getLogger(__name__)

CYCLE_CLOSE_SOURCE = "standupless.cycle-close"
"""The `eventSource` the schedule's synthetic record carries."""

LOOKBACK_DAYS = 7
"""How far back a sweep looks for an ended cycle, so a missed run heals itself."""

SYSTEM_ACTOR = "system"
"""The actor a carry-over is recorded under."""


def is_cycle_close(record: Mapping[str, Any]) -> bool:
    """Whether one record is the schedule's cycle close trigger rather than a stream record."""
    return str(record.get("eventSource", "")) == CYCLE_CLOSE_SOURCE


@dataclass
class CloseSummary:
    """What one sweep did, for the log line."""

    cycles: int = 0
    carried: int = 0
    without_next: int = 0


def next_cycle(cycles: Sequence[Cycle], ended: Cycle, today: str) -> Cycle | None:
    """The cycle an ended cycle's unfinished issues roll into, or `None`.

    The earliest live cycle of the same team that starts after the ended one did
    and has not itself ended, so a close never rolls work into the past.
    """
    candidates = [
        cycle
        for cycle in cycles
        if cycle.cycle_id != ended.cycle_id
        and cycle.team_id == ended.team_id
        and not cycle.cancelled
        and cycle.start_date > ended.start_date
        and cycle.end_date >= today
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda cycle: (cycle.start_date, cycle.cycle_id))


def close_cycle(repositories: Any, ended: Cycle, today: str) -> tuple[int, bool]:
    """Roll one ended cycle's unfinished issues into its next cycle.

    Returns how many issues moved and whether a next cycle existed. An issue whose
    status is unknown to the team is left where it is rather than guessed at.
    """
    workspace_id = ended.workspace_id
    target = next_cycle(repositories.planning.list_for_roadmap(workspace_id, ended.team_id), ended, today)
    if target is None:
        return 0, False

    categories = {
        status.status_id: status.category
        for status in repositories.team_config.list_statuses(workspace_id, ended.team_id)
    }
    moved = 0
    for issue in repositories.issues.iter_for_cycle(workspace_id, ended.team_id, ended.cycle_id):
        category = categories.get(issue.status_id)
        if category is None or category in COMPLETED_CATEGORIES:
            continue
        if repositories.issues.carry_to_cycle(workspace_id, issue.issue_id, ended.cycle_id, target.cycle_id) is None:
            continue
        repositories.activity.record(
            build_activity(
                workspace_id,
                issue.team_id,
                issue.issue_id,
                SYSTEM_ACTOR,
                "field_changed",
                actor_kind="system",
                field="cycle_id",
                from_value=ended.cycle_id,
                to_value=target.cycle_id,
            )
        )
        moved += 1
    return moved, True


def sweep(repositories: Any, today: str | None = None) -> CloseSummary:
    """Close every cycle that ended within the lookback window.

    A cycle ends at the close of its `end_date`, so the window stops at
    yesterday. Cancelled cycles are skipped: cancelling one is a decision about
    its issues that a close should not override.
    """
    now = today if today is not None else date.today().isoformat()
    until = (date.fromisoformat(now) - timedelta(days=1)).isoformat()
    since = (date.fromisoformat(now) - timedelta(days=LOOKBACK_DAYS)).isoformat()
    summary = CloseSummary()
    for ended in repositories.planning.iter_cycles_ended_between(since, until):
        if ended.cancelled:
            continue
        summary.cycles += 1
        moved, had_next = close_cycle(repositories, ended, now)
        summary.carried += moved
        if not had_next:
            summary.without_next += 1
    _log.info(
        "Closed ended cycles.",
        extra={
            "event": "issues.cycle_close",
            "cycles": summary.cycles,
            "carried": summary.carried,
            "without_next": summary.without_next,
        },
    )
    return summary
