"""Queue a read back of every open linked pull request, healing merges and closes whose delivery was lost.

Before STUP-327 the shared rate limiter answered an internal SQS batch with a 429
that still counted as handled, so a `pull_request` merge or close could be dropped
and leave its links open, with the issue never moved. This queues one
`standupless.resync_pull_request` per open linked pull request on the
environment's GitHub events queue. The events consumer then reads each pull
request from GitHub with the App's installation token and, when it has merged or
closed, folds it the way its own delivery would have been folded: the link takes
the merge, and the issue moves only if nobody changed it after the merge.

The consumer does every GitHub read, inside its call budget, so this script holds
no GitHub credential. Idempotent: an open pull request stays open, and a healed
link is not read again. Run it with `--dry-run` first.

Usage, from backend/:
    python scripts/resync_open_pull_requests.py --stage staging --dry-run
    python scripts/resync_open_pull_requests.py --stage staging

`--workspace <id>` limits the run, `--limit` caps the pull requests queued per
workspace, and `--queue-url` overrides the queue looked up by name. It prints
counts only, never ids.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

DEFAULT_LIMIT = 500


@dataclass
class Tally:
    """What one run read and queued."""

    workspaces: int = 0
    queued: int = 0


def workspace_ids() -> list[str]:
    """Every workspace in this environment, read by a scan of the workspaces table."""
    from app.common.db.dynamo import tables
    from app.common.db.dynamo.base import build_repository

    return sorted(str(item["id"]) for item in build_repository(tables.WORKSPACES).iter_scan())


def events_queue_url(stage: str) -> str:
    """The stage's GitHub events queue, looked up by the name Terraform gives it."""
    import boto3

    return str(boto3.client("sqs").get_queue_url(QueueName=f"standupless-{stage}-github-events")["QueueUrl"])


def run(
    repositories: Any,
    workspaces: Sequence[str],
    *,
    queue_url: str,
    limit: int = DEFAULT_LIMIT,
    dry_run: bool,
) -> Tally:
    """Queue a read back of every open linked pull request in each named workspace."""
    from app.domains.integrations import pr_resync

    tally = Tally(workspaces=len(workspaces))
    for workspace_id in workspaces:
        tally.queued += pr_resync.sweep(
            repositories,
            workspace_id,
            idle_after=timedelta(0),
            max_idle=None,
            limit=limit,
            queue_url=queue_url,
            recheck=False,
            dry_run=dry_run,
        )
    return tally


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Parse the flags, bind the stage's tables and run."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--stage", required=True, help="The environment whose tables to read, such as staging")
    parser.add_argument("--workspace", action="append", default=[], help="Limit the run to this workspace id")
    parser.add_argument("--dry-run", action="store_true", help="Count what would be queued without queueing")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="The most pull requests queued per workspace")
    parser.add_argument("--queue-url", default="", help="The GitHub events queue, looked up by name when omitted")
    arguments = parser.parse_args(argv)
    os.environ["DYNAMODB_TABLE_PREFIX"] = f"standupless-{arguments.stage}"
    from app.common.api.dependencies.repositories import ALL_REPOSITORY_NAMES, build_bundle

    repositories = build_bundle(ALL_REPOSITORY_NAMES, name="resync-open-pull-requests")
    queue_url = arguments.queue_url or ("" if arguments.dry_run else events_queue_url(arguments.stage))
    tally = run(
        repositories,
        arguments.workspace or workspace_ids(),
        queue_url=queue_url,
        limit=arguments.limit,
        dry_run=arguments.dry_run,
    )
    print(f"dry_run={arguments.dry_run} workspaces={tally.workspaces} queued={tally.queued}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
