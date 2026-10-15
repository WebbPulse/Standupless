"""The finished SLA timer repair: completed and cancelled issues that still carry a timer lose it.

Every status move drops the SLA timer of an issue it finishes, but a release
moving its issues forward once skipped that step, so issues it moved to a
finished status kept a running timer and later read as breached. Nothing ever
notified on them, because the SLA notice sweep reads only open columns, yet the
issue pages and filters showed the breach.

This sweep clears those timers in place. It rides the hourly trigger beside the
auto-archive sweep and finds each team's finished statuses the same way, with
one filtered scan of `team_config`. Each finished column is then read through
the status index with the deadline as a filter, and a team is marked done in
`counters` once a run leaves none behind, so after the first pass it costs one
read per team an hour. A run clears at most `MAX_PER_STATUS` issues per column
and finishes a larger backlog over the following hours. `VERSION` is raised to
run it again everywhere.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from app.common.db.dynamo.team_config import ArchiveTarget

_log = logging.getLogger(__name__)

NAME = "sla_finished"
"""The name the repair's per-team markers are filed under."""

VERSION = 1
"""The repair's version; a team marked at an earlier one is swept again."""

MAX_PER_STATUS = 200
"""The most issues one run clears in one status column."""


@dataclass
class SlaRepairSummary:
    """What one sweep did, for the log line."""

    teams: int = 0
    cleared: int = 0


def repair_team(repositories: Any, target: ArchiveTarget) -> tuple[int, bool]:
    """Clear the timers of one team's finished issues, answering how many and whether none are left."""
    cleared = 0
    finished = True
    for status_id in target.status_ids:
        rows = repositories.issues.iter_with_sla(
            target.workspace_id, target.team_id, status_id, max_items=MAX_PER_STATUS
        )
        if len(rows) >= MAX_PER_STATUS:
            finished = False
        for issue in rows:
            if issue.sla_breaches_at is None and issue.sla_started_at is None:
                continue
            if repositories.issues.clear_sla(issue):
                cleared += 1
    return cleared, finished


def sweep(repositories: Any) -> SlaRepairSummary:
    """Clear the SLA timers finished issues still carry, once per team and version.

    A team that is gone or being deleted is skipped: its rows are the purge's to
    remove.
    """
    summary = SlaRepairSummary()
    for target in repositories.team_config.iter_archive_targets(
        teams_of=lambda workspace_id: [team.team_id for team in repositories.teams.list_for_workspace(workspace_id)]
    ):
        if repositories.counters.swept(target.workspace_id, target.team_id, NAME, VERSION):
            continue
        if repositories.teams.get(target.workspace_id, target.team_id) is None:
            continue
        summary.teams += 1
        cleared, finished = repair_team(repositories, target)
        summary.cleared += cleared
        if finished:
            repositories.counters.mark_swept(target.workspace_id, target.team_id, NAME, VERSION)
    if summary.teams:
        _log.info(
            "Cleared SLA timers on finished issues.",
            extra={"event": "issues.sla_repair", "teams": summary.teams, "cleared": summary.cleared},
        )
    return summary
