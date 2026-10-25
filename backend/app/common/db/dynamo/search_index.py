"""The `search_index` table: one row per term per issue, kept by the consumer.

A row's whole content is its key, which is what makes the consumer idempotent: a
replayed record puts the same row and deletes the same absent one. Postings are
partitioned per team so a search never reads across a team boundary and a
large workspace does not put every term in one partition.

Writes never read. Common words are kept out by `STOPWORDS` and one issue by
`TERM_CAP`, and reads are bounded by `POSTING_CAP` per term per team, so no
per-term count is needed to keep a partition in check.

Words of `MIN_TERM_LENGTH` or more are posted whole, and the leading
`PREFIX_MIN` to `PREFIX_MAX` characters of each word, short of the word itself,
are posted under `p:` terms so a word still being typed finds the words it
starts. Prefixes come from the earliest words first and stop at `PREFIX_CAP`
per issue, so one issue holds at most `TERM_CAP + PREFIX_CAP` postings plus its
source key. A query matches its last word as a prefix and every other word
whole, as `SearchQuery` describes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable, Iterator, Mapping

from boto3.dynamodb.conditions import Key
from webbpulse.dynamodb import Repository

from app.common.db.dynamo.base import build_repository
from app.common.db.dynamo.tables import SEARCH_INDEX

MIN_TERM_LENGTH = 2

PREFIX_MIN = 3

PREFIX_MAX = 6

PREFIX_CAP = 100

PREFIX_MARK = "p:"

BODY_BYTES = 4096

POSTING_CAP = 5000

POSTING_PAGE = 500

TERM_CAP = 200

REF_PREFIX = "ref:"

REF_MAX = 128

COMMENT_PREFIX = "c:"

STOPWORDS = frozenset(
    {
        "an",
        "as",
        "at",
        "be",
        "by",
        "if",
        "in",
        "is",
        "it",
        "of",
        "on",
        "or",
        "so",
        "to",
        "we",
        "and",
        "are",
        "but",
        "for",
        "had",
        "has",
        "its",
        "our",
        "the",
        "was",
        "you",
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
"""Common English words at or above `MIN_TERM_LENGTH` that would post against most issues, never posted whole."""

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

    Single characters and stopwords match too much to be worth a row, and dropping them at
    both write and read time keeps the index and the query agreeing about what is
    searchable.
    """
    return {token for token in _tokens(*parts) if token not in STOPWORDS}


def _ranked(*parts: str | None, cap: int = TERM_CAP) -> list[str]:
    """The first `cap` distinct non-stopword terms in order, taking earlier parts first."""
    kept: dict[str, None] = {}
    for token in _tokens(*parts):
        if token in STOPWORDS or token in kept:
            continue
        kept[token] = None
        if len(kept) >= cap:
            break
    return list(kept)


def ranked_terms(*parts: str | None, cap: int = TERM_CAP) -> set[str]:
    """The first `cap` distinct non-stopword terms, taking earlier parts first."""
    return set(_ranked(*parts, cap=cap))


def prefix_term(prefix: str) -> str:
    """The posting term a word prefix is filed under, kept apart from whole words."""
    return f"{PREFIX_MARK}{prefix[:PREFIX_MAX]}"


def prefix_terms(words: Iterable[str], cap: int = PREFIX_CAP) -> set[str]:
    """The prefix terms of some words in order, `PREFIX_MIN` to `PREFIX_MAX` long, shorter than the word, at most `cap`."""
    kept: dict[str, None] = {}
    for word in words:
        for length in range(PREFIX_MIN, min(len(word) - 1, PREFIX_MAX) + 1):
            term = prefix_term(word[:length])
            if term in kept:
                continue
            if len(kept) >= cap:
                return set(kept)
            kept[term] = None
    return set(kept)


def indexed_terms(*parts: str | None, cap: int = TERM_CAP, prefix_cap: int = PREFIX_CAP) -> set[str]:
    """The word and prefix terms some text is posted under, earlier parts first, before any namespace is applied.

    Each indexed kind, issues and comments today, posts this set under its own
    namespace, so a new kind only needs a namespace and the text it covers.
    """
    words = _ranked(*parts, cap=cap)
    return set(words) | prefix_terms(words, cap=prefix_cap)


@dataclass(frozen=True)
class SearchQuery:
    """What a typed query asks the index for: whole words, and the last word as a prefix.

    `words` must each be posted whole. `prefix` is the last word when it is at
    least `PREFIX_MIN` long, and matches any word it starts, the word itself
    included; a shorter last word is one of `words`. A stopword is never a whole
    word but can still be a prefix, so "the" finds "theme".
    """

    words: frozenset[str]
    prefix: str | None = None

    def __bool__(self) -> bool:
        """Whether the query asks for anything at all."""
        return bool(self.words or self.prefix)

    @property
    def size(self) -> int:
        """How many words the query matches on, the prefix counted once."""
        return len(self.words) + (1 if self.prefix else 0)

    @property
    def highlights(self) -> set[str]:
        """The words and the prefix, for marking where a hit matched."""
        return set(self.words) | ({self.prefix} if self.prefix else set())

    @property
    def needs_check(self) -> bool:
        """Whether the prefix outruns the posted prefixes, so a posting hit must be checked against its text."""
        return self.prefix is not None and len(self.prefix) > PREFIX_MAX

    def clauses(self) -> list[list[str]]:
        """The postings each hit must be in, one clause per word, a hit in any term of a clause satisfying it."""
        clauses = [[word] for word in sorted(self.words)]
        if self.prefix:
            alternatives = [] if self.prefix in STOPWORDS else [self.prefix]
            clauses.append([*alternatives, prefix_term(self.prefix)])
        return clauses

    def matches(self, tokens: Iterable[str]) -> bool:
        """Whether some terms hold every word whole and a word the prefix starts."""
        held = set(tokens)
        if not self or not self.words.issubset(held):
            return False
        prefix = self.prefix
        return prefix is None or any(token.startswith(prefix) for token in held)

    def matches_text(self, *parts: str | None) -> bool:
        """Whether some text, tokenized as the index tokenizes it, matches the query."""
        return self.matches(_tokens(*parts))

    def prefix_in(self, *parts: str | None) -> bool:
        """Whether some text holds a word the prefix starts, true when there is no prefix."""
        prefix = self.prefix
        return prefix is None or any(token.startswith(prefix) for token in _tokens(*parts))


def parse_query(text: str | None) -> SearchQuery:
    """A typed query as whole words and a last-word prefix, stopwords dropped from the whole words."""
    tokens = list(_tokens(text))
    if not tokens:
        return SearchQuery(words=frozenset())
    last = tokens[-1]
    words = {token for token in tokens[:-1] if token not in STOPWORDS}
    if len(last) >= PREFIX_MIN:
        return SearchQuery(words=frozenset(words - {last}), prefix=last)
    if last not in STOPWORDS:
        words.add(last)
    return SearchQuery(words=frozenset(words))


def truncate_body(body: str | None) -> str:
    """The leading bytes of a body that the index covers.

    Indexing a whole body would let one long issue dominate a team's partition,
    and the opening of an issue is what a title search is really reaching for.
    """
    if not body:
        return ""
    encoded = body.encode("utf-8")[:BODY_BYTES]
    return encoded.decode("utf-8", errors="ignore")


def ref_term(ref: str | None) -> str | None:
    """The one term an imported issue's source key is posted under, or `None` when there is none.

    A source key such as `PROJ-12` splits into terms that would match too
    widely, so the whole key is posted as one term instead, lowercased with every run of
    punctuation turned into a hyphen. The `ref:` prefix keeps it apart from word
    terms, and the result never holds `#`, which separates a term from its issue id.
    """
    if not ref:
        return None
    slug = _SPLIT.sub("-", ref.lower()).strip("-")[:REF_MAX].strip("-")
    return f"{REF_PREFIX}{slug}" if slug else None


def _ref_terms(image: Mapping[str, Any]) -> set[str]:
    """The source key term of one issue image, as a set of at most one."""
    ref = image.get("external_ref")
    term = ref_term(ref if isinstance(ref, str) else None)
    return {term} if term else set()


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
    """The terms one issue image is posted under: its word and prefix terms, title first, and its source key."""
    if not image:
        return set()
    return indexed_terms(*_issue_parts(image)) | _ref_terms(image)


def comment_term(term: str) -> str:
    """The posting term one word of a comment is filed under, kept apart from issue terms.

    Issue terms are alphanumeric or carry `ref:`, so the `c:` prefix means a
    comment never answers an issue search and an issue never answers a comment one.
    """
    return f"{COMMENT_PREFIX}{term}"


def comment_doc(comment_id: str, issue_id: str) -> str:
    """The posting id of one comment: its own id first, so postings read newest comment first."""
    return f"{comment_id}#{issue_id}"


def split_comment_doc(doc: str) -> tuple[str, str] | None:
    """A comment posting id as its comment and issue ids, or `None` when it is malformed."""
    comment_id, separator, issue_id = doc.partition("#")
    return (comment_id, issue_id) if separator and comment_id and issue_id else None


def comment_terms(image: Mapping[str, Any]) -> set[str]:
    """The `c:` terms one comment image is posted under, its word and prefix terms."""
    if not image:
        return set()
    body = image.get("body")
    return {comment_term(term) for term in indexed_terms(truncate_body(body if isinstance(body, str) else None))}


def legacy_terms(image: Mapping[str, Any]) -> set[str]:
    """Every term an older indexer could have posted for one image, stopwords and all.

    Postings written before stopwords and the term cap existed are a superset of
    `issue_terms`, so terms that leave the text are deleted from this set too and
    an older row cannot outlive the word it was posted for.
    """
    if not image:
        return set()
    return set(_tokens(*_issue_parts(image))) | _ref_terms(image)


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

    def iter_team(self, workspace_id: str, team_id: str) -> Iterator[tuple[str, str]]:
        """Every posting of one team as `(term, doc)`, for a reindex to compare against what it should hold."""
        if not workspace_id or not team_id:
            return
        items = self._repository.iter_query(Key("ws_team").eq(search_partition(workspace_id, team_id)))
        for item in items:
            term, separator, doc = str(item["term_doc"]).partition("#")
            if separator and term and doc:
                yield term, doc

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
