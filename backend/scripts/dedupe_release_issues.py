"""Leave each issue on one release per stage, the first that carried it there.

Before STUP-328 a staging deploy could start its range at a production commit,
because an end-to-end job reporting against staging from the default branch
moved the stage's head there. Each later staging deploy then released every
issue since the last promotion again, and the promotion release itself gained
a staging stage it never reached. This repairs what that left:

- A stage a release reached after it had already reached a later one is
  dropped, so a promotion lists only the stages it really moved through.
- An issue carried by several releases that landed on the same stage stays on
  the one that landed first and is removed from the rest, links included, so
  each release lists and counts only what it shipped. A promotion, a release
  that includes others, keeps everything it carries.

Idempotent: a second run finds nothing to change. Run it with `--dry-run`
first, on staging and then on production after the promotion.

Usage, from backend/:
    python scripts/dedupe_release_issues.py --stage staging --dry-run
    python scripts/dedupe_release_issues.py --stage staging

`--workspace <id>` limits the run. It prints counts only, never ids.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@dataclass
class Tally:
    """What one run read and changed."""

    workspaces: int = 0
    teams: int = 0
    releases: int = 0
    stages_dropped: int = 0
    links_removed: int = 0
    releases_written: int = 0


def workspace_ids() -> list[str]:
    """Every workspace in this environment, read by a scan of the workspaces table."""
    from app.common.db.dynamo import tables
    from app.common.db.dynamo.base import build_repository

    return sorted(str(item["id"]) for item in build_repository(tables.WORKSPACES).iter_scan() if "alias_of" not in item)


def stages_in_order(release: Any, rank: dict[str, int]) -> list[Any]:
    """The stages a release really moved through, by when it reached each.

    A stage reached after a later stage of the pipeline is dropped. A stage the
    pipeline no longer has is kept, since nothing ranks it.
    """
    kept: list[Any] = []
    highest = -1
    for entry in sorted(release.stages, key=lambda row: row.reached_at):
        position = rank.get(entry.stage_id)
        if position is not None and position < highest:
            continue
        kept.append(entry)
        if position is not None:
            highest = max(highest, position)
    return kept


def plan_team(releases: Sequence[Any], rank: dict[str, int]) -> dict[str, tuple[list[Any], set[str]]]:
    """Each release that changes, mapped to the stages it keeps and the issues it gives up."""
    stages = {release.release_id: stages_in_order(release, rank) for release in releases}
    first: dict[tuple[str, str], tuple[Any, str]] = {}
    for release in releases:
        kept = stages[release.release_id]
        if not kept or release.included_release_ids:
            continue
        landed = (kept[0].reached_at, release.release_id)
        for issue_id in release.issue_ids:
            key = (kept[0].stage_id, issue_id)
            if key not in first or landed < first[key]:
                first[key] = landed
    changes: dict[str, tuple[list[Any], set[str]]] = {}
    for release in releases:
        kept = stages[release.release_id]
        dropped: set[str] = set()
        if kept and not release.included_release_ids:
            for issue_id in release.issue_ids:
                winner = first.get((kept[0].stage_id, issue_id))
                if winner is not None and winner[1] != release.release_id:
                    dropped.add(issue_id)
        if dropped or len(kept) != len(release.stages):
            changes[release.release_id] = (kept, dropped)
    return changes


def repair_team(repositories: Any, workspace_id: str, team_id: str, tally: Tally, *, dry_run: bool) -> None:
    """Repair one team's releases, counting what changed, and writing only when not a dry run."""
    from app.common import releases as release_rules

    pipeline, _ = release_rules.pipeline_for(repositories, workspace_id, team_id)
    rank = {stage.stage_id: index for index, stage in enumerate(pipeline.stages)}
    rows = repositories.releases.list_all_for_team(workspace_id, team_id)
    tally.teams += 1
    tally.releases += len(rows)
    by_id = {release.release_id: release for release in rows}
    for release_id, (kept, dropped) in plan_team(rows, rank).items():
        release = by_id[release_id]
        tally.stages_dropped += len(release.stages) - len(kept)
        tally.links_removed += len(dropped)
        tally.releases_written += 1
        if dry_run:
            continue
        updated = release.model_copy(
            update={
                "stages": kept,
                "issue_ids": [issue_id for issue_id in release.issue_ids if issue_id not in dropped],
                "referenced_issue_ids": [
                    issue_id for issue_id in release.referenced_issue_ids if issue_id not in dropped
                ],
            }
        )
        repositories.releases.replace(updated)
        repositories.releases.unlink_issues(workspace_id, release_id, sorted(dropped))


def run(repositories: Any, workspaces: Sequence[str], *, dry_run: bool) -> Tally:
    """Repair every team of each named workspace."""
    tally = Tally(workspaces=len(workspaces))
    for workspace_id in workspaces:
        for team in repositories.teams.list_for_workspace(workspace_id):
            repair_team(repositories, workspace_id, team.team_id, tally, dry_run=dry_run)
    return tally


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Parse the flags, bind the stage's tables and run."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--stage", required=True, help="The environment whose tables to read, such as staging")
    parser.add_argument("--workspace", action="append", default=[], help="Limit the run to this workspace id")
    parser.add_argument("--dry-run", action="store_true", help="Count what would change without writing")
    arguments = parser.parse_args(argv)
    os.environ["DYNAMODB_TABLE_PREFIX"] = f"standupless-{arguments.stage}"
    from app.common.api.dependencies.repositories import ALL_REPOSITORY_NAMES, build_bundle

    repositories = build_bundle(ALL_REPOSITORY_NAMES, name="dedupe-release-issues")
    tally = run(repositories, arguments.workspace or workspace_ids(), dry_run=arguments.dry_run)
    print(
        f"dry_run={arguments.dry_run} workspaces={tally.workspaces} teams={tally.teams} "
        f"releases={tally.releases} stages_dropped={tally.stages_dropped} "
        f"links_removed={tally.links_removed} releases_written={tally.releases_written}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
