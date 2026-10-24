"""Recount every issue rollup the issues stream consumer keeps, and clear deleted milestones off issues.

The issues rollup consumer recounts a parent's `progress`, a blocked issue's
`blocked_by_open_count` and a blocker's `blocking_count` only when a stream record
names them, and clears a milestone off its issues only when the milestone's
removal arrives. A record it never handled leaves those values wrong until the
next change. Before STUP-327 the shared rate limiter dropped such batches. This
runs the consumer's own recounts over every issue that has, or claims to have,
children or blocking links, and detaches every milestone an issue names that no
longer exists.

Idempotent: each recount writes only a value that differs, and a milestone clear
is conditional on the issue still naming it, so a second run writes nothing.

Usage, from backend/:
    python scripts/recount_issue_rollups.py --stage staging --dry-run
    python scripts/recount_issue_rollups.py --stage staging

`--workspace <id>` limits the run. It prints counts only, never ids.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@dataclass
class Tally:
    """What one run read and wrote."""

    issues: int = 0
    progress_written: int = 0
    blocked_written: int = 0
    blocking_written: int = 0
    milestones_detached: int = 0
    milestone_issues_cleared: int = 0


def workspace_issues(workspace_id: str) -> Iterable[Any]:
    """Every stored issue of one workspace, whatever its team."""
    from boto3.dynamodb.conditions import Key

    from app.common.db.dynamo import tables
    from app.common.db.dynamo.base import build_repository
    from app.common.db.dynamo.issues import as_issue

    items = build_repository(tables.ISSUES).iter_query(Key("workspace_id").eq(workspace_id))
    return (as_issue(item) for item in items)


def recount_workspace(
    repositories: Any, workspace_id: str, issues: Iterable[Any], tally: Tally, *, dry_run: bool
) -> None:
    """Recount one workspace's parents, blocked issues and blockers, then detach its deleted milestones."""
    from app.common.relation_effects import recount_blocked, recount_blocking
    from app.domains.issues.consumers.rollup import detach_milestone, recount

    rows = {issue.issue_id: issue for issue in issues}
    tally.issues += len(rows)
    write = not dry_run

    parents = {issue.parent_id for issue in rows.values() if issue.parent_id}
    parents |= {issue.issue_id for issue in rows.values() if issue.progress.total or issue.progress.completed}
    for parent_id in sorted(parents):
        if recount(repositories, workspace_id, parent_id, write=write):
            tally.progress_written += 1

    linked = repositories.relations.issue_ids_by_type(workspace_id)
    blocked = set(linked.get("blocked_by", frozenset()))
    blocked |= {issue.issue_id for issue in rows.values() if issue.blocked_by_open_count}
    for issue_id in sorted(blocked & set(rows)):
        count = recount_blocked(repositories, workspace_id, issue_id, write=write)
        if count is not None and count != rows[issue_id].blocked_by_open_count:
            tally.blocked_written += 1
    blockers = set(linked.get("blocks", frozenset()))
    blockers |= {issue.issue_id for issue in rows.values() if issue.blocking_count}
    for issue_id in sorted(blockers & set(rows)):
        count = recount_blocking(repositories, workspace_id, issue_id, write=write)
        if count is not None and count != rows[issue_id].blocking_count:
            tally.blocking_written += 1

    named: dict[tuple[str, str], int] = {}
    for issue in rows.values():
        if issue.project_id and issue.project_milestone_id:
            pair = (issue.project_id, issue.project_milestone_id)
            named[pair] = named.get(pair, 0) + 1
    for (project_id, milestone_id), carried in sorted(named.items()):
        if repositories.planning.get_milestone(workspace_id, project_id, milestone_id) is not None:
            continue
        tally.milestones_detached += 1
        if dry_run:
            tally.milestone_issues_cleared += carried
        else:
            tally.milestone_issues_cleared += detach_milestone(repositories, workspace_id, project_id, milestone_id)


def workspace_ids() -> list[str]:
    """Every workspace in this environment, read by a scan of the workspaces table."""
    from app.common.db.dynamo import tables
    from app.common.db.dynamo.base import build_repository

    return sorted(str(item["id"]) for item in build_repository(tables.WORKSPACES).iter_scan())


def run(repositories: Any, workspaces: Sequence[str], *, dry_run: bool) -> Tally:
    """Recount each named workspace."""
    tally = Tally()
    for workspace_id in workspaces:
        recount_workspace(repositories, workspace_id, workspace_issues(workspace_id), tally, dry_run=dry_run)
    return tally


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Parse the flags, bind the stage's tables and run."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--stage", required=True, help="The environment whose tables to read, such as staging")
    parser.add_argument("--workspace", action="append", default=[], help="Limit the run to this workspace id")
    parser.add_argument("--dry-run", action="store_true", help="Count what would be written and write nothing")
    arguments = parser.parse_args(argv)
    os.environ["DYNAMODB_TABLE_PREFIX"] = f"standupless-{arguments.stage}"
    from app.common.api.dependencies.repositories import ALL_REPOSITORY_NAMES, build_bundle

    repositories = build_bundle(ALL_REPOSITORY_NAMES, name="recount-issue-rollups")
    workspaces = arguments.workspace or workspace_ids()
    tally = run(repositories, workspaces, dry_run=arguments.dry_run)
    print(
        ("dry-run " if arguments.dry_run else "")
        + f"workspaces={len(workspaces)} issues={tally.issues} progress_written={tally.progress_written}"
        + f" blocked_written={tally.blocked_written} blocking_written={tally.blocking_written}"
        + f" milestones_detached={tally.milestones_detached}"
        + f" milestone_issues_cleared={tally.milestone_issues_cleared}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
