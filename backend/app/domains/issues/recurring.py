"""The recurring issue sweep: every schedule whose next run has come creates its issue.

It runs on the hourly cycle close schedule beside the auto-close and
auto-archive sweeps, because the issues function is the one that may write
issues, so recurring issues add no schedule or function of their own. Active
schedules are found with one filtered scan of `team_config`.

Each due schedule is claimed with a conditional write that moves its next run
on before the issue is created, so overlapping or retried sweeps create one
issue per run. The next run is the first after now, so a schedule that missed
several runs creates one issue and carries on. A schedule that fails on its own,
for a reason such as a deleted template, is paused with that reason and the
rest of the sweep goes on.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from app.common.db.dynamo.base import utc_now
from app.common.recurring_issues import is_due, run_due

_log = logging.getLogger(__name__)


@dataclass
class RecurringSummary:
    """What one sweep did, for the log line."""

    due: int = 0
    created: int = 0
    skipped: int = 0
    paused: int = 0
    failed: int = 0


def sweep(repositories: Any, now: datetime | None = None) -> RecurringSummary:
    """Create the issue every due schedule owes, leaving teams that are gone to the purge."""
    moment = now if now is not None else utc_now()
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    moment = moment.replace(second=0, microsecond=0)
    summary = RecurringSummary()
    for row in repositories.team_config.iter_active_recurring():
        if not is_due(row, moment):
            continue
        if repositories.teams.get(row.workspace_id, row.team_id) is None:
            continue
        summary.due += 1
        try:
            outcome, _ = run_due(repositories, row, moment)
        except Exception:
            summary.failed += 1
            _log.exception(
                "A recurring issue failed to run.",
                extra={"event": "issues.recurring_failed", "recurring_id": row.recurring_id},
            )
            continue
        setattr(summary, outcome, getattr(summary, outcome) + 1)
    if summary.due:
        _log.info(
            "Ran recurring issues.",
            extra={
                "event": "issues.recurring",
                "due": summary.due,
                "created": summary.created,
                "skipped": summary.skipped,
                "paused": summary.paused,
                "failed": summary.failed,
            },
        )
    return summary
