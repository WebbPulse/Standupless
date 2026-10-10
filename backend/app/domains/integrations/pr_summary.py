"""The pull request summary an issue row carries, so a list or board draws its chip without reading links.

The summary is derived from the issue's live links and rewritten whole whenever a
pull request, review or check delivery may have changed one of them. The
recompute reads the issue's links through the eventually consistent issue index,
so the pull request that triggered it passes its own link ids as well, read
strongly consistent, and its change is never missed. Two different pull requests
linking one issue within the index's lag can still leave out the other one until
its next delivery; that window is accepted rather than paid for on every write.

The write is guarded by its own counter, so two refreshes of one issue cannot
interleave a stale read with a newer write.
"""

from __future__ import annotations

import logging
from typing import Callable, Iterable

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.github import IssueLink
from app.common.db.dynamo.issues import PullRequestSummary, PullRequestSummaryEntry

_log = logging.getLogger(__name__)

MAX_ENTRIES = 10
"""How many pull requests the summary names, enough for the chip's hover list."""

MAX_LINKS = 200
"""How many of an issue's links the recompute reads, far beyond any real issue."""

SAVE_ATTEMPTS = 5

STATE_ORDER: dict[str, int] = {"merged": 4, "open": 3, "draft": 2, "closed": 1}
"""How far along each pull request state is, which picks the chip's pull request."""


def _order(link: IssueLink) -> tuple[int, int]:
    """Sort key placing the most advanced, then the newest, pull request first."""
    return (STATE_ORDER.get(link.pr_state, 0), link.pr_number)


def build_summary(links: Iterable[IssueLink]) -> PullRequestSummary | None:
    """The summary of an issue's links, ignoring detached ones, or `None` when none is live."""
    live = [link for link in links if not link.detached]
    if not live:
        return None
    live.sort(key=_order, reverse=True)
    return PullRequestSummary(
        count=len(live),
        pull_requests=[
            PullRequestSummaryEntry(
                repository_full_name=link.repository_full_name,
                number=link.pr_number,
                title=link.pr_title,
                url=link.pr_url,
                state=link.pr_state,
                review_state=link.review_state,
                ci_state=link.ci_state,
            )
            for link in live[:MAX_ENTRIES]
        ],
    )


def _issue_link_ids(repositories: Repositories, workspace_id: str, issue_id: str) -> list[str]:
    """Every link id the issue index holds for one issue."""
    ids: list[str] = []
    start_key = None
    while len(ids) < MAX_LINKS:
        page = repositories.github.list_links_for_issue(workspace_id, issue_id, limit=50, start_key=start_key)
        ids.extend(str(item.get("link_id", "")) for item in page.items)
        start_key = page.last_evaluated_key
        if not start_key:
            break
    return ids


def store(
    repositories: Repositories,
    workspace_id: str,
    issue_id: str,
    load_links: Callable[[], Iterable[IssueLink]],
    *,
    dry_run: bool = False,
) -> str:
    """Bring one issue's stored summary in line with its links, answering what happened.

    `load_links` is read again on every attempt, so a retry after a lost race
    sees the links the winner saw. Answers `missing` for a deleted issue,
    `unchanged` when the stored summary already matches, else `written`, which
    under `dry_run` means only that a write is due.
    """
    for _attempt in range(SAVE_ATTEMPTS):
        stored = repositories.issues.read_pull_request_summary(workspace_id, issue_id)
        if stored is None:
            return "missing"
        current, revision = stored
        wanted = build_summary(link for link in load_links() if link.issue_id == issue_id)
        if _same(current, wanted):
            return "unchanged"
        if dry_run:
            return "written"
        if repositories.issues.set_pull_request_summary(workspace_id, issue_id, wanted, expected_revision=revision):
            return "written"
    _log.warning(
        "Gave up writing an issue's pull request summary after repeated races.",
        extra={"event": "integrations.pr_summary_contended"},
    )
    return "unchanged"


def refresh(repositories: Repositories, workspace_id: str, issue_id: str, known_link_ids: Iterable[str] = ()) -> str:
    """Recompute and store one issue's summary from its links.

    `known_link_ids` are links the caller has just written, included even when the
    issue index has not caught up with them yet.
    """
    known = list(known_link_ids)

    def load() -> list[IssueLink]:
        """The issue's links, every one read strongly consistent."""
        link_ids = [*known, *_issue_link_ids(repositories, workspace_id, issue_id)]
        return repositories.github.get_links(workspace_id, link_ids)

    return store(repositories, workspace_id, issue_id, load)


def _same(current: PullRequestSummary | None, wanted: PullRequestSummary | None) -> bool:
    """Whether the stored summary already says what the links say."""
    if current is None or current.count == 0:
        return wanted is None
    return wanted is not None and current.model_dump() == wanted.model_dump()


def refresh_for_pr(repositories: Repositories, workspace_id: str, pr_node_id: str) -> int:
    """Refresh every issue one pull request links or once linked, answering how many were visited."""
    if not workspace_id or not pr_node_id:
        return 0
    by_issue: dict[str, list[str]] = {}
    for link in repositories.github.list_links_for_pr(workspace_id, pr_node_id):
        by_issue.setdefault(link.issue_id, []).append(link.link_id)
    for issue_id, link_ids in by_issue.items():
        refresh(repositories, workspace_id, issue_id, link_ids)
    return len(by_issue)
