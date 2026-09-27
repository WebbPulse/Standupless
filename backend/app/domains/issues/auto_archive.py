"""The auto-archive sweep: finished issues are archived once a team's period has passed.

Linear archives an issue some months after it was completed or cancelled, with
the period chosen per team. This sweep does the same. It rides the hourly cycle
close schedule, which already invokes the issues function with one synthetic
record, because this function is the one that may write issues and activity.

The work is found without scanning issues. One filtered scan of the small
`team_config` table names every team's finished statuses and its period, and
each of those status columns is then read with a key condition on
`ws_team-status_updated-index`, `updated_at` before the cutoff, so the reads
return exactly the issues that are due. An archived issue moves to its own
status partition, so it never reads as due again.

The period runs from the issue's last update, which is when it was finished
unless it was edited afterwards: an edit after completion restarts the clock.
Each archive is conditional on the issue still carrying the status and the
`updated_at` it was read with, so a sweep is idempotent and never archives an
issue someone just touched. A run archives at most `MAX_PER_STATUS` issues per
status column, and a backlog larger than that drains over the following hours.
"""

from __future__ import annotations

import calendar
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.team_config import ARCHIVE_PERIODS, DEFAULT_ARCHIVE_PERIOD_MONTHS, ArchiveTarget

_log = logging.getLogger(__name__)

SYSTEM_ACTOR = "system"
"""The actor an automatic archive is recorded under."""

MAX_PER_STATUS = 200
"""The most issues one run archives from one status column."""


@dataclass
class ArchiveSummary:
    """What one sweep did, for the log line."""

    teams: int = 0
    archived: int = 0
    skipped: int = 0


def months_before(moment: datetime, months: int) -> datetime:
    """The same instant `months` calendar months earlier, clamped to the month's last day.

    Calendar months rather than a fixed number of days, so "six months" means the
    same date half a year back, and 31 March minus one month is 28 or 29 February.
    """
    total = moment.year * 12 + (moment.month - 1) - months
    year, month = divmod(total, 12)
    month += 1
    day = min(moment.day, calendar.monthrange(year, month)[1])
    return moment.replace(year=year, month=month, day=day)


def period_of(target: ArchiveTarget) -> int:
    """A team's archive period in months, the default when the stored one is not a choice."""
    return target.period_months if target.period_months in ARCHIVE_PERIODS else DEFAULT_ARCHIVE_PERIOD_MONTHS


def archive_team(repositories: Any, target: ArchiveTarget, now: datetime) -> tuple[int, int]:
    """Archive one team's due issues, returning how many were archived and how many lost a race."""
    cutoff = months_before(now, period_of(target))
    archived = 0
    skipped = 0
    for status_id in target.status_ids:
        due = repositories.issues.iter_finished_before(
            target.workspace_id, target.team_id, status_id, cutoff, max_items=MAX_PER_STATUS
        )
        for issue in due:
            stored = repositories.issues.archive(issue, now, expect_updated_at=issue.updated_at)
            if stored is None:
                skipped += 1
                continue
            repositories.activity.record(
                build_activity(
                    target.workspace_id,
                    stored.team_id,
                    stored.issue_id,
                    SYSTEM_ACTOR,
                    "archived",
                    actor_kind="system",
                )
            )
            archived += 1
    return archived, skipped


def sweep(repositories: Any, now: datetime | None = None) -> ArchiveSummary:
    """Archive every team's completed and cancelled issues whose period has passed.

    A team that is gone or being deleted is skipped: its rows are the purge's to
    remove, and archiving them would only add history rows the purge then deletes.
    """
    moment = now if now is not None else utc_now()
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    summary = ArchiveSummary()
    for target in repositories.team_config.iter_archive_targets():
        if repositories.teams.get(target.workspace_id, target.team_id) is None:
            continue
        summary.teams += 1
        archived, skipped = archive_team(repositories, target, moment)
        summary.archived += archived
        summary.skipped += skipped
    _log.info(
        "Archived finished issues.",
        extra={
            "event": "issues.auto_archive",
            "teams": summary.teams,
            "archived": summary.archived,
            "skipped": summary.skipped,
        },
    )
    return summary
