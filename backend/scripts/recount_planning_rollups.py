"""Recount every cycle, project and milestone from the issues each holds now.

The planning rollup consumer moves a cycle's counters by an `ADD` per stream
record and recounts a project only when one of its issues next changes, so a
record it never handled leaves a cycle off for good and a project off until its
next change. Before STUP-327 the shared rate limiter dropped such batches. This
rebuilds each cycle's issue, point and unestimated buckets with the consumer's
own weighing and writes the ones that drifted, then runs the consumer's project
recount over every project.

Idempotent: only rows whose stored counts differ are written, so a second run
writes nothing. A cycle write is conditional on its rollup revision, so a move
the consumer makes during the run is never overwritten; that cycle is skipped and
a second run picks it up. Carry-over counters are history and are left alone.

Usage, from backend/:
    python scripts/recount_planning_rollups.py --stage staging --dry-run
    python scripts/recount_planning_rollups.py --stage staging

`--workspace <id>` limits the run. It prints counts only, never ids.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@dataclass
class Tally:
    """What one run read and wrote."""

    cycles: int = 0
    cycles_written: int = 0
    projects: int = 0
    project_rows_written: int = 0


def team_cycles(repositories: Any, workspace_id: str, team_id: str) -> Iterator[Any]:
    """Every cycle of one team, following the page cursor."""
    start_key = None
    while True:
        cycles, start_key = repositories.planning.list_cycles(workspace_id, team_id, limit=100, start_key=start_key)
        yield from cycles
        if not start_key:
            return


def recount_workspace(repositories: Any, workspace_id: str, tally: Tally, *, dry_run: bool) -> None:
    """Recount one workspace's cycles and then its projects and milestones."""
    from app.domains.planning.consumers.rollup import recount_cycle, recount_project

    for team in repositories.teams.list_for_workspace(workspace_id, limit=1000):
        for cycle in team_cycles(repositories, workspace_id, team.team_id):
            tally.cycles += 1
            if recount_cycle(repositories, workspace_id, cycle, write=not dry_run):
                tally.cycles_written += 1
    for project in repositories.planning.list_projects(workspace_id):
        tally.projects += 1
        tally.project_rows_written += recount_project(
            repositories, workspace_id, project.project_id, {}, write=not dry_run
        )


def workspace_ids() -> list[str]:
    """Every workspace in this environment, read by a scan of the workspaces table."""
    from app.common.db.dynamo import tables
    from app.common.db.dynamo.base import build_repository

    return sorted(str(item["id"]) for item in build_repository(tables.WORKSPACES).iter_scan())


def run(repositories: Any, workspaces: Sequence[str], *, dry_run: bool) -> Tally:
    """Recount each named workspace."""
    tally = Tally()
    for workspace_id in workspaces:
        recount_workspace(repositories, workspace_id, tally, dry_run=dry_run)
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

    repositories = build_bundle(ALL_REPOSITORY_NAMES, name="recount-planning-rollups")
    workspaces = arguments.workspace or workspace_ids()
    tally = run(repositories, workspaces, dry_run=arguments.dry_run)
    print(
        ("dry-run " if arguments.dry_run else "")
        + f"workspaces={len(workspaces)} cycles={tally.cycles} cycles_written={tally.cycles_written}"
        + f" projects={tally.projects} project_rows_written={tally.project_rows_written}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
