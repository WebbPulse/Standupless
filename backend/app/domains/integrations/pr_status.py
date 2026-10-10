"""The review and check state of linked pull requests, and how it reaches their link rows.

Three deliveries feed one `PullRequestState` row per pull request: `pull_request`
for the branches and requested reviewers, `pull_request_review` for each review,
and `check_run` for each check. None of them is ordered, so each merge is written
to converge whatever order they land in: the branch fields move only on a newer
`updated_at`, a reviewer keeps the review with the highest id, and a check keeps
the run with the highest id per name and head commit. The row's summary, the
review decision and the combined check state, is then copied onto every link of
the pull request, which is what the issue's pull request panel reads.

Rows are created only for a pull request that links an issue, so a busy
repository's checks on unrelated pull requests write nothing.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Callable, Mapping

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.github import CheckEntry, PullRequestState, ReviewEntry, pr_state_key, source_millis

_log = logging.getLogger(__name__)

REVIEW_STATES: tuple[str, ...] = ("none", "pending", "approved", "changes_requested")

CI_STATES: tuple[str, ...] = ("none", "pending", "success", "failure")

PASSING_CONCLUSIONS = frozenset({"success", "neutral", "skipped"})
"""Conclusions GitHub draws as passing or as not counting against the pull request."""

IGNORED_CONCLUSIONS = frozenset({"stale"})
"""A conclusion GitHub gives a run it gave up on, which a newer run replaces."""

DECIDING_REVIEWS = frozenset({"approved", "changes_requested", "dismissed"})
"""Review states that change the decision; a plain comment leaves the earlier one standing."""

MAX_PREVIOUS_BASES = 5
"""How many earlier base branches a pull request remembers, which is what keeps a
stack together after GitHub retargets the next pull request when one merges."""

MAX_TRACKED_COMMITS = 3
"""How many head commits keep their checks, enough for a push racing its own checks."""

SAVE_ATTEMPTS = 5

SUMMARY_FIELDS: tuple[str, ...] = (
    "head_ref",
    "base_ref",
    "previous_base_refs",
    "from_fork",
    "review_state",
    "ci_state",
)
"""The link fields copied from the pull request's state row."""


def review_state(state: PullRequestState) -> str:
    """The review decision: changes requested beats approved, which beats a pending request."""
    latest = [entry.state for entry in state.reviews.values()]
    if "changes_requested" in latest:
        return "changes_requested"
    if "approved" in latest:
        return "approved"
    if state.requested_reviewers > 0:
        return "pending"
    return "none"


def ci_state(state: PullRequestState) -> str:
    """The combined check state of the head commit: any failure fails, any running check is pending."""
    checks = [
        entry for entry in state.checks.get(state.head_sha, {}).values() if entry.conclusion not in IGNORED_CONCLUSIONS
    ]
    if not checks:
        return "none"
    if any(entry.status == "completed" and entry.conclusion not in PASSING_CONCLUSIONS for entry in checks):
        return "failure"
    if any(entry.status != "completed" for entry in checks):
        return "pending"
    return "success"


def pull_request_millis(pull_request: Mapping[str, Any]) -> int:
    """The pull request's own `updated_at` in epoch milliseconds, or 0 when it has none."""
    raw = pull_request.get("updated_at")
    if not isinstance(raw, str) or not raw:
        return 0
    try:
        return source_millis(datetime.fromisoformat(raw.replace("Z", "+00:00")))
    except ValueError:
        return 0


def summary(state: PullRequestState | None) -> dict[str, Any]:
    """The link fields one state row implies, or the defaults when there is no row."""
    if state is None:
        return {
            "head_ref": "",
            "base_ref": "",
            "previous_base_refs": [],
            "from_fork": False,
            "review_state": "none",
            "ci_state": "none",
        }
    return {
        "head_ref": state.head_ref,
        "base_ref": state.base_ref,
        "previous_base_refs": list(state.previous_base_refs),
        "from_fork": state.from_fork,
        "review_state": review_state(state),
        "ci_state": ci_state(state),
    }


def _remember_base(state: PullRequestState, base: str) -> None:
    """Add a base branch to the history unless it is the current one or already there."""
    if not base or base == state.base_ref or base in state.previous_base_refs:
        return
    state.previous_base_refs = [*state.previous_base_refs, base][-MAX_PREVIOUS_BASES:]


def apply_pull_request(
    state: PullRequestState, pull_request: Mapping[str, Any], pr_updated_ms: int, **extra: Any
) -> None:
    """Fold one `pull_request` or `pull_request_review` payload's pull request into the row.

    Every base branch seen joins the history, whatever the delivery's age, since an
    older base is still one the pull request had. The current branches, head commit
    and requested reviewer count move only on a delivery at least as new as the row.
    """
    raw_head = pull_request.get("head")
    raw_base = pull_request.get("base")
    head: Mapping[str, Any] = raw_head if isinstance(raw_head, Mapping) else {}
    base: Mapping[str, Any] = raw_base if isinstance(raw_base, Mapping) else {}
    head_ref = str(head.get("ref", "") or "")
    base_ref = str(base.get("ref", "") or "")
    previous = str(extra.get("previous_base", "") or "")
    node_id = str(pull_request.get("node_id", "") or "")
    if node_id:
        state.node_id = node_id

    if pr_updated_ms >= state.pr_updated_ms:
        earlier_base = state.base_ref
        state.head_ref = head_ref or state.head_ref
        state.base_ref = base_ref or state.base_ref
        _remember_base(state, earlier_base)
        state.head_sha = str(head.get("sha", "") or "") or state.head_sha
        state.from_fork = _from_fork(head, base, extra.get("repository"))
        reviewers = pull_request.get("requested_reviewers")
        teams = pull_request.get("requested_teams")
        state.requested_reviewers = len(reviewers if isinstance(reviewers, list) else []) + len(
            teams if isinstance(teams, list) else []
        )
        state.pr_updated_ms = pr_updated_ms
        _prune_checks(state)
    else:
        _remember_base(state, base_ref)
    _remember_base(state, previous)


def _from_fork(head: Mapping[str, Any], base: Mapping[str, Any], repository: Any) -> bool:
    """Whether the head branch lives in another repository, whose branch names say nothing here."""
    head_repo = head.get("repo")
    if not isinstance(head_repo, Mapping):
        return False
    base_repo = base.get("repo")
    if isinstance(base_repo, Mapping) and head_repo.get("id") is not None and base_repo.get("id") is not None:
        return str(head_repo.get("id")) != str(base_repo.get("id"))
    full_name = repository.get("full_name") if isinstance(repository, Mapping) else None
    if full_name and head_repo.get("full_name"):
        return str(head_repo.get("full_name")) != str(full_name)
    return False


def _prune_checks(state: PullRequestState) -> None:
    """Keep the head commit's checks and the newest few others, so the row cannot grow without bound."""
    if len(state.checks) <= MAX_TRACKED_COMMITS:
        return
    others = [sha for sha in state.checks if sha != state.head_sha]
    keep = set(others[-(MAX_TRACKED_COMMITS - 1) :]) | {state.head_sha}
    state.checks = {sha: rows for sha, rows in state.checks.items() if sha in keep}


def apply_review(state: PullRequestState, review: Mapping[str, Any], action: str) -> None:
    """Fold one review into the reviewer's entry, keeping the highest review id.

    A comment-only review is skipped, because it neither approves nor blocks and
    must not hide the reviewer's earlier decision. A dismissal turns the dismissed
    review into one that no longer counts.
    """
    user = review.get("user")
    login = str(user.get("login", "") or "") if isinstance(user, Mapping) else ""
    review_id = review.get("id")
    if not login or not isinstance(review_id, int) or isinstance(review_id, bool):
        return
    review_state_value = "dismissed" if action == "dismissed" else str(review.get("state", "") or "").lower()
    if review_state_value not in DECIDING_REVIEWS:
        return
    current = state.reviews.get(login)
    if current is not None and current.review_id > review_id:
        return
    if current is not None and current.review_id == review_id and current.state == "dismissed":
        return
    state.reviews[login] = ReviewEntry(review_id=review_id, state=review_state_value)


def apply_check_run(state: PullRequestState, check_run: Mapping[str, Any]) -> None:
    """Fold one check run into its commit's checks, keeping the newest run of each name.

    Run ids only grow, so a rerun replaces the run it reran. Within one run a
    completed delivery wins over an earlier status, so a late `created` cannot
    reopen a finished check.
    """
    sha = str(check_run.get("head_sha", "") or "")
    name = str(check_run.get("name", "") or "")
    run_id = check_run.get("id")
    if not sha or not name or not isinstance(run_id, int) or isinstance(run_id, bool):
        return
    status = str(check_run.get("status", "") or "")
    conclusion = str(check_run.get("conclusion", "") or "") if status == "completed" else ""
    commit = dict(state.checks.get(sha, {}))
    current = commit.get(name)
    if current is not None:
        if current.check_run_id > run_id:
            return
        if current.check_run_id == run_id and current.status == "completed" and status != "completed":
            return
    commit[name] = CheckEntry(check_run_id=run_id, status=status, conclusion=conclusion)
    state.checks = {**state.checks, sha: commit}
    _prune_checks(state)


def update_state(
    repositories: Repositories,
    workspace_id: str,
    repository_id: str,
    number: int,
    change: Callable[[PullRequestState], None],
    *,
    create: bool,
) -> PullRequestState | None:
    """Apply `change` to one pull request's row, retrying a lost race against the winner.

    `create` says whether a missing row may be started, which only a delivery that
    linked an issue does. Answers the saved row, or `None` when there was nothing to
    change.
    """
    for _attempt in range(SAVE_ATTEMPTS):
        stored = repositories.github.get_pr_state(workspace_id, repository_id, number)
        if stored is None and not create:
            return None
        state = (
            stored.model_copy(deep=True)
            if stored is not None
            else PullRequestState(
                workspace_id=workspace_id,
                github_key=pr_state_key(repository_id, number),
                repository_id=repository_id,
                pr_number=number,
            )
        )
        change(state)
        if stored is not None and state.model_dump() == stored.model_dump():
            return stored
        expected = stored.version if stored is not None else 0
        if repositories.github.save_pr_state(state, expected_version=expected):
            return state.model_copy(update={"version": expected + 1})
    _log.warning(
        "Gave up writing a pull request's state after repeated races.",
        extra={"event": "integrations.pr_state_contended"},
    )
    raise RuntimeError("pull request state write kept losing its race")


def propagate(repositories: Repositories, workspace_id: str, state: PullRequestState) -> int:
    """Copy one state row's summary onto every link of its pull request, answering how many moved."""
    if not state.node_id:
        return 0
    wanted = summary(state)
    moved = 0
    for link in repositories.github.list_links_for_pr(workspace_id, state.node_id):
        if all(getattr(link, name) == wanted[name] for name in SUMMARY_FIELDS):
            continue
        repositories.github.update_link(workspace_id, link.link_id, **wanted)
        moved += 1
    return moved


def handle_review(repositories: Repositories, workspace_id: str, body: Mapping[str, Any]) -> None:
    """Record one `pull_request_review` delivery on a linked pull request."""
    pull_request = body.get("pull_request")
    review = body.get("review")
    repository = body.get("repository")
    if not isinstance(pull_request, Mapping) or not isinstance(review, Mapping) or not isinstance(repository, Mapping):
        return
    number = int(pull_request.get("number", 0) or 0)
    action = str(body.get("action", ""))
    millis = pull_request_millis(pull_request)

    def change(state: PullRequestState) -> None:
        """Fold the pull request snapshot and the review into the row."""
        apply_pull_request(state, pull_request, millis, repository=repository)
        apply_review(state, review, action)

    state = update_state(repositories, workspace_id, str(repository.get("id", "")), number, change, create=False)
    if state is not None:
        propagate(repositories, workspace_id, state)


def handle_check_run(repositories: Repositories, workspace_id: str, body: Mapping[str, Any], own_app: str) -> None:
    """Record one `check_run` delivery on each linked pull request it names.

    The App's own check, the one listing linked issues, is skipped: it always
    passes and says nothing about the code.
    """
    check_run = body.get("check_run")
    repository = body.get("repository")
    if not isinstance(check_run, Mapping) or not isinstance(repository, Mapping):
        return
    if is_own_check(check_run, own_app):
        return
    repository_id = str(repository.get("id", ""))
    for number in check_run_pull_requests(check_run, repository_id):
        state = update_state(
            repositories,
            workspace_id,
            repository_id,
            number,
            lambda row: apply_check_run(row, check_run),
            create=False,
        )
        if state is not None:
            propagate(repositories, workspace_id, state)


def is_own_check(check_run: Mapping[str, Any], own_app: str) -> bool:
    """Whether a check run is the one this App posts on every linked pull request."""
    app = check_run.get("app")
    slug = str(app.get("slug", "") or "") if isinstance(app, Mapping) else ""
    return bool(own_app) and slug == own_app


def check_run_pull_requests(check_run: Mapping[str, Any], repository_id: str) -> list[int]:
    """The numbers of the pull requests in this repository a check run reports on."""
    numbers: list[int] = []
    for entry in check_run.get("pull_requests") or []:
        if not isinstance(entry, Mapping):
            continue
        base = entry.get("base")
        base_repo = base.get("repo") if isinstance(base, Mapping) else None
        if isinstance(base_repo, Mapping) and base_repo.get("id") is not None:
            if str(base_repo.get("id")) != repository_id:
                continue
        number = entry.get("number")
        if isinstance(number, int) and not isinstance(number, bool) and number > 0 and number not in numbers:
            numbers.append(number)
    return numbers
