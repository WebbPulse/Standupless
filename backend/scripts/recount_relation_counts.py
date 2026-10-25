"""Recount every linked issue so each carries how many links it holds.

Link writes keep `relation_count` from the release that added it, but a link
written before then left both of its issues at zero. This runs the same recount
over every issue that holds a link now, so the links property on list rows and
board cards shows the count without waiting for the next link change.

Idempotent: the recount writes only rows whose stored count differs, so a second
run writes nothing. Run it once per environment after the release is deployed
there.

Usage, from backend/:
    python scripts/recount_relation_counts.py --stage staging

`--workspace <id>` limits the run. It prints counts only, never ids.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def recount_workspace(repositories: Any, workspace_id: str) -> tuple[int, int]:
    """Recount one workspace's linked issues, answering issues read and rows written."""
    from app.common.relation_effects import recount_relations

    linked: set[str] = set()
    for issue_ids in repositories.relations.issue_ids_by_type(workspace_id).values():
        linked.update(issue_ids)
    written = 0
    for issue_id in sorted(linked):
        before = repositories.issues.get(workspace_id, issue_id)
        if before is None:
            continue
        count = recount_relations(repositories, workspace_id, issue_id)
        if count is not None and count != before.relation_count:
            written += 1
    return len(linked), written


def workspace_ids() -> list[str]:
    """Every workspace in this environment, read by a scan of the workspaces table."""
    from app.common.db.dynamo import tables
    from app.common.db.dynamo.base import build_repository

    return sorted(str(item["id"]) for item in build_repository(tables.WORKSPACES).iter_scan() if "alias_of" not in item)


def run(repositories: Any, workspaces: Sequence[str]) -> tuple[int, int, int]:
    """Recount each named workspace, returning workspaces read, issues read and rows written."""
    issues = written = 0
    for workspace_id in workspaces:
        read, wrote = recount_workspace(repositories, workspace_id)
        issues += read
        written += wrote
    return len(workspaces), issues, written


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Parse the flags, bind the stage's tables and run."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--stage", required=True, help="The environment whose tables to read, such as staging")
    parser.add_argument("--workspace", action="append", default=[], help="Limit the run to this workspace id")
    arguments = parser.parse_args(argv)
    os.environ["DYNAMODB_TABLE_PREFIX"] = f"standupless-{arguments.stage}"
    from app.common.api.dependencies.repositories import ALL_REPOSITORY_NAMES, build_bundle

    repositories = build_bundle(ALL_REPOSITORY_NAMES, name="recount-relation-counts")
    workspaces, issues, written = run(repositories, arguments.workspace or workspace_ids())
    print(f"workspaces={workspaces} issues={issues} rows_written={written}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
