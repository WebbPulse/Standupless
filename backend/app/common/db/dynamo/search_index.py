"""The `search_index` table: one row per term per issue, kept by the consumer.

A row's whole content is its key, which is what makes the consumer idempotent: a
replayed record puts the same row and deletes the same absent one. Postings are
partitioned per team so a search never reads across a team boundary and a
large workspace does not put every term in one partition.

Writes never read. Common words are kept out by `STOPWORDS` and one issue by
`TERM_CAP`, and reads are bounded by `POSTING_CAP` per term per team, so no
per-term count is needed to keep a partition in check.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Iterator, Mapping

from boto3.dynamodb.conditions import Key
from webbpulse.dynamodb import Repository

from app.common.db.dynamo.base import build_repository
from app.common.db.dynamo.tables import SEARCH_INDEX

MIN_TERM_LENGTH = 4

BODY_BYTES = 4096

POSTING_CAP = 5000

POSTING_PAGE = 500

TERM_CAP = 200

STOPWORDS = frozenset(
    {
        "about",
        "after",
        "also",
        "been",
        "before",
        "being",
        "could",
        "does",
        "from",
        "have",
        "into",
        "just",
        "more",
        "most",
        "only",
        "other",
        "should",
        "some",
        "such",
        "than",
        "that",
        "their",
        "them",
        "then",
        "there",
        "these",
        "they",
        "this",
        "those",
        "very",
        "were",
        "what",
        "when",
        "where",
        "which",
        "while",
        "will",
        "with",
        "would",
        "your",
    }
)
"""Common English words at or above `MIN_TERM_LENGTH` that would post against most issues."""

_SPLIT = re.compile(r"[^a-z0-9]+")


def search_partition(workspace_id: str, team_id: str) -> str:
    """The partition one team's postings live in, workspace first."""
    return f"{workspace_id}#{team_id}"


def term_doc(term: str, issue_id: str) -> str:
    """The sort key of one term's posting for one issue."""
    return f"{term}#{issue_id}"


def _tokens(*parts: str | None) -> Iterator[str]:
    """Every token of some text at or above the minimum length, in order of appearance."""
    for part in parts:
        if not part:
            continue
        for token in _SPLIT.split(part.lower()):
            if len(token) >= MIN_TERM_LENGTH:
                yield token


def tokenize(*parts: str | None) -> set[str]:
    """The term set of some text, lowercased, split on non-alphanumerics, stopwords dropped.

    Short terms and stopwords match too much to be worth a row, and dropping them at
    both write and read time keeps the index and the query agreeing about what is
    searchable.
    """
    return {token for token in _tokens(*parts) if token not in STOPWORDS}


def ranked_terms(*parts: str | None, cap: int = TERM_CAP) -> set[str]:
    """The first `cap` distinct non-stopword terms, taking earlier parts first."""
    kept: dict[str, None] = {}
    for token in _tokens(*parts):
        if token in STOPWORDS or token in kept:
            continue
        kept[token] = None
        if len(kept) >= cap:
            break
    return set(kept)


def truncate_body(body: str | None) -> str:
    """The leading bytes of a body that the index covers.

    Indexing a whole body would let one long issue dominate a team's partition,
    and the opening of an issue is what a title search is really reaching for.
    """
    if not body:
        return ""
    encoded = body.encode("utf-8")[:BODY_BYTES]
    return encoded.decode("utf-8", errors="ignore")


def _issue_parts(image: Mapping[str, Any]) -> tuple[str | None, str | None, str]:
    """The title, key and indexed body of one issue image, title first."""
    key = image.get("key")
    title = image.get("title")
    body = image.get("body")
    return (
        title if isinstance(title, str) else None,
        key if isinstance(key, str) else None,
        truncate_body(body if isinstance(body, str) else None),
    )


def issue_terms(image: Mapping[str, Any]) -> set[str]:
    """The terms one issue image is posted under: at most `TERM_CAP`, title terms first."""
    if not image:
        return set()
    return ranked_terms(*_issue_parts(image))


def legacy_terms(image: Mapping[str, Any]) -> set[str]:
    """Every term an older indexer could have posted for one image, stopwords and all.

    Postings written before stopwords and the term cap existed are a superset of
    `issue_terms`, so terms that leave the text are deleted from this set too and
    an older row cannot outlive the word it was posted for.
    """
    if not image:
        return set()
    return set(_tokens(*_issue_parts(image)))


class SearchIndexRepository:
    """Maintains and reads the term postings of one team at a time."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(SEARCH_INDEX, repository)

    def postings(self, workspace_id: str, team_id: str, term: str, *, limit: int = POSTING_CAP) -> list[str]:
        """Every issue id posted under one term in one team."""
        if not workspace_id or not team_id or not term:
            return []
        items = self._repository.iter_query(
            Key("ws_team").eq(search_partition(workspace_id, team_id)) & Key("term_doc").begins_with(f"{term}#"),
            max_items=limit,
        )
        return [str(item["term_doc"]).split("#", 1)[1] for item in items]

    def iter_postings(
        self,
        workspace_id: str,
        team_id: str,
        term: str,
        *,
        page_size: int = POSTING_PAGE,
        limit: int = POSTING_CAP,
    ) -> Iterator[str]:
        """Issue ids posted under one term in one team, newest id first, read a page at a time.

        Issue ids are ULIDs, so descending sort-key order is newest-created first and a
        caller that stops early has read only the pages it consumed.
        """
        if not workspace_id or not team_id or not term:
            return
        items = self._repository.iter_query(
            Key("ws_team").eq(search_partition(workspace_id, team_id)) & Key("term_doc").begins_with(f"{term}#"),
            max_items=limit,
            page_size=page_size,
            ascending=False,
        )
        for item in items:
            yield str(item["term_doc"]).split("#", 1)[1]

    def add(self, workspace_id: str, team_id: str, term: str, issue_id: str) -> None:
        """Post one issue under one term, a single put with no read before it."""
        self._repository.put({"ws_team": search_partition(workspace_id, team_id), "term_doc": term_doc(term, issue_id)})

    def remove(self, workspace_id: str, team_id: str, term: str, issue_id: str) -> None:
        """Unpost one issue from one term."""
        self._repository.delete(
            {"ws_team": search_partition(workspace_id, team_id), "term_doc": term_doc(term, issue_id)}
        )

    def apply(
        self,
        workspace_id: str,
        team_id: str,
        issue_id: str,
        *,
        appeared: Iterable[str],
        departed: Iterable[str],
    ) -> None:
        """Write the terms an edit added and delete the ones it took away.

        Only the difference is written, so editing one word of a long body costs two
        rows rather than a rewrite of the issue's whole term set.
        """
        for term in sorted(set(departed)):
            self.remove(workspace_id, team_id, term, issue_id)
        for term in sorted(set(appeared)):
            self.add(workspace_id, team_id, term, issue_id)

    def delete_team_page(self, workspace_id: str, team_id: str, *, limit: int = 100) -> int:
        """Remove one page of a team's postings and its marker, returning how many went.

        The team purge calls this until it answers zero, so a partition of any size
        is removed inside the consumer's time budget one page at a time.
        """
        partition = search_partition(workspace_id, team_id)
        page = self._repository.query(Key("ws_team").eq(partition), limit=limit)
        if not page.items:
            return 0
        return self._repository.delete_many(
            [{"ws_team": partition, "term_doc": item["term_doc"]} for item in page.items]
        )
