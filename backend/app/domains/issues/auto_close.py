"""The auto-close sweep: open issues nobody has touched for a team's period are cancelled.

Linear closes a team's stale backlog and triage issues once they have gone a
chosen number of months without an update. This sweep does the same, on the
hourly cycle close schedule beside the auto-archive sweep, because the issues
function is the one that may write issues and activity.

Only teams that picked a period are visited, found with one filtered scan of
`team_config`. Each backlog column and the triage partition is then read with a
key condition on `ws_team-status_updated-index`, `updated_at` before the cutoff,
so the reads return exactly the issues that are due. Unstarted and started
issues are never touched: someone planned or began them. A triage issue snoozed
into the future is left until it wakes.

Each close moves the issue to the team's chosen cancelled status, or its first
visible one, and is skipped when the issue changed since it was read, so a sweep
never closes an issue someone just touched. A run closes at most
`MAX_PER_COLUMN` issues per column, and a larger backlog drains over the
following hours. The history row names the system as the actor, and the close
drops any SLA timer the issue carried.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from app.common.change_source import SYSTEM
from app.common.db.dynamo.activity import Activity, build_activity
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import AUTO_CLOSE_PERIODS, STALE_CATEGORIES, AutoCloseSettings
from app.common.sla import apply_sla
from app.domains.issues.auto_archive import SYSTEM_ACTOR, months_before

_log = logging.getLogger(__name__)

MAX_PER_COLUMN = 200
"""The most issues one run closes from one status column or the triage inbox."""


@dataclass
class AutoCloseSummary:
    """What one sweep did, for the log line."""

    teams: int = 0
    closed: int = 0
    skipped: int = 0


def close_status(repositories: Any, settings: AutoCloseSettings) -> str | None:
    """The cancelled status a team's stale issues move to, `None` when the team has none visible.

    The chosen status when it is still a visible cancelled status of the team,
    otherwise the first one by position, so deleting or hiding the chosen status
    falls back rather than stopping the sweep.
    """
    rows = repositories.team_config.list_statuses(settings.workspace_id, settings.team_id, include_hidden=False)
    cancelled = sorted((row for row in rows if row.category == "cancelled"), key=lambda row: (row.position, row.name))
    for row in cancelled:
        if row.status_id == settings.status_id:
            return str(row.status_id)
    return str(cancelled[0].status_id) if cancelled else None


def stale_issues(repositories: Any, settings: AutoCloseSettings, cutoff: datetime, now: datetime) -> list[Issue]:
    """A team's backlog and triage issues last updated before `cutoff`, leaving out snoozed triage."""
    workspace_id, team_id = settings.workspace_id, settings.team_id
    found: list[Issue] = []
    for status in repositories.team_config.list_statuses(workspace_id, team_id, include_hidden=True):
        if status.category in STALE_CATEGORIES:
            found.extend(
                repositories.issues.iter_finished_before(
                    workspace_id, team_id, status.status_id, cutoff, max_items=MAX_PER_COLUMN
                )
            )
    waiting = repositories.issues.iter_triage_before(workspace_id, team_id, cutoff, max_items=MAX_PER_COLUMN)
    found.extend(issue for issue in waiting if issue.snoozed_until is None or issue.snoozed_until <= now)
    return found


def close_team(repositories: Any, settings: AutoCloseSettings, now: datetime) -> tuple[int, int]:
    """Close one team's stale issues, returning how many were closed and how many changed meanwhile."""
    if settings.period_months not in AUTO_CLOSE_PERIODS:
        return 0, 0
    target = close_status(repositories, settings)
    if target is None:
        return 0, 0
    cutoff = months_before(now, settings.period_months)
    rows: list[Activity] = []
    skipped = 0
    for issue in stale_issues(repositories, settings, cutoff, now):

        def close(current: Issue, read: Issue = issue) -> Issue | None:
            """The fresh issue moved to the close status, or `None` once someone touched it."""
            if (
                current.archived_at is not None
                or current.updated_at != read.updated_at
                or current.status_id != read.status_id
                or current.in_triage != read.in_triage
            ):
                return None
            moved = current.model_copy(
                update={
                    "status_id": target,
                    "in_triage": False,
                    "snoozed_until": None,
                    "updated_at": now,
                    "updated_by": SYSTEM_ACTOR,
                    "updated_source": SYSTEM,
                }
            )
            apply_sla(repositories, current, moved, now)
            return moved

        if repositories.issues.replace_with(issue, close) is None:
            skipped += 1
            continue
        rows.append(
            build_activity(
                issue.workspace_id,
                issue.team_id,
                issue.issue_id,
                SYSTEM_ACTOR,
                "field_changed",
                actor_kind="system",
                field="status_id",
                from_value=issue.status_id,
                to_value=target,
            )
        )
    repositories.activity.record_many(rows)
    return len(rows), skipped


def sweep(repositories: Any, now: datetime | None = None) -> AutoCloseSummary:
    """Close every opted-in team's backlog and triage issues untouched for its period.

    A team that is gone or being deleted is skipped: its rows are the purge's to
    remove.
    """
    moment = now if now is not None else utc_now()
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    summary = AutoCloseSummary()
    for settings in repositories.team_config.iter_auto_close_settings():
        if repositories.teams.get(settings.workspace_id, settings.team_id) is None:
            continue
        summary.teams += 1
        closed, skipped = close_team(repositories, settings, moment)
        summary.closed += closed
        summary.skipped += skipped
    if summary.teams:
        _log.info(
            "Closed stale issues.",
            extra={
                "event": "issues.auto_close",
                "teams": summary.teams,
                "closed": summary.closed,
                "skipped": summary.skipped,
            },
        )
    return summary
