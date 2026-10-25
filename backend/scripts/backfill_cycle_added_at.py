"""Write `cycle_added_at` onto issues already sitting in a cycle, from their cycle history.

Cycle writes stamp the moment an issue joins its cycle from the release that
added the field, so older issues in a cycle read null, which the "Added to
cycle" filter treats as planned. This reads each such issue's `cycle_id`
activity rows and takes the latest move into the cycle it sits in now. An issue
with no cycle move at all was created in its cycle, so it takes `created_at`.
One whose history moves it but never into its current cycle stays empty, and
keeps reading as planned.

Idempotent: a stamp already stored is never moved, so a second run writes
nothing. Run it once per environment after the release is deployed there.

Usage, from backend/:
    python scripts/backfill_cycle_added_at.py --stage staging --dry-run
    python scripts/backfill_cycle_added_at.py --stage staging

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

ACTIVITY_PAGE = 200
"""How many activity rows one history read asks for."""


def cycle_history(repositories: Any, workspace_id: str, issue_id: str) -> list[tuple[datetime, Any]]:
    """Every cycle move of one issue as `(at, to)`, oldest first."""
    from app.common.db.dynamo.activity import as_activity

    moves: list[tuple[datetime, Any]] = []
    start: Any = None
    while True:
        page = repositories.activity.list_for_issue(workspace_id, issue_id, limit=ACTIVITY_PAGE, start_key=start)
        for item in page.items:
            row = as_activity(item)
            if row.kind == "field_changed" and row.field == "cycle_id":
                moves.append((row.created_at, row.to_value))
        start = page.last_evaluated_key
        if not start:
            break
    moves.sort(key=lambda move: move[0])
    return moves


def derive(issue: Any, moves: list[tuple[datetime, Any]]) -> Optional[datetime]:
    """When one issue joined the cycle it sits in now, or `None` when its history cannot say.

    The latest move into the current cycle wins. No cycle move at all means the
    issue was created in that cycle, so its creation is the moment.
    """
    if not issue.cycle_id:
        return None
    if not moves:
        return issue.created_at
    joined = [at for at, to in moves if str(to or "") == issue.cycle_id]
    return joined[-1] if joined else None


def filled(current: Any, moment: datetime, cycle_id: str) -> Optional[Any]:
    """The issue with `cycle_added_at` set, or `None` when it gained a stamp or left the cycle meanwhile."""
    if current.cycle_added_at is not None or current.cycle_id != cycle_id:
        return None
    return current.model_copy(update={"cycle_added_at": moment})


def backfill_workspace(repositories: Any, workspace_id: str, *, dry_run: bool) -> tuple[int, int]:
    """Fill one workspace's missing cycle stamps, answering issues read and issues written."""
    from app.common.db.dynamo.issues import as_issue

    read = written = 0
    for team_id in repositories.teams.list_team_ids(workspace_id):
        start: Any = None
        while True:
            page = repositories.issues.list_for_team(workspace_id, team_id, limit=200, start_key=start)
            for item in page.items:
                issue = as_issue(item)
                read += 1
                if not issue.cycle_id or issue.cycle_added_at is not None:
                    continue
                moment = derive(issue, cycle_history(repositories, workspace_id, issue.issue_id))
                if moment is None:
                    continue
                written += 1
                if dry_run:
                    continue
                repositories.issues.replace_with(
                    issue, lambda current, at=moment, cycle=issue.cycle_id: filled(current, at, cycle)
                )
            start = page.last_evaluated_key
            if not start:
                break
    return read, written


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

    repositories = build_bundle(ALL_REPOSITORY_NAMES, name="backfill-cycle-added-at")
    workspaces, issues, written = run(repositories, arguments.workspace or workspace_ids(), dry_run=arguments.dry_run)
    print(
        ("dry-run " if arguments.dry_run else "") + f"workspaces={workspaces} issues={issues} issues_written={written}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
