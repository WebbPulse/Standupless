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
"""

from __future__ import annotations

import re
from typing import Optional

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


def _ranked_ids(
    repositories: Repositories,
    workspace_id: str,
    teams: list[str],
    terms: set[str],
) -> dict[str, int]:
    """Each issue id that matched, mapped to how many terms it matched.

    The contract's ranking is an intersection, so only ids matching every term are
    kept; the count is carried through anyway because it is the `score` the shape
    returns and it stays meaningful if the intersection rule is ever loosened.
    """
    counts: dict[str, int] = {}
    for team_id in teams:
        for term in terms:
            for issue_id in repositories.search_index.postings(workspace_id, team_id, term):
                counts[issue_id] = counts.get(issue_id, 0) + 1
    return {issue_id: score for issue_id, score in counts.items() if score == len(terms)}


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

    scores = _ranked_ids(repositories, workspace_id, teams, terms)
    if not scores:
        return SearchRead(results=[])

    issues = repositories.issues.get_many(workspace_id, sorted(scores))
    visible = [issue for issue in issues.values() if context.can_see_team(issue.team_id)]
    ordered = sorted(visible, key=lambda row: (scores[row.issue_id], row.updated_at), reverse=True)
    return SearchRead(
        results=[
            SearchResultRead.from_row(current(repositories.teams, issue), score=scores[issue.issue_id])
            for issue in ordered[:limit]
        ]
    )
