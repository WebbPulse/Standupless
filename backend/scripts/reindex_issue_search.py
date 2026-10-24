"""Reconcile every team's search postings with the issues and comments it holds now.

The search consumer writes only the difference each stream record implies, so a
record it never handled leaves its postings wrong for good: a new issue that
cannot be found, a removed word that still matches, or an issue that moved team
and is still filed under the old one. Before STUP-327 the shared rate limiter
dropped such batches. This rebuilds the posting set each issue and comment should
have, the same terms the consumer computes, compares it with what each team's
partition holds, and writes the missing rows and deletes the stray ones.

Idempotent: a posting is a row whose whole content is its key, so a second run
finds nothing to change. An edit that lands while the run is reading its team can
be overtaken; running again converges. It also clears postings left by older
indexers and by deleted issues and comments.

Usage, from backend/:
    python scripts/reindex_issue_search.py --stage staging --dry-run
    python scripts/reindex_issue_search.py --stage staging

`--workspace <id>` limits the run. It prints counts only, never ids or text.
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
    """What one run read and changed."""

    teams: int = 0
    issues: int = 0
    comments: int = 0
    docs_changed: int = 0
    added: int = 0
    removed: int = 0


def workspace_issues(workspace_id: str) -> Iterable[Mapping[str, Any]]:
    """Every stored issue row of one workspace, whatever its team, as the raw item the stream carries."""
    from boto3.dynamodb.conditions import Key

    from app.common.db.dynamo import tables
    from app.common.db.dynamo.base import build_repository

    return build_repository(tables.ISSUES).iter_query(Key("workspace_id").eq(workspace_id))


def wanted_postings(
    repositories: Any, workspace_id: str, items: Iterable[Mapping[str, Any]], tally: Tally
) -> dict[str, dict[str, set[str]]]:
    """The terms every issue and comment of a workspace should be posted under, by team and then by doc."""
    from app.common.db.dynamo.search_index import comment_doc, comment_terms, issue_terms

    wanted: dict[str, dict[str, set[str]]] = {}
    for item in items:
        issue_id = str(item.get("issue_id") or "")
        team_id = str(item.get("team_id") or "")
        if not issue_id or not team_id:
            continue
        tally.issues += 1
        docs = wanted.setdefault(team_id, {})
        docs[issue_id] = issue_terms(item)
        for comment in repositories.comments.iter_for_issue(workspace_id, issue_id):
            tally.comments += 1
            docs[comment_doc(comment.comment_id, issue_id)] = comment_terms({"body": comment.body})
    return wanted


def reconcile_team(
    repositories: Any, workspace_id: str, team_id: str, wanted: Mapping[str, set[str]], tally: Tally, *, dry_run: bool
) -> None:
    """Bring one team's partition to exactly the wanted postings."""
    held: dict[str, set[str]] = {}
    for term, doc in repositories.search_index.iter_team(workspace_id, team_id):
        held.setdefault(doc, set()).add(term)
    for doc in sorted(set(wanted) | set(held)):
        want = wanted.get(doc, set())
        have = held.get(doc, set())
        appeared = want - have
        departed = have - want
        if not appeared and not departed:
            continue
        tally.docs_changed += 1
        tally.added += len(appeared)
        tally.removed += len(departed)
        if not dry_run:
            repositories.search_index.apply(workspace_id, team_id, doc, appeared=appeared, departed=departed)


def reindex_workspace(
    repositories: Any, workspace_id: str, items: Iterable[Mapping[str, Any]], tally: Tally, *, dry_run: bool
) -> None:
    """Reconcile every live team of one workspace, and any team an issue still names."""
    wanted = wanted_postings(repositories, workspace_id, items, tally)
    teams = {team.team_id for team in repositories.teams.list_for_workspace(workspace_id, limit=1000)}
    for team_id in sorted(teams | set(wanted)):
        tally.teams += 1
        reconcile_team(repositories, workspace_id, team_id, wanted.get(team_id, {}), tally, dry_run=dry_run)


def workspace_ids() -> list[str]:
    """Every workspace in this environment, read by a scan of the workspaces table."""
    from app.common.db.dynamo import tables
    from app.common.db.dynamo.base import build_repository

    return sorted(str(item["id"]) for item in build_repository(tables.WORKSPACES).iter_scan())


def run(repositories: Any, workspaces: Sequence[str], *, dry_run: bool) -> Tally:
    """Reindex each named workspace."""
    tally = Tally()
    for workspace_id in workspaces:
        reindex_workspace(repositories, workspace_id, workspace_issues(workspace_id), tally, dry_run=dry_run)
    return tally


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Parse the flags, bind the stage's tables and run."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--stage", required=True, help="The environment whose tables to read, such as staging")
    parser.add_argument("--workspace", action="append", default=[], help="Limit the run to this workspace id")
    parser.add_argument("--dry-run", action="store_true", help="Count what would change and write nothing")
    arguments = parser.parse_args(argv)
    os.environ["DYNAMODB_TABLE_PREFIX"] = f"standupless-{arguments.stage}"
    from app.common.api.dependencies.repositories import ALL_REPOSITORY_NAMES, build_bundle

    repositories = build_bundle(ALL_REPOSITORY_NAMES, name="reindex-issue-search")
    workspaces = arguments.workspace or workspace_ids()
    tally = run(repositories, workspaces, dry_run=arguments.dry_run)
    print(
        ("dry-run " if arguments.dry_run else "")
        + f"workspaces={len(workspaces)} teams={tally.teams} issues={tally.issues} comments={tally.comments}"
        + f" docs_changed={tally.docs_changed} postings_added={tally.added} postings_removed={tally.removed}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
