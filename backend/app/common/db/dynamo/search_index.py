"""The `search_index` table: one row per term per issue, kept by the consumer.

A row's whole content is its key, which is what makes the consumer idempotent: a
replayed record puts the same row and deletes the same absent one. Postings are
partitioned per team so a search never reads across a team boundary and a
large workspace does not put every term in one partition.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Mapping

from boto3.dynamodb.conditions import Key
from webbpulse.dynamodb import Repository

from app.common.db.dynamo.base import build_repository
from app.common.db.dynamo.tables import SEARCH_INDEX

MIN_TERM_LENGTH = 4

BODY_BYTES = 4096

POSTING_CAP = 5000

MARKER_SORT_KEY = "__marker__"

_SPLIT = re.compile(r"[^a-z0-9]+")


def search_partition(workspace_id: str, team_id: str) -> str:
    """The partition one team's postings live in, workspace first."""
    return f"{workspace_id}#{team_id}"


def term_doc(term: str, issue_id: str) -> str:
    """The sort key of one term's posting for one issue."""
    return f"{term}#{issue_id}"


def tokenize(*parts: str | None) -> set[str]:
    """The term set of some text, lowercased and split on non-alphanumerics.

    Terms shorter than the minimum are dropped because they match too much to be
    worth a row, and dropping them at both write and read time keeps the index and
    the query agreeing about what is searchable.
    """
    terms: set[str] = set()
    for part in parts:
        if not part:
            continue
        for token in _SPLIT.split(part.lower()):
            if len(token) >= MIN_TERM_LENGTH:
                terms.add(token)
    return terms


def truncate_body(body: str | None) -> str:
    """The leading bytes of a body that the index covers.

    Indexing a whole body would let one long issue dominate a team's partition,
    and the opening of an issue is what a title search is really reaching for.
    """
    if not body:
        return ""
    encoded = body.encode("utf-8")[:BODY_BYTES]
    return encoded.decode("utf-8", errors="ignore")


def issue_terms(image: Mapping[str, Any]) -> set[str]:
    """Every searchable term of one issue image."""
    if not image:
        return set()
    key = image.get("key")
    title = image.get("title")
    body = image.get("body")
    return tokenize(
        key if isinstance(key, str) else None,
        title if isinstance(title, str) else None,
        truncate_body(body if isinstance(body, str) else None),
    )


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

    def posting_count(self, workspace_id: str, team_id: str, term: str) -> int:
        """How many issues a term is posted against, counted no further than the cap."""
        return len(self.postings(workspace_id, team_id, term, limit=POSTING_CAP + 1))

    def add(self, workspace_id: str, team_id: str, term: str, issue_id: str) -> bool:
        """Post one issue under one term unless the term is already at its cap.

        A term past the cap is one that matches so much of a team that its
        postings cost more than they narrow, so the write is skipped and the term
        is recorded as truncated rather than letting one partition grow without a
        bound.
        """
        partition = search_partition(workspace_id, team_id)
        if self.posting_count(workspace_id, team_id, term) >= POSTING_CAP:
            self.record_truncated(workspace_id, team_id, term)
            return False
        self._repository.put({"ws_team": partition, "term_doc": term_doc(term, issue_id)})
        return True

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

    def record_truncated(self, workspace_id: str, team_id: str, term: str) -> None:
        """Note that a term stopped taking postings in this team.

        Kept on one marker row per team so an operator can see which terms are
        answering partial results without a table scan.
        """
        self._repository.update(
            {"ws_team": search_partition(workspace_id, team_id), "term_doc": MARKER_SORT_KEY},
            update_expression="ADD #truncated :term",
            expression_names={"#truncated": "truncated"},
            expression_values={":term": {term}},
        )

    def truncated_terms(self, workspace_id: str, team_id: str) -> set[str]:
        """Every term that has stopped taking postings in this team."""
        item = self._repository.get({"ws_team": search_partition(workspace_id, team_id), "term_doc": MARKER_SORT_KEY})
        if item is None:
            return set()
        stored = item.get("truncated")
        return {str(term) for term in stored} if stored else set()
