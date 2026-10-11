"""The issue list's delta read: what changed in a filtered list since a sync cursor.

A polling client reads its list once in full and then asks only for what moved.
Each visible team is one key-bounded query on the change feed index, so a poll
that finds nothing costs an empty query per team rather than a re-read of every
row through the fan-out window. Deletions come from the workspace's tombstone
partition, and a changed row that no longer matches the filter, an archive
included, is reported by id so the client drops it.

The cursor handed back is a pure function of what the read found: unchanged when
nothing moved, otherwise the newest change seen less the overlap. That keeps two
identical polls byte for byte identical, which is what lets an ETag be layered
over the route later without changing this contract.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Optional

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.activity import TOMBSTONE_RETENTION
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.filter_resolution import resolve_issue_filter
from app.common.issue_filters import IssueFilter
from app.common.issue_keys import current_all
from app.common.issue_rules import status_categories
from app.common.issue_writes import descending, sort_key
from app.common.sub_teams import listed_teams

SYNC_OVERLAP = timedelta(seconds=10)
"""How far behind the newest change a cursor is set.

A write stamps `changed_at` before it lands and the index is eventually
consistent, so a row stamped just before the newest one seen may not be readable
yet. Re-reading the overlap costs a few repeated rows, which the client upserts
idempotently, and never loses one.
"""

DELTA_TEAM_CAP = 500
"""The most changed rows one team's delta reads before telling the client to resync.

A bulk edit or import can move more rows than a delta should carry, and a full
read is the cheaper answer then.
"""


@dataclass
class IssueChanges:
    """One delta read: the changed rows that match, the ids to drop, and the next cursor."""

    issues: list[Issue] = field(default_factory=list)
    removed_ids: list[str] = field(default_factory=list)
    synced_at: Optional[datetime] = None
    resync_required: bool = False


def sync_cursor(moment: Optional[datetime] = None) -> datetime:
    """The cursor a full read hands out: its start time less the overlap."""
    return (moment or utc_now()) - SYNC_OVERLAP


def normalize(since: datetime) -> datetime:
    """`since` as an aware UTC datetime, a naive one read as UTC."""
    moment = since if since.tzinfo is not None else since.replace(tzinfo=UTC)
    return moment.astimezone(UTC)


def list_issue_changes(
    repositories: Repositories,
    context: AuthzContext,
    wanted: IssueFilter,
    *,
    team_id: Optional[str],
    sort: str,
    since: datetime,
    subscribed: bool = False,
    include_sub_teams: bool = False,
) -> IssueChanges:
    """What changed in the caller's filtered issue list after `since`.

    Changed rows the filter keeps come back in the list's sort order; changed rows
    it drops, archived ones included, and deleted issues come back as ids. A
    cursor older than the tombstone retention, or a delta too large to carry,
    answers `resync_required` and nothing else, since a partial answer there would
    be silently wrong. `include_sub_teams` rolls the named team's visible
    sub-teams in, as the full read does.
    """
    since = normalize(since)
    if since < utc_now() - TOMBSTONE_RETENTION + SYNC_OVERLAP:
        return IssueChanges(synced_at=since, resync_required=True)

    teams = listed_teams(repositories, context, team_id, include_sub_teams=include_sub_teams)
    if not teams:
        return IssueChanges(synced_at=since)

    changed: list[Issue] = []
    stamps: list[datetime] = []
    for candidate in teams:
        rows = repositories.issues.iter_changed_since(
            context.workspace_id, candidate, since, max_items=DELTA_TEAM_CAP + 1
        )
        if len(rows) > DELTA_TEAM_CAP:
            return IssueChanges(synced_at=since, resync_required=True)
        changed.extend(issue for issue, _ in rows)
        stamps.extend(normalize(stamp) for _, stamp in rows)

    allowed = set(teams)
    tombstones = [
        row for row in repositories.activity.tombstones_since(context.workspace_id, since) if row.team_id in allowed
    ]

    newest = max([since, *stamps, *(normalize(row.created_at) for row in tombstones)])
    cursor = since if newest == since else max(since, newest - SYNC_OVERLAP)

    wanted = resolve_issue_filter(repositories, context.workspace_id, teams, wanted)
    categories: dict[str, str] = {}
    if wanted.needs_categories and changed:
        for candidate in {issue.team_id for issue in changed}:
            categories.update(status_categories(repositories, context.workspace_id, candidate))

    latest: dict[str, Issue] = {}
    for issue in current_all(repositories.teams, changed):
        latest[issue.issue_id] = issue

    kept: list[Issue] = []
    removed: list[str] = []
    for issue in latest.values():
        if wanted.matches(issue, categories) and (not subscribed or is_subscribed(repositories, context, issue)):
            kept.append(issue)
        else:
            removed.append(issue.issue_id)
    removed.extend(row.issue_id for row in tombstones if row.issue_id not in latest)

    ordered = sorted(kept, key=sort_key(sort), reverse=descending(sort))
    return IssueChanges(issues=ordered, removed_ids=sorted(set(removed)), synced_at=cursor)


def is_subscribed(repositories: Repositories, context: AuthzContext, issue: Issue) -> bool:
    """Whether the caller follows one issue, for the subscribed list's delta."""
    return repositories.subscriptions.get(context.workspace_id, issue.issue_id, context.user_id) is not None
