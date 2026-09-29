"""The search route, reading the projection the search consumer maintains.

Scope is fail-closed by construction: `ws_team` begins with the workspace id, so
there is no cross-workspace read to prevent, and without an explicit team the
fan-out covers exactly the teams the caller can see, which for a guest is the
teams they hold a membership in.

A key lookup short-circuits the index entirely. Typing `ABC-123` is meant to be
exact rather than a relevance guess, so it is answered from
`ws_team-key_number-index` and never touches a posting list.

Search is not paged. The MVP caps at `limit` and says so; a cursor over an
intersection of posting lists is a post-MVP decision alongside the OpenSearch one.

Term search walks each term's postings newest issue id first and intersects them
as a merge join, one page at a time, so it stops reading once `limit` matches are
found. Only those matches are fetched, and the page is ordered by score and then
by recency as before. When more than `limit` issues match, the page is the most
recently created matches rather than a read of every match.
"""

from __future__ import annotations

import heapq
import re
from typing import Iterator, Optional

from fastapi import APIRouter, Depends, Path, Query

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.search_index import tokenize
from app.common.issue_keys import current
from app.domains.views.schemas.view import (
    SEARCH_DEFAULT_LIMIT,
    SEARCH_MAX_LIMIT,
    SEARCH_QUERY_MAX,
    SEARCH_QUERY_MIN,
    SearchRead,
    SearchResultRead,
)
from app.domains.views.service import query_too_short, readable_teams

router = APIRouter()

KEY_PATTERN = re.compile(r"^([A-Za-z][A-Za-z0-9]{1,5})-(\d+)$")
"""What counts as an issue key typed into the search box.

The same shape the M2 contract fixes for a key, so `ABC-123` resolves to one issue
rather than being tokenized into terms that would each be dropped as too short.
"""


def parse_key(query: str) -> tuple[str, int] | None:
    """`ABC-123` as its prefix and number, or `None` when it is not a key.

    Case insensitive, and the prefix comes back uppercased, so the lookup matches
    however the caller typed it.
    """
    match = KEY_PATTERN.match(query.strip())
    if match is None:
        return None
    return match.group(1).upper(), int(match.group(2))


def _key_hit(
    repositories: Repositories,
    context: AuthzContext,
    teams: list[str],
    number: int,
    prefix: str,
) -> list[Issue]:
    """The single issue one key names, searched only in teams the caller sees.

    The prefix resolves through the team, so a key under a retired prefix finds
    the same issue its current prefix does.
    """
    team = repositories.teams.get_by_key_prefix(context.workspace_id, prefix)
    if team is None or team.team_id not in teams:
        return []
    issue = repositories.issues.get_by_number(context.workspace_id, team.team_id, number)
    return [issue] if issue is not None else []


def intersect_descending(streams: list[Iterator[str]]) -> Iterator[str]:
    """The ids present in every stream, each stream sorted newest id first.

    A merge join: the lowest head is the only candidate, every stream ahead of it
    is advanced to it, and the id is emitted when all heads agree. Reading stops as
    soon as any stream runs out or the caller stops consuming.
    """
    if not streams:
        return
    heads: list[str] = []
    for stream in streams:
        head = next(stream, None)
        if head is None:
            return
        heads.append(head)
    while True:
        target = min(heads)
        for index, stream in enumerate(streams):
            while heads[index] > target:
                head = next(stream, None)
                if head is None:
                    return
                heads[index] = head
        if all(head == target for head in heads):
            yield target
            for index, stream in enumerate(streams):
                head = next(stream, None)
                if head is None:
                    return
                heads[index] = head


def _matching_ids(
    repositories: Repositories,
    workspace_id: str,
    teams: list[str],
    terms: set[str],
) -> Iterator[str]:
    """Ids of issues matching every term across the teams, newest id first, read lazily."""
    per_team = [
        intersect_descending(
            [repositories.search_index.iter_postings(workspace_id, team_id, term) for term in sorted(terms)]
        )
        for team_id in teams
    ]
    seen: set[str] = set()
    for issue_id in heapq.merge(*per_team, reverse=True):
        if issue_id not in seen:
            seen.add(issue_id)
            yield issue_id


def _first_hits(
    repositories: Repositories,
    context: AuthzContext,
    workspace_id: str,
    matches: Iterator[str],
    limit: int,
) -> list[Issue]:
    """Fetch matches until `limit` visible issues are in hand, never more than the shortfall at once.

    A stale posting whose issue is gone, or an issue the caller cannot see, is
    skipped and the next match is fetched in its place.
    """
    hits: list[Issue] = []
    while len(hits) < limit:
        batch = [issue_id for _, issue_id in zip(range(limit - len(hits)), matches)]
        if not batch:
            break
        issues = repositories.issues.get_many(workspace_id, batch)
        hits.extend(
            issues[issue_id]
            for issue_id in batch
            if issue_id in issues and context.can_see_team(issues[issue_id].team_id)
        )
    return hits


@router.get("/{workspace_id}/search", response_model=SearchRead)
def search(
    workspace_id: str = Path(..., min_length=1),
    q: str = Query(..., min_length=SEARCH_QUERY_MIN, max_length=SEARCH_QUERY_MAX),
    team_id: Optional[str] = Query(default=None),
    limit: int = Query(default=SEARCH_DEFAULT_LIMIT, ge=1, le=SEARCH_MAX_LIMIT),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> SearchRead:
    """Ranked search hits, by matched term count and then by recency."""
    teams = readable_teams(repositories, context, team_id)
    if not teams:
        return SearchRead(results=[])

    parsed = parse_key(q)
    if parsed is not None:
        prefix, number = parsed
        hits = _key_hit(repositories, context, teams, number, prefix)
        return SearchRead(
            results=[SearchResultRead.from_row(current(repositories.teams, issue), score=1) for issue in hits]
        )

    terms = tokenize(q)
    if not terms:
        raise query_too_short()

    score = len(terms)
    hits = _first_hits(
        repositories, context, workspace_id, _matching_ids(repositories, workspace_id, teams, terms), limit
    )
    ordered = sorted(hits, key=lambda row: row.updated_at, reverse=True)
    return SearchRead(
        results=[SearchResultRead.from_row(current(repositories.teams, issue), score=score) for issue in ordered]
    )
