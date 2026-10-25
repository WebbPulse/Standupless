"""The search route, reading the projection the search consumer maintains.

Scope is fail-closed by construction: `ws_team` begins with the workspace id, so
there is no cross-workspace read to prevent, and without an explicit team the
fan-out covers exactly the teams the caller can see, which for a guest is the
teams they hold a membership in.

A key lookup short-circuits the term index. Typing `ABC-123` is meant to be
exact rather than a relevance guess, so it is answered from
`ws_team-key_number-index`. A single token with punctuation in it, a key among
them, is also looked up as the source key an imported issue was posted under,
so the key an issue had in the tool it came from still finds it.

Search is not paged. The MVP caps at `limit` and says so; a cursor over an
intersection of posting lists is a post-MVP decision alongside the OpenSearch one.

A query matches its last word as a prefix and every other word whole, as
`SearchQuery` reads it: the prefix is answered by the word posted whole or by
its `p:` prefix posting, and a prefix longer than any posted one is checked
against the hit's own text. Projects, initiatives and documents are matched the
same way against their words in memory.

Term search walks each term's postings newest issue id first and intersects them
as a merge join, one page at a time, so it stops reading once `limit` matches are
found. Only those matches are fetched, and the page is ordered by score and then
by recency as before. When more than `limit` issues match, the page is the most
recently created matches rather than a read of every match.

Comments are posted in the same partitions under `c:` prefixed terms, so a
comment search is the same merge join over the same teams, and a hit is shown
only when its issue still exists in a team the caller sees. Comments on documents
sit in the workspace's `DOCUMENT_COMMENTS` slot and are answered alongside
document hits, each checked against the parents the caller reads. Projects and
initiatives are few per workspace, so they are matched in memory against one
read of each, the same read the documents search already makes, with the
visibility the project and initiative reads apply: a project is visible through
any one of its teams and initiatives are hidden from guests.

Issue hits carry their status, read once per team the page touches, and a
status filter narrows only the issue hits.
"""

from __future__ import annotations

import heapq
import re
from typing import Callable, Iterator, Optional

from fastapi import APIRouter, Depends, Path, Query

from app.common.api.dependencies.authz import ActorKind, AuthzContext, Capability, missing_scopes, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.dependencies.scopes import PROJECTS_READ
from app.common.api.schemas.documents import DocumentSummaryRead
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.search_index import (
    DOCUMENT_COMMENTS,
    SearchQuery,
    comment_term,
    parse_query,
    ref_term,
    split_comment_doc,
    truncate_body,
)
from app.common.db.dynamo.team_config import Status
from app.common.documents import readable_parents, search_documents
from app.common.issue_keys import current
from app.common.issue_move import find_issue_by_number
from app.common.issue_rules import TRIAGE_STATUS_CATEGORY, TRIAGE_STATUS_ID, TRIAGE_STATUS_NAME
from app.common.planning_rules import visible_project_teams
from app.common.similar_issues import DEFAULT_LIMIT as SIMILAR_DEFAULT_LIMIT
from app.common.similar_issues import MAX_LIMIT as SIMILAR_MAX_LIMIT
from app.common.similar_issues import SimilarIssue, find_similar
from app.domains.views.schemas.view import (
    SEARCH_DEFAULT_LIMIT,
    SEARCH_MAX_LIMIT,
    SEARCH_QUERY_MAX,
    SEARCH_QUERY_MIN,
    SEARCH_TYPES,
    SearchCommentRead,
    SearchInitiativeRead,
    SearchProjectRead,
    SearchRead,
    SearchResultRead,
    SearchTypeField,
    SimilarIssueRead,
    SimilarListRead,
)
from app.domains.views.service import query_too_short, readable_teams

router = APIRouter()

SNIPPET_BEFORE = 60
"""How many characters of a comment the excerpt keeps ahead of the first match."""

SNIPPET_LENGTH = 180
"""The longest excerpt a comment hit carries, ellipses aside."""

IssuePredicate = Callable[[Issue], bool]

KEY_PATTERN = re.compile(r"^([A-Za-z][A-Za-z0-9]{1,5})-(\d+)$")
"""What counts as an issue key typed into the search box.

The same shape the M2 contract fixes for a key, so `ABC-123` resolves to one issue
rather than being tokenized into a word search that would match far more.
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
    the same issue its current prefix does, and a key the issue held before it
    moved finds it in its new team when the caller can see that team.
    """
    team = repositories.teams.get_by_key_prefix(context.workspace_id, prefix)
    if team is None:
        return []
    issue = find_issue_by_number(repositories, context.workspace_id, team.team_id, number)
    return [issue] if issue is not None and issue.team_id in teams else []


def source_ref_term(query: str) -> str | None:
    """The source key term a query is looked up under, or `None` when it is not key-like.

    Only one token with punctuation in it is treated as a key, so ordinary words
    keep to the term index.
    """
    text = query.strip()
    if not text or any(char.isspace() for char in text) or text.isalnum():
        return None
    return ref_term(text)


def _ref_hits(
    repositories: Repositories,
    context: AuthzContext,
    workspace_id: str,
    teams: list[str],
    query: str,
    limit: int,
    keep: IssuePredicate | None = None,
) -> list[Issue]:
    """Imported issues whose source key is the query, in teams the caller sees."""
    term = source_ref_term(query)
    if term is None or not teams:
        return []
    matches = _matching_ids(repositories, workspace_id, teams, [[term]])
    return _first_hits(repositories, context, workspace_id, matches, limit, keep)


def _merge_hits(first: list[Issue], second: list[Issue], limit: int) -> list[Issue]:
    """Both lists in order with repeats dropped, at most `limit` issues."""
    merged: dict[str, Issue] = {}
    for issue in (*first, *second):
        merged.setdefault(issue.issue_id, issue)
    return list(merged.values())[:limit]


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


def union_descending(streams: list[Iterator[str]]) -> Iterator[str]:
    """The ids in any stream, each stream sorted newest id first, once each and in the same order."""
    previous: str | None = None
    for item in heapq.merge(*streams, reverse=True):
        if item != previous:
            previous = item
            yield item


def _clause_stream(repositories: Repositories, workspace_id: str, team_id: str, terms: list[str]) -> Iterator[str]:
    """Ids posted under any of one clause's terms in one team, newest id first."""
    streams = [repositories.search_index.iter_postings(workspace_id, team_id, term) for term in terms]
    return streams[0] if len(streams) == 1 else union_descending(streams)


def _matching_ids(
    repositories: Repositories,
    workspace_id: str,
    teams: list[str],
    clauses: list[list[str]],
) -> Iterator[str]:
    """Ids of issues matching every clause across the teams, newest id first, read lazily."""
    per_team = [
        intersect_descending([_clause_stream(repositories, workspace_id, team_id, terms) for terms in clauses])
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
    keep: IssuePredicate | None = None,
) -> list[Issue]:
    """Fetch matches until `limit` visible issues are in hand, never more than the shortfall at once.

    A stale posting whose issue is gone, an issue the caller cannot see, or one
    `keep` turns away is skipped and the next match is fetched in its place.
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
            if issue_id in issues
            and context.can_see_team(issues[issue_id].team_id)
            and (keep is None or keep(issues[issue_id]))
        )
    return hits


class StatusBook:
    """Each team's statuses by id, read once per team a page of hits touches."""

    def __init__(self, repositories: Repositories, workspace_id: str) -> None:
        """Hold the bundle and workspace the reads are made against."""
        self._repositories = repositories
        self._workspace_id = workspace_id
        self._teams: dict[str, dict[str, Status]] = {}

    def status_of(self, issue: Issue) -> Status | None:
        """The status one issue is in, or `None` when its team no longer has it."""
        statuses = self._teams.get(issue.team_id)
        if statuses is None:
            rows = self._repositories.team_config.list_statuses(self._workspace_id, issue.team_id)
            statuses = {row.status_id: row for row in rows}
            self._teams[issue.team_id] = statuses
        return statuses.get(issue.status_id)


def status_filter(book: StatusBook, status_ids: list[str], categories: list[str]) -> IssuePredicate | None:
    """The predicate a status filter narrows issue hits by, or `None` when nothing is filtered.

    `triage` names the issues awaiting triage, as the issue list filter does, and
    a triaged issue reads as the triage status's category.
    """
    if not status_ids and not categories:
        return None
    wanted_ids = set(status_ids)
    wanted_categories = set(categories)

    def keep(issue: Issue) -> bool:
        """Whether one issue's status is among those asked for."""
        if issue.in_triage:
            return TRIAGE_STATUS_ID in wanted_ids or TRIAGE_STATUS_CATEGORY in wanted_categories
        if issue.status_id in wanted_ids:
            return True
        if not wanted_categories:
            return False
        status = book.status_of(issue)
        return status is not None and status.category in wanted_categories

    return keep


def prefix_check(query: SearchQuery, keep: IssuePredicate | None) -> IssuePredicate | None:
    """`keep`, also turning away an issue whose text lacks the prefix when the postings alone cannot tell."""
    if not query.needs_check:
        return keep

    def checked(issue: Issue) -> bool:
        """Whether one issue's indexed text holds the prefix and `keep` takes it."""
        if not query.prefix_in(issue.title, issue.key, truncate_body(issue.body)):
            return False
        return keep is None or keep(issue)

    return checked


def _issue_reads(
    repositories: Repositories, book: StatusBook, issues: list[Issue], score: int
) -> list[SearchResultRead]:
    """The issue hits as rows, each under its current key and with its status."""
    return [
        SearchResultRead.from_row(current(repositories.teams, issue), score=score, status=book.status_of(issue))
        for issue in issues
    ]


def _reads_projects(context: AuthzContext) -> bool:
    """Whether a caller may see project-level results: any person, or a key holding the projects scope."""
    return context.actor is ActorKind.USER or not missing_scopes(context.scopes, PROJECTS_READ)


def _document_hits(
    repositories: Repositories, context: AuthzContext, team_id: Optional[str], query: SearchQuery, limit: int
) -> list[DocumentSummaryRead]:
    """Documents matching the query, for a workspace-wide search by a caller who may read projects.

    A search narrowed to one team skips them, since a document belongs to a
    project or an initiative rather than a team, and a key without the projects
    scope never sees them.
    """
    if team_id or not _reads_projects(context):
        return []
    return search_documents(repositories, context, query, limit)


def _name_first(name: str, query: SearchQuery) -> bool:
    """Whether the name alone matches the query, which ranks a hit ahead of a description match."""
    return query.matches_text(name)


def _project_hits(
    repositories: Repositories,
    context: AuthzContext,
    teams: list[str],
    query: SearchQuery,
    limit: int,
) -> list[SearchProjectRead]:
    """Projects on a team the caller sees whose name or description matches the query, name matches first."""
    if not _reads_projects(context):
        return []
    visible = set(teams)
    hits: list[tuple[SearchProjectRead, bool]] = []
    for project in repositories.planning.list_projects(context.workspace_id):
        shown = visible_project_teams(project, visible)
        if not shown or not query.matches_text(project.name, project.description):
            continue
        hits.append(
            (
                SearchProjectRead(
                    project_id=project.project_id,
                    name=project.name,
                    status=project.status,
                    health=project.health,
                    icon=project.icon,
                    color=project.color,
                    lead_id=project.lead_id,
                    team_ids=shown,
                    target_date=project.target_date,
                    updated_at=project.updated_at,
                ),
                _name_first(project.name, query),
            )
        )
    hits.sort(key=lambda hit: (not hit[1], -hit[0].updated_at.timestamp()))
    return [read for read, _ in hits[:limit]]


def _initiative_hits(
    repositories: Repositories, context: AuthzContext, team_id: Optional[str], query: SearchQuery, limit: int
) -> list[SearchInitiativeRead]:
    """Initiatives whose name or description matches the query, for a workspace-wide search by a non-guest.

    An initiative belongs to no team, so a search narrowed to one skips them, as
    it does documents.
    """
    if team_id or context.is_guest or not _reads_projects(context):
        return []
    hits: list[tuple[SearchInitiativeRead, bool]] = [
        (
            SearchInitiativeRead(
                initiative_id=initiative.initiative_id,
                name=initiative.name,
                status=initiative.status,
                health=initiative.health,
                owner_id=initiative.owner_id,
                target_date=initiative.target_date,
                updated_at=initiative.updated_at,
            ),
            _name_first(initiative.name, query),
        )
        for initiative in repositories.planning.list_initiatives(context.workspace_id)
        if query.matches_text(initiative.name, initiative.description)
    ]
    hits.sort(key=lambda hit: (not hit[1], -hit[0].updated_at.timestamp()))
    return [read for read, _ in hits[:limit]]


def snippet(body: str, terms: set[str]) -> str:
    """An excerpt of a comment around its first matching term, whitespace collapsed and trimmed with ellipses."""
    text = " ".join(body.split())
    lowered = text.lower()
    found = [index for index in (lowered.find(term) for term in terms) if index >= 0]
    start = max(0, min(found) - SNIPPET_BEFORE) if found else 0
    end = min(len(text), start + SNIPPET_LENGTH)
    excerpt = text[start:end].strip()
    return f"{'... ' if start > 0 else ''}{excerpt}{' ...' if end < len(text) else ''}"


def _comment_hits(
    repositories: Repositories,
    context: AuthzContext,
    workspace_id: str,
    teams: list[str],
    query: SearchQuery,
    limit: int,
) -> list[SearchCommentRead]:
    """Comments matching the query, newest first, on issues that exist in a team the caller sees.

    Read like issue hits: the postings are merged lazily and fetched a shortfall
    at a time, so a stale posting or one on an issue out of sight is skipped and
    replaced rather than shrinking the page.
    """
    if not teams:
        return []
    clauses = [[comment_term(term) for term in clause] for clause in query.clauses()]
    matches = _matching_ids(repositories, workspace_id, teams, clauses)
    hits: list[SearchCommentRead] = []
    while len(hits) < limit:
        batch = [split_comment_doc(doc) for _, doc in zip(range(limit - len(hits)), matches)]
        if not batch:
            break
        wanted = [pair for pair in batch if pair is not None]
        issues = repositories.issues.get_many(workspace_id, sorted({issue_id for _, issue_id in wanted}))
        for comment_id, issue_id in wanted:
            issue = issues.get(issue_id)
            if issue is None or not context.can_see_team(issue.team_id):
                continue
            comment = repositories.comments.get(workspace_id, issue_id, comment_id)
            if comment is None or (query.needs_check and not query.prefix_in(comment.body)):
                continue
            shown = current(repositories.teams, issue)
            hits.append(
                SearchCommentRead(
                    comment_id=comment.comment_id,
                    issue_id=issue.issue_id,
                    issue_key=shown.key,
                    issue_title=issue.title,
                    team_id=issue.team_id,
                    author_id=comment.author_id,
                    snippet=snippet(comment.body, query.highlights),
                    created_at=comment.created_at,
                )
            )
    return hits[:limit]


def _document_comment_hits(
    repositories: Repositories,
    context: AuthzContext,
    workspace_id: str,
    team_id: Optional[str],
    query: SearchQuery,
    limit: int,
) -> list[SearchCommentRead]:
    """Comments on documents the caller reads that match the query, newest first.

    Answered on the same terms as document hits: a workspace-wide search by a
    caller who may read projects. Each hit's document is checked against the
    parents the caller reads, so a posting on a document out of sight or gone is
    skipped and replaced rather than shrinking the page.
    """
    if team_id or not _reads_projects(context):
        return []
    clauses = [[comment_term(term) for term in clause] for clause in query.clauses()]
    matches = _matching_ids(repositories, workspace_id, [DOCUMENT_COMMENTS], clauses)
    parents = readable_parents(repositories, context)
    hits: list[SearchCommentRead] = []
    while len(hits) < limit:
        batch = [split_comment_doc(doc) for _, doc in zip(range(limit - len(hits)), matches)]
        if not batch:
            break
        for pair in batch:
            if pair is None:
                continue
            comment_id, document_id = pair
            found = repositories.documents.get(workspace_id, document_id)
            if found is None or (found[0].parent_kind, found[0].parent_id) not in parents:
                continue
            comment = repositories.comments.get(workspace_id, document_id, comment_id)
            if comment is None or (query.needs_check and not query.prefix_in(comment.body)):
                continue
            hits.append(
                SearchCommentRead(
                    comment_id=comment.comment_id,
                    issue_id=document_id,
                    issue_key="",
                    issue_title="",
                    team_id="",
                    author_id=comment.author_id,
                    snippet=snippet(comment.body, query.highlights),
                    created_at=comment.created_at,
                    document_id=document_id,
                    document_title=found[0].title,
                )
            )
    return hits[:limit]


def _comments(
    repositories: Repositories,
    context: AuthzContext,
    workspace_id: str,
    teams: list[str],
    team_id: Optional[str],
    query: SearchQuery,
    limit: int,
) -> list[SearchCommentRead]:
    """Issue and document comment hits together, newest first, capped at `limit`."""
    merged = [
        *_comment_hits(repositories, context, workspace_id, teams, query, limit),
        *_document_comment_hits(repositories, context, workspace_id, team_id, query, limit),
    ]
    merged.sort(key=lambda hit: hit.created_at, reverse=True)
    return merged[:limit]


@router.get("/{workspace_id}/search", response_model=SearchRead)
def search(
    workspace_id: str = Path(..., min_length=1),
    q: str = Query(..., min_length=SEARCH_QUERY_MIN, max_length=SEARCH_QUERY_MAX),
    team_id: Optional[str] = Query(default=None),
    kinds_wanted: Optional[list[SearchTypeField]] = Query(default=None, alias="type"),
    status_id: Optional[list[str]] = Query(default=None),
    status_category: Optional[list[str]] = Query(default=None),
    limit: int = Query(default=SEARCH_DEFAULT_LIMIT, ge=1, le=SEARCH_MAX_LIMIT),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> SearchRead:
    """Ranked search hits grouped by kind: issues by matched term count and then recency, the rest by recency.

    `type` narrows the kinds answered, every kind when absent, and `status_id`
    and `status_category` narrow the issue hits alone. An issue key or a source
    key answers issues only.
    """
    kinds = set(kinds_wanted or SEARCH_TYPES)
    teams = readable_teams(repositories, context, team_id)
    book = StatusBook(repositories, workspace_id)
    keep = status_filter(book, status_id or [], status_category or [])
    parsed = parse_key(q)
    if parsed is not None:
        if not teams or "issues" not in kinds:
            return SearchRead(results=[])
        prefix, number = parsed
        hits = _merge_hits(
            [issue for issue in _key_hit(repositories, context, teams, number, prefix) if keep is None or keep(issue)],
            _ref_hits(repositories, context, workspace_id, teams, q, limit, keep),
            limit,
        )
        return SearchRead(results=_issue_reads(repositories, book, hits, 1))

    query = parse_query(q)
    referenced = _ref_hits(repositories, context, workspace_id, teams, q, limit, keep) if "issues" in kinds else []
    if not query:
        if not teams:
            return SearchRead(results=[])
        if referenced:
            return SearchRead(results=_issue_reads(repositories, book, referenced, 1))
        raise query_too_short()

    documents = _document_hits(repositories, context, team_id, query, limit) if "documents" in kinds else []
    initiatives = _initiative_hits(repositories, context, team_id, query, limit) if "initiatives" in kinds else []
    if not teams:
        return SearchRead(results=[], documents=documents, initiatives=initiatives)

    projects = _project_hits(repositories, context, teams, query, limit) if "projects" in kinds else []
    comments = (
        _comments(repositories, context, workspace_id, teams, team_id, query, limit) if "comments" in kinds else []
    )
    results: list[SearchResultRead] = []
    if "issues" in kinds:
        matches = _matching_ids(repositories, workspace_id, teams, query.clauses())
        hits = _first_hits(repositories, context, workspace_id, matches, limit, prefix_check(query, keep))
        ordered = _merge_hits(referenced, sorted(hits, key=lambda row: row.updated_at, reverse=True), limit)
        results = _issue_reads(repositories, book, ordered, query.size)
    return SearchRead(
        results=results,
        documents=documents,
        projects=projects,
        initiatives=initiatives,
        comments=comments,
    )


@router.get("/{workspace_id}/search/similar", response_model=SimilarListRead)
def similar(
    workspace_id: str = Path(..., min_length=1),
    title: str = Query(..., min_length=SEARCH_QUERY_MIN, max_length=SEARCH_QUERY_MAX),
    exclude_issue_id: Optional[str] = Query(default=None),
    team_id: Optional[str] = Query(default=None),
    limit: int = Query(default=SIMILAR_DEFAULT_LIMIT, ge=1, le=SIMILAR_MAX_LIMIT),
    context: AuthzContext = Depends(require(Capability.WORKSPACE_READ)),
    repositories: Repositories = Depends(get_repositories),
) -> SimilarListRead:
    """Open issues whose titles share terms with a draft title, for the create dialog.

    A title with no searchable term answers an empty list rather than the 422
    search gives, because the dialog asks while the person is still typing.
    `team_id` is the draft's team, whose matches rank first.
    """
    hits = find_similar(repositories, context, title, limit=limit, exclude_issue_id=exclude_issue_id, team_id=team_id)
    return SimilarListRead(results=[_similar_read(hit) for hit in hits])


def _similar_read(hit: SimilarIssue) -> SimilarIssueRead:
    """One possible duplicate as the dialog lists it, under the synthetic triage status while it waits there."""
    if hit.issue.in_triage:
        status_id, status_name, status_category = TRIAGE_STATUS_ID, TRIAGE_STATUS_NAME, TRIAGE_STATUS_CATEGORY
        status_color = status_icon = None
    else:
        status_id = hit.issue.status_id
        status_name = hit.status.name if hit.status else None
        status_category = hit.status.category if hit.status else None
        status_color = hit.status.color if hit.status else None
        status_icon = hit.status.icon if hit.status else None
    return SimilarIssueRead(
        issue_id=hit.issue.issue_id,
        key=hit.issue.key,
        title=hit.issue.title,
        team_id=hit.issue.team_id,
        status_id=status_id,
        status_name=status_name,
        status_category=status_category,
        status_color=status_color,
        status_icon=status_icon,
        score=hit.score,
    )
