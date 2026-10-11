"""The Reviews list: open pull requests asking the caller for a review or holding their decision.

Read from the caller's `ReviewPointer` rows, found by the GitHub account they
linked, and checked against each pull request's state row, which is the truth: a
pointer the row no longer backs, left by a lost write, is skipped rather than
shown. A pull request lands in one group: needs your review while you are a
requested reviewer, which a re-request after a decision puts it back into, then
changes requested or approved by your latest decision. Linked issues are shown
only when the caller can see their team.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.github import PullRequestState
from app.common.issue_keys import current
from app.domains.integrations import pr_status
from app.domains.integrations.schemas.reviews import (
    REVIEW_GROUPS,
    ReviewCountsRead,
    ReviewGroup,
    ReviewIssueRead,
    ReviewItemRead,
    ReviewsRead,
)

MAX_REVIEWS = 200
"""How many pull requests the list reads, far beyond anyone's real review queue."""


def group_for(state: PullRequestState, github_id: str) -> ReviewGroup | None:
    """The group one pull request sits in for one GitHub account, or `None` when it does not belong."""
    if state.pr_state not in pr_status.LIVE_PR_STATES:
        return None
    if github_id in state.requested_user_ids:
        return "needs_review"
    decisions = [entry for entry in state.reviews.values() if entry.user_id == github_id]
    if not decisions:
        return None
    latest = max(decisions, key=lambda entry: entry.review_id)
    if latest.state == "changes_requested":
        return "changes_requested"
    if latest.state == "approved":
        return "approved"
    return None


def _moment(millis: int) -> datetime | None:
    """Epoch milliseconds as a UTC moment, or `None` for an unknown one."""
    return datetime.fromtimestamp(millis / 1000, tz=timezone.utc) if millis else None


def _created(raw: str) -> datetime | None:
    """GitHub's `created_at` as a moment, or `None` when absent or unreadable."""
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def _issues(repositories: Repositories, context: AuthzContext, state: PullRequestState) -> list[ReviewIssueRead]:
    """The issues a pull request links that the caller can see, by current key."""
    found: list[ReviewIssueRead] = []
    seen: set[str] = set()
    for link in repositories.github.list_links_for_pr(context.workspace_id, state.node_id):
        if link.detached or link.issue_id in seen:
            continue
        seen.add(link.issue_id)
        issue = repositories.issues.get(context.workspace_id, link.issue_id)
        if issue is None or not context.can_see_team(issue.team_id):
            continue
        issue = current(repositories.teams, issue)
        found.append(ReviewIssueRead(issue_id=issue.issue_id, key=issue.key, title=issue.title, team_id=issue.team_id))
    return found


def list_reviews(repositories: Repositories, context: AuthzContext) -> ReviewsRead:
    """The caller's Reviews list, grouped and newest first within each group."""
    from app.domains.integrations.issue_sync import _github_for_user

    github_id = _github_for_user(repositories, context.user_id)
    if not github_id:
        return ReviewsRead(github_linked=False, counts=ReviewCountsRead(), items=[])
    pointers = repositories.github.list_review_pointers(context.workspace_id, github_id, limit=MAX_REVIEWS)
    states = repositories.github.get_pr_states(
        context.workspace_id, [(pointer.repository_id, pointer.pr_number) for pointer in pointers]
    )
    placed: list[tuple[ReviewGroup, PullRequestState]] = []
    for state in states:
        group = group_for(state, github_id)
        if group is not None:
            placed.append((group, state))
    placed.sort(key=lambda entry: (REVIEW_GROUPS.index(entry[0]), -entry[1].pr_updated_ms, entry[1].pr_number))
    items = [
        ReviewItemRead(
            repository_id=state.repository_id,
            repository_full_name=state.repository_full_name,
            number=state.pr_number,
            title=state.title,
            url=state.url,
            author_login=state.author_login,
            state="draft" if state.pr_state == "draft" else "open",
            group=group,
            review_state=pr_status.review_state(state),
            ci_state=pr_status.ci_state(state),
            created_at=_created(state.pr_created_at),
            updated_at=_moment(state.pr_updated_ms),
            issues=_issues(repositories, context, state) if state.node_id else [],
        )
        for group, state in placed
    ]
    counts = ReviewCountsRead(**{name: sum(1 for item in items if item.group == name) for name in REVIEW_GROUPS})
    return ReviewsRead(github_linked=True, counts=counts, items=items)
