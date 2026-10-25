"""Give every existing issue activity row the attribute the actor feed index reads.

The member page reads one person's changes off the activity table's
`ws_actor-created_at-index`, which a row joins only when it carries `ws_actor`.
Rows written from the release that added the index carry it; this stamps the
rows written before, so a member's older history shows on their page.

Idempotent: a row already carrying the right value is skipped, so a second run
writes nothing. Only a person's own changes are stamped, never a system or
GitHub row. Run it once per environment after the release is deployed there and
the index is active.

Usage, from backend/:
    python scripts/backfill_activity_actor_index.py --stage staging --dry-run
    python scripts/backfill_activity_actor_index.py --stage staging

`--workspace <id>` limits the run. It prints counts only, never ids or values.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@dataclass
class Tally:
    """What one run read and wrote."""

    rows: int = 0
    stamped: int = 0
    skipped: int = 0


def stored_rows() -> Iterable[Mapping[str, Any]]:
    """Every activity row in this environment, read by a scan of the activity table."""
    from app.common.db.dynamo import tables
    from app.common.db.dynamo.base import build_repository

    return build_repository(tables.ACTIVITY).iter_scan()


def run(activity: Any, items: Iterable[Mapping[str, Any]], workspaces: Sequence[str], *, dry_run: bool) -> Tally:
    """Stamp each row of the named workspaces, or every workspace when none are named."""
    from app.common.db.dynamo.activity import as_activity, index_attributes

    wanted = set(workspaces)
    tally = Tally()
    for item in items:
        if wanted and str(item.get("workspace_id")) not in wanted:
            continue
        tally.rows += 1
        actor = index_attributes(as_activity(item)).get("ws_actor")
        if actor is None or item.get("ws_actor") == actor:
            tally.skipped += 1
            continue
        if dry_run or activity.stamp_actor_index(item):
            tally.stamped += 1
        else:
            tally.skipped += 1
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

    repositories = build_bundle(ALL_REPOSITORY_NAMES, name="backfill-activity-actor-index")
    tally = run(repositories.activity, stored_rows(), arguments.workspace, dry_run=arguments.dry_run)
    print(
        ("dry-run " if arguments.dry_run else "") + f"rows={tally.rows} stamped={tally.stamped} skipped={tally.skipped}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
