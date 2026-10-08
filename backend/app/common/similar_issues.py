"""Possible duplicates of a draft title, read from the search projection.

Held in `common` because the create dialog reaches it through the views image and
the MCP `create_issue` tool through the integrations image, and neither may import
the other's code. Matching is deterministic: the title is tokenized exactly as the
search consumer indexes issues, every term's newest postings are counted, and an
issue that shares enough terms with the title is a candidate. No model or
embedding is involved.

Cost is bounded per call: at most `MAX_TERMS` terms, one page of at most
`POSTINGS_PER_TERM` postings per term per visible team, and one batch read of at
most `CANDIDATE_CAP` issues. Only open, unarchived issues in teams the caller can
see are answered, so a private team's issues never surface for a non member.
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass
from typing import TYPE_CHECKING

from app.common.db.dynamo.search_index import ranked_terms, tokenize
from app.common.issue_keys import current
from app.common.issue_rules import COMPLETED_CATEGORIES, visible_team_ids

if TYPE_CHECKING:
    from app.common.api.dependencies.authz import AuthzContext
    from app.common.api.dependencies.repositories import Repositories
    from app.common.db.dynamo.issues import Issue
    from app.common.db.dynamo.team_config import Status

MAX_TERMS = 8

POSTINGS_PER_TERM = 200

CANDIDATE_CAP = 20

DEFAULT_LIMIT = 5

MAX_LIMIT = 10


@dataclass(frozen=True)
class SimilarIssue:
    """One possible duplicate: the issue under its current key, its status and its overlap."""

    issue: "Issue"
    status: "Status | None"
    score: int


def required_matches(term_count: int) -> int:
    """How many of the title's terms a candidate must share to count as similar.

    One term must match outright; past that, at least two and at least half, so a
    single shared common word does not flood the list.
    """
    if term_count <= 1:
        return term_count
    return min(term_count, max(2, math.ceil(term_count / 2)))


def title_terms(title: str) -> set[str]:
    """The terms of a draft title the matcher reads, at most `MAX_TERMS`."""
    return ranked_terms(title, cap=MAX_TERMS)


def _counted(repositories: "Repositories", workspace_id: str, teams: list[str], terms: set[str]) -> Counter[str]:
    """Each posted issue id with how many of the terms it is posted under."""
    counts: Counter[str] = Counter()
    for team_id in teams:
        for term in sorted(terms):
            postings = repositories.search_index.iter_postings(
                workspace_id, team_id, term, page_size=POSTINGS_PER_TERM, limit=POSTINGS_PER_TERM
            )
            counts.update(set(postings))
    return counts


def find_similar(
    repositories: "Repositories",
    context: "AuthzContext",
    title: str,
    *,
    limit: int = DEFAULT_LIMIT,
    exclude_issue_id: str | None = None,
) -> list[SimilarIssue]:
    """Open issues in the caller's visible teams whose title shares enough terms with `title`.

    Ranked by how many terms the candidate's own title shares, then by how many
    of its indexed terms match, then by recency. An empty or all short title
    answers nothing rather than reading anything.
    """
    terms = title_terms(title)
    if not terms:
        return []
    teams = visible_team_ids(repositories, context)
    if not teams:
        return []

    workspace_id = context.workspace_id
    floor = required_matches(len(terms))
    counts = _counted(repositories, workspace_id, teams, terms)
    ranked = sorted(
        (issue_id for issue_id, count in counts.items() if count >= floor and issue_id != exclude_issue_id),
        key=lambda issue_id: (counts[issue_id], issue_id),
        reverse=True,
    )[:CANDIDATE_CAP]
    if not ranked:
        return []

    fetched = repositories.issues.get_many(workspace_id, ranked)
    statuses: dict[str, dict[str, "Status"]] = {}
    found: list[tuple[int, SimilarIssue]] = []
    for issue_id in ranked:
        issue = fetched.get(issue_id)
        if issue is None or issue.archived_at is not None or not context.can_see_team(issue.team_id):
            continue
        overlap = len(tokenize(issue.title) & terms)
        if overlap == 0:
            continue
        if issue.team_id not in statuses:
            statuses[issue.team_id] = {
                row.status_id: row for row in repositories.team_config.list_statuses(workspace_id, issue.team_id)
            }
        status = statuses[issue.team_id].get(issue.status_id)
        if status is not None and status.category in COMPLETED_CATEGORIES:
            continue
        similar = SimilarIssue(issue=current(repositories.teams, issue), status=status, score=counts[issue_id])
        found.append((overlap, similar))

    found.sort(key=lambda pair: (pair[0], pair[1].score, pair[1].issue.updated_at), reverse=True)
    return [similar for _, similar in found[: max(1, min(limit, MAX_LIMIT))]]
