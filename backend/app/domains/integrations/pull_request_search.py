"""Search over the pull requests linked to issues, for the editor's `#` reference picker.

A pull request is known to the workspace only through its link rows, one per
issue it names, so search reads the workspace's link rows and groups them by
repository and number. A pull request is shown when at least one of its live
links points at an issue in a team the caller can see, which is the same
visibility the issue's own links route applies; a detached link no longer
names its issue, so it never makes a pull request visible.

A query matches in one of three ways. `owner/repo#12`, or `repo#12`, names one
pull request exactly. A bare number, with or without its `#`, matches that
number and any title holding it. Anything else matches titles the way issue
search matches words, the last word as a prefix. A query shaped like an issue
key answers nothing, so the key's own exact lookup is never crowded out.
"""

from __future__ import annotations

import re
from typing import Callable, Literal

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.github import IssueLink
from app.common.db.dynamo.search_index import parse_query
from app.common.issue_keys import current
from app.common.issue_privacy import can_see_issue
from app.domains.integrations.schemas.pull_requests import PullRequestHitRead

PR_REFERENCE = re.compile(r"^(?:([A-Za-z0-9_.-]+)/)?([A-Za-z0-9_.-]+)#(\d+)$")
"""`owner/repo#12` or `repo#12`, the way GitHub writes a pull request reference."""

BARE_NUMBER = re.compile(r"^#?(\d+)$")
"""A pull request number on its own, as typed after the picker's `#`."""

ISSUE_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9]{1,5}-\d+$")
"""The shape search resolves as an issue key, which pull request search leaves to it."""

VISIBILITY_BATCH = 25
"""How many matching pull requests have their issues read at once while the page fills."""

LinkMatch = Callable[[IssueLink], bool]

PrState = Literal["open", "draft", "merged", "closed"]


def _reference_match(owner: str | None, repo: str, number: int) -> LinkMatch:
    """A matcher for the one pull request a `owner/repo#12` or `repo#12` reference names."""
    wanted_repo = repo.lower()
    wanted_full = f"{owner.lower()}/{wanted_repo}" if owner else None

    def matches(link: IssueLink) -> bool:
        """Whether the link is that pull request, compared without case as GitHub does."""
        if link.pr_number != number:
            return False
        full_name = link.repository_full_name.lower()
        if wanted_full is not None:
            return full_name == wanted_full
        return full_name.rsplit("/", 1)[-1] == wanted_repo

    return matches


def link_matcher(text: str) -> tuple[LinkMatch, LinkMatch] | None:
    """The matcher a query searches links with and the one that marks an exact hit, or `None` for no search.

    The second matcher ranks a pull request named by its number ahead of one
    whose title merely holds the same words.
    """
    query = text.strip()
    if not query or ISSUE_KEY.match(query):
        return None
    reference = PR_REFERENCE.match(query)
    if reference is not None:
        exact = _reference_match(reference.group(1), reference.group(2), int(reference.group(3)))
        return exact, exact
    bare = BARE_NUMBER.match(query)
    words = parse_query(query)
    if bare is not None:
        number = int(bare.group(1))

        def numbered(link: IssueLink) -> bool:
            """Whether the link is pull request `number` in any repository."""
            return link.pr_number == number

        def numbered_or_titled(link: IssueLink) -> bool:
            """Whether the link has that number, or a title holding it."""
            return numbered(link) or (bool(words) and words.matches_text(link.pr_title))

        return numbered_or_titled, numbered
    if not words:
        return None

    def titled(link: IssueLink) -> bool:
        """Whether the pull request's title holds the query's words."""
        return words.matches_text(link.pr_title)

    return titled, lambda _link: False


def _newest(rows: list[IssueLink]) -> IssueLink:
    """The link row written from the latest delivery, whose title and state are current."""
    return max(rows, key=lambda row: (row.pr_updated_ms, row.updated_at))


def _state(value: str) -> PrState:
    """A stored state narrowed to the four the contract names, an unknown one reading as open."""
    if value == "draft":
        return "draft"
    if value == "merged":
        return "merged"
    if value == "closed":
        return "closed"
    return "open"


def search_pull_requests(
    repositories: Repositories, context: AuthzContext, text: str, limit: int
) -> list[PullRequestHitRead]:
    """The linked pull requests matching `text` that the caller can see, exact hits first, then newest first."""
    matchers = link_matcher(text)
    if matchers is None:
        return []
    matches, exact = matchers
    groups: dict[tuple[str, int], list[IssueLink]] = {}
    for link in repositories.github.iter_links(context.workspace_id):
        if link.detached or not matches(link):
            continue
        groups.setdefault((link.repository_id or link.repository_full_name.lower(), link.pr_number), []).append(link)
    ordered = sorted(
        groups.values(),
        key=lambda rows: (not exact(rows[0]), -_newest(rows).pr_updated_ms, -_newest(rows).updated_at.timestamp()),
    )
    hits: list[PullRequestHitRead] = []
    for start in range(0, len(ordered), VISIBILITY_BATCH):
        if len(hits) >= limit:
            break
        chunk = ordered[start : start + VISIBILITY_BATCH]
        issues = repositories.issues.get_many(
            context.workspace_id, sorted({row.issue_id for rows in chunk for row in rows})
        )
        for rows in chunk:
            visible = [
                row
                for row in rows
                if row.issue_id in issues and can_see_issue(repositories, context, issues[row.issue_id])
            ]
            if not visible:
                continue
            newest = _newest(rows)
            hits.append(
                PullRequestHitRead(
                    repository_full_name=newest.repository_full_name,
                    number=newest.pr_number,
                    title=newest.pr_title,
                    url=newest.pr_url,
                    state=_state(newest.pr_state),
                    author_login=newest.author_login,
                    issue_keys=sorted({current(repositories.teams, issues[row.issue_id]).key for row in visible}),
                    updated_at=newest.updated_at,
                )
            )
    return hits[:limit]
