"""Delete team memberships whose holder is no longer a member of the workspace.

Removing a workspace member used to delete only the workspace row, leaving the
person's team rows behind, so a later invite, even as a guest, restored their
private team access and team admin role. Removal now deletes both. This clears
the rows earlier removals left: every `team#<pid>#user#<uid>` row in a workspace
whose `user#<uid>` row is gone.

Idempotent: a second run finds nothing to delete. Run it once per environment
after the removal fix is deployed there, so no new orphan can appear behind it.

Usage, from backend/:
    python scripts/purge_orphaned_team_memberships.py --stage staging --dry-run
    python scripts/purge_orphaned_team_memberships.py --stage staging

`--workspace <id>` limits the run. It prints counts only, never ids.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

UNBOUNDED = 1_000_000


def purge_workspace(repositories: Any, workspace_id: str, *, dry_run: bool) -> int:
    """Delete, or count under `dry_run`, one workspace's orphaned team memberships."""
    members = {row.user_id for row in repositories.memberships.list_members(workspace_id, limit=UNBOUNDED)}
    orphans = [
        row
        for row in repositories.memberships.list_all_team_memberships(workspace_id, limit=UNBOUNDED)
        if row.user_id not in members and row.team_id
    ]
    if not dry_run:
        for row in orphans:
            repositories.memberships.delete_team_membership(workspace_id, row.team_id, row.user_id)
    return len(orphans)


def workspace_ids() -> list[str]:
    """Every workspace in this environment, read by a scan of the workspaces table."""
    from app.common.db.dynamo import tables
    from app.common.db.dynamo.base import build_repository

    return sorted(str(item["id"]) for item in build_repository(tables.WORKSPACES).iter_scan())


def run(repositories: Any, workspaces: Sequence[str], *, dry_run: bool) -> tuple[int, int]:
    """Purge each named workspace, returning how many workspaces were read and rows went."""
    return len(workspaces), sum(purge_workspace(repositories, ws, dry_run=dry_run) for ws in workspaces)


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Parse the flags, bind the stage's tables and run."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--stage", required=True, help="The environment whose tables to read, such as staging")
    parser.add_argument("--workspace", action="append", default=[], help="Limit the run to this workspace id")
    parser.add_argument("--dry-run", action="store_true", help="Count what would be deleted and write nothing")
    arguments = parser.parse_args(argv)
    os.environ["DYNAMODB_TABLE_PREFIX"] = f"standupless-{arguments.stage}"
    from app.common.api.dependencies.repositories import ALL_REPOSITORY_NAMES, build_bundle

    repositories = build_bundle(ALL_REPOSITORY_NAMES, name="purge-orphaned-team-memberships")
    workspaces, removed = run(repositories, arguments.workspace or workspace_ids(), dry_run=arguments.dry_run)
    print(("dry-run " if arguments.dry_run else "") + f"workspaces={workspaces} orphaned_team_memberships={removed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
