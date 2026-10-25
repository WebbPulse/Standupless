"""Write `started_at`, `completed_at` and `cancelled_at` onto issues from their status history.

Status writes stamp the three moments from the release that added them, and
`completed_at` from an earlier one, so older issues read null. This replays each
issue's `status_id` activity rows, oldest first, from the status it was created
in, and fills a moment only where the row has none, so a stamp a status write
already made is never moved.

Idempotent: a second run finds every moment it can derive already stored and
writes nothing. Run it once per environment after the release is deployed there.

Usage, from backend/:
    python scripts/backfill_issue_lifecycle_times.py --stage staging --dry-run
    python scripts/backfill_issue_lifecycle_times.py --stage staging

`--workspace <id>` limits the run. It prints counts only, never ids.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

FIELDS: tuple[str, ...] = ("started_at", "completed_at", "cancelled_at")
"""The issue moments this backfill derives."""

ACTIVITY_PAGE = 200
"""How many activity rows one history read asks for."""


def status_history(repositories: Any, workspace_id: str, issue_id: str) -> list[tuple[datetime, Any, Any]]:
    """Every status change of one issue as `(at, from, to)`, oldest first."""
    from app.common.db.dynamo.activity import as_activity

    changes: list[tuple[datetime, Any, Any]] = []
    start: Any = None
    while True:
        page = repositories.activity.list_for_issue(workspace_id, issue_id, limit=ACTIVITY_PAGE, start_key=start)
        for item in page.items:
            row = as_activity(item)
            if row.kind == "field_changed" and row.field == "status_id":
                changes.append((row.created_at, row.from_value, row.to_value))
        start = page.last_evaluated_key
        if not start:
            break
    changes.sort(key=lambda change: change[0])
    return changes


def replay(issue: Any, changes: list[tuple[datetime, Any, Any]], categories: dict[str, str]) -> dict[str, Any]:
    """The three moments one issue's status history gives, by the same rules a status write stamps them.

    A completion or cancellation counts only when the issue sits in a status of
    that category now, so a history missing its last move cannot stamp an open issue.
    """
    from app.common.sla import stamp_completion

    shadow = issue.model_copy(update={name: None for name in FIELDS})
    first = str(changes[0][1] or "") if changes else issue.status_id
    stamp_completion(shadow, categories.get(first, ""), issue.created_at)
    for at, _, to in changes:
        stamp_completion(shadow, categories.get(str(to or ""), ""), at)
    now = categories.get(issue.status_id, "")
    return {
        "started_at": shadow.started_at,
        "completed_at": shadow.completed_at if now == "completed" else None,
        "cancelled_at": shadow.cancelled_at if now == "cancelled" else None,
    }


def backfill_workspace(repositories: Any, workspace_id: str, *, dry_run: bool) -> tuple[int, int]:
    """Fill one workspace's missing issue moments, answering issues read and issues written."""
    from app.common.db.dynamo.issues import as_issue

    teams = repositories.teams.list_team_ids(workspace_id)
    categories: dict[str, str] = {}
    for team_id in teams:
        for status in repositories.team_config.list_statuses(workspace_id, team_id):
            categories[status.status_id] = status.category
    read = written = 0
    for team_id in teams:
        start: Any = None
        while True:
            page = repositories.issues.list_for_team(workspace_id, team_id, limit=200, start_key=start)
            for item in page.items:
                issue = as_issue(item)
                read += 1
                if all(getattr(issue, name) is not None for name in FIELDS):
                    continue
                derived = replay(issue, status_history(repositories, workspace_id, issue.issue_id), categories)
                if not missing(issue, derived):
                    continue
                written += 1
                if dry_run:
                    continue
                repositories.issues.replace_with(issue, lambda current, found=derived: filled(current, found))
            start = page.last_evaluated_key
            if not start:
                break
    return read, written


def missing(issue: Any, derived: dict[str, Any]) -> dict[str, Any]:
    """The derived moments the issue still lacks."""
    return {name: value for name, value in derived.items() if value is not None and getattr(issue, name) is None}


def filled(current: Any, derived: dict[str, Any]) -> Optional[Any]:
    """The issue with its lacking moments filled, or `None` when nothing is left to fill."""
    wanted = missing(current, derived)
    return current.model_copy(update=wanted) if wanted else None


def workspace_ids() -> list[str]:
    """Every workspace in this environment, read by a scan of the workspaces table."""
    from app.common.db.dynamo import tables
    from app.common.db.dynamo.base import build_repository

    return sorted(str(item["id"]) for item in build_repository(tables.WORKSPACES).iter_scan() if "alias_of" not in item)


def run(repositories: Any, workspaces: Sequence[str], *, dry_run: bool) -> tuple[int, int, int]:
    """Backfill each named workspace, returning workspaces read, issues read and issues written."""
    issues = written = 0
    for workspace_id in workspaces:
        read, wrote = backfill_workspace(repositories, workspace_id, dry_run=dry_run)
        issues += read
        written += wrote
    return len(workspaces), issues, written


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Parse the flags, bind the stage's tables and run."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--stage", required=True, help="The environment whose tables to read, such as staging")
    parser.add_argument("--workspace", action="append", default=[], help="Limit the run to this workspace id")
    parser.add_argument("--dry-run", action="store_true", help="Count what would be written and write nothing")
    arguments = parser.parse_args(argv)
    os.environ["DYNAMODB_TABLE_PREFIX"] = f"standupless-{arguments.stage}"
    from app.common.api.dependencies.repositories import ALL_REPOSITORY_NAMES, build_bundle

    repositories = build_bundle(ALL_REPOSITORY_NAMES, name="backfill-issue-lifecycle-times")
    workspaces, issues, written = run(repositories, arguments.workspace or workspace_ids(), dry_run=arguments.dry_run)
    print(
        ("dry-run " if arguments.dry_run else "") + f"workspaces={workspaces} issues={issues} issues_written={written}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
