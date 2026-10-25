"""The trash purge sweep: issues deleted more than 30 days ago are removed for good.

Linear keeps a deleted issue restorable for 30 days. This sweep ends that window.
It rides the hourly cycle close schedule beside the auto-archive sweep, because
the issues function is the one that may write issues, relations and activity, so
it needs no schedule of its own.

Each live team of each active workspace costs one key read of its trash
partition with the cutoff as a filter, and a team with an empty trash pays for
an empty query. A purge does what the old delete did at once: the children are
reparented, the links removed and the history dropped. A run purges at most
`MAX_PER_TEAM` issues per team and drains a larger trash over the next hours.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from app.common.db.dynamo.base import utc_now
from app.common.issue_trash import TRASH_RETENTION, purge_issue

_log = logging.getLogger(__name__)

SYSTEM_ACTOR = "system"
"""The actor an automatic purge is recorded under."""

MAX_PER_TEAM = 200
"""The most issues one run purges from one team's trash."""


@dataclass
class TrashPurgeSummary:
    """What one sweep did, for the log line."""

    teams: int = 0
    purged: int = 0


def purge_team(repositories: Any, workspace_id: str, team_id: str, now: datetime) -> int:
    """Purge one team's issues whose trash retention has passed, answering how many."""
    due = repositories.issues.iter_trash_due(workspace_id, team_id, now - TRASH_RETENTION, max_items=MAX_PER_TEAM)
    for issue in due:
        purge_issue(repositories, workspace_id, issue, SYSTEM_ACTOR, actor_kind="system")
    return len(due)


def sweep(repositories: Any, now: datetime | None = None) -> TrashPurgeSummary:
    """Purge every team's issues deleted longer ago than the trash retention.

    A workspace being deleted is skipped, and so is a team being deleted: their
    rows are the workspace and team purges' to remove.
    """
    moment = now if now is not None else utc_now()
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    summary = TrashPurgeSummary()
    for workspace in repositories.workspaces.list_active():
        if workspace.is_purging:
            continue
        for team in repositories.teams.list_for_workspace(workspace.id):
            summary.teams += 1
            summary.purged += purge_team(repositories, workspace.id, team.team_id, moment)
    if summary.purged:
        _log.info(
            "Purged deleted issues past their retention.",
            extra={"event": "issues.trash_purge", "teams": summary.teams, "purged": summary.purged},
        )
    return summary
