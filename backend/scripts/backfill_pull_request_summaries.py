"""Write the pull request summary onto every issue that already links a pull request.

List rows and board cards draw a pull request chip from a summary the issue
row carries, which the GitHub delivery handlers keep current from the release
that added it. Issues linked before then have no summary until their pull
request's next delivery; this writes it from their stored links.

Idempotent: a second run finds every summary current and writes nothing. Run it
once per environment after the release is deployed there, so no delivery can
land behind it with the old code.

Usage, from backend/:
    python scripts/backfill_pull_request_summaries.py --stage staging --dry-run
    python scripts/backfill_pull_request_summaries.py --stage staging

`--workspace <id>` limits the run. It prints counts only, never ids.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def backfill_workspace(repositories: Any, workspace_id: str, *, dry_run: bool) -> tuple[int, int]:
    """Bring one workspace's linked issues' summaries current, answering issues read and written."""
    from app.domains.integrations.pr_summary import store

    by_issue: dict[str, list[Any]] = {}
    for link in repositories.github.iter_links(workspace_id):
        by_issue.setdefault(link.issue_id, []).append(link)
    written = 0
    for issue_id, links in by_issue.items():
        outcome = store(repositories, workspace_id, issue_id, lambda rows=links: rows, dry_run=dry_run)
        written += outcome == "written"
    return len(by_issue), written


def workspace_ids() -> list[str]:
    """Every workspace in this environment, read by a scan of the workspaces table."""
    from app.common.db.dynamo import tables
    from app.common.db.dynamo.base import build_repository

    return sorted(str(item["id"]) for item in build_repository(tables.WORKSPACES).iter_scan())


def run(repositories: Any, workspaces: Sequence[str], *, dry_run: bool) -> tuple[int, int, int]:
    """Backfill each named workspace, returning workspaces read, linked issues read and summaries written."""
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

    repositories = build_bundle(ALL_REPOSITORY_NAMES, name="backfill-pull-request-summaries")
    workspaces, issues, written = run(repositories, arguments.workspace or workspace_ids(), dry_run=arguments.dry_run)
    print(
        ("dry-run " if arguments.dry_run else "")
        + f"workspaces={workspaces} linked_issues={issues} summaries_written={written}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
