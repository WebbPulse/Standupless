"""Recount every project and milestone so each carries its issue count per status.

The planning rollup consumer writes `status_counts` beside the category buckets
from the release that added it, but only when an issue of the project next
changes. This runs the same recount over every project now, so a project page
splits its progress bar by status without waiting for that change.

Idempotent: the recount writes only rows whose stored counts differ, so a second
run writes nothing. Run it once per environment after the release is deployed
there.

Usage, from backend/:
    python scripts/recount_project_status_counts.py --stage staging

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
    """Recount one workspace's projects, answering projects read and rows written."""
    from app.domains.planning.consumers.rollup import recount_project

    projects = repositories.planning.list_projects(workspace_id)
    written = 0
    for project in projects:
        written += recount_project(repositories, workspace_id, project.project_id, {})
    return len(projects), written


def workspace_ids() -> list[str]:
    """Every workspace in this environment, read by a scan of the workspaces table."""
    from app.common.db.dynamo import tables
    from app.common.db.dynamo.base import build_repository

    return sorted(str(item["id"]) for item in build_repository(tables.WORKSPACES).iter_scan())


def run(repositories: Any, workspaces: Sequence[str]) -> tuple[int, int, int]:
    """Recount each named workspace, returning workspaces read, projects read and rows written."""
    projects = written = 0
    for workspace_id in workspaces:
        read, wrote = recount_workspace(repositories, workspace_id)
        projects += read
        written += wrote
    return len(workspaces), projects, written


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Parse the flags, bind the stage's tables and run."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--stage", required=True, help="The environment whose tables to read, such as staging")
    parser.add_argument("--workspace", action="append", default=[], help="Limit the run to this workspace id")
    arguments = parser.parse_args(argv)
    os.environ["DYNAMODB_TABLE_PREFIX"] = f"standupless-{arguments.stage}"
    from app.common.api.dependencies.repositories import ALL_REPOSITORY_NAMES, build_bundle

    repositories = build_bundle(ALL_REPOSITORY_NAMES, name="recount-project-status-counts")
    workspaces, projects, written = run(repositories, arguments.workspace or workspace_ids())
    print(f"workspaces={workspaces} projects={projects} rows_written={written}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
