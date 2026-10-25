"""Post every existing comment's terms to the search index.

The search consumer indexes comments from the comments stream from the release
that added comment search, so a comment written before then cannot be found
until it is next edited. This posts each stored comment's terms under its
issue's current team, exactly the rows the consumer would have written for it.

Idempotent: a posting is a row whose whole content is its key, so a second run
puts the same rows again and changes nothing. A comment whose issue is gone is
skipped. Run it once per environment after the release is deployed there, so
the consumer keeps every later write current.

Usage, from backend/:
    python scripts/backfill_comment_search.py --stage staging --dry-run
    python scripts/backfill_comment_search.py --stage staging

`--workspace <id>` limits the run. It prints counts only, never ids or text.
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

    comments: int = 0
    indexed: int = 0
    skipped: int = 0
    postings: int = 0


def stored_comments() -> Iterable[Any]:
    """Every comment in this environment, read by a scan of the comments table."""
    from app.common.db.dynamo import tables
    from app.common.db.dynamo.base import build_repository
    from app.common.db.dynamo.comments import as_comment

    return (as_comment(item) for item in build_repository(tables.COMMENTS).iter_scan())


def workspace_ids() -> list[str]:
    """Every workspace in this environment, read by a scan of the workspaces table."""
    from app.common.db.dynamo import tables
    from app.common.db.dynamo.base import build_repository

    return sorted(str(item["id"]) for item in build_repository(tables.WORKSPACES).iter_scan() if "alias_of" not in item)


def run(repositories: Any, comments: Iterable[Any], workspaces: Sequence[str], *, dry_run: bool) -> Tally:
    """Post each comment of the named workspaces under its issue's current team."""
    from app.common.db.dynamo.search_index import comment_doc, comment_terms

    wanted = set(workspaces)
    teams: dict[tuple[str, str], Optional[str]] = {}
    tally = Tally()
    for comment in comments:
        if comment.workspace_id not in wanted:
            continue
        tally.comments += 1
        key = (comment.workspace_id, comment.issue_id)
        if key not in teams:
            issue = repositories.issues.get(comment.workspace_id, comment.issue_id)
            teams[key] = issue.team_id if issue is not None else None
        team_id = teams[key]
        terms = comment_terms({"body": comment.body})
        if team_id is None or not terms:
            tally.skipped += 1
            continue
        if not dry_run:
            repositories.search_index.apply(
                comment.workspace_id,
                team_id,
                comment_doc(comment.comment_id, comment.issue_id),
                appeared=terms,
                departed=set(),
            )
        tally.indexed += 1
        tally.postings += len(terms)
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

    repositories = build_bundle(ALL_REPOSITORY_NAMES, name="backfill-comment-search")
    workspaces = arguments.workspace or workspace_ids()
    tally = run(repositories, stored_comments(), workspaces, dry_run=arguments.dry_run)
    print(
        ("dry-run " if arguments.dry_run else "")
        + f"workspaces={len(workspaces)} comments={tally.comments} indexed={tally.indexed}"
        + f" skipped={tally.skipped} postings_written={tally.postings}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
