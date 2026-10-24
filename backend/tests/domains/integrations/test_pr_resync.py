"""Linked pull requests whose merge or close delivery was lost heal from a read back (STUP-333).

Before STUP-327 a rate limited batch counted as handled, so a merge could vanish
and leave its links open. These pin the sweep that finds such links, the read back
that folds GitHub's current state, and the guards that keep both cheap and safe.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Callable

import pytest
from webbpulse.integrations.github import GitHubNotFound

from app.common.db.dynamo.base import utc_now
from app.domains.integrations import pr_resync
from app.domains.integrations.consumers import events
from tests.domains.integrations.conftest import (
    INSTALLATION_ID,
    REPOSITORY_FULL_NAME,
    REPOSITORY_ID,
    WORKSPACE,
    sqs_record,
)
from tests.domains.integrations.test_events_consumer import preset, pull_request_event, status_ids, status_of

__all__ = ["preset", "status_ids"]


@pytest.fixture(autouse=True)
def fresh_memos(monkeypatch: pytest.MonkeyPatch) -> None:
    """Start each test with no sweep window or low budget remembered from another."""
    monkeypatch.setattr(pr_resync, "_swept", {})
    monkeypatch.setattr(pr_resync, "_low_until", {})


@pytest.fixture
def github_pull(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """What the patched pull request read answers, and every read it took.

    `answer` is the pull request GitHub reports, or an exception to raise.
    """
    seen: dict[str, Any] = {"answer": None, "asked": []}

    def fetch(installation_id: str, repository_id: str, number: int) -> Any:
        """Answer the seeded pull request, recording the read."""
        seen["asked"].append((installation_id, repository_id, number))
        answer = seen["answer"]
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(pr_resync, "fetch_pull_request", fetch)
    return seen


def github_says(*, base: str = "staging", merged: bool = True, state: str = "closed", at: Any = None) -> dict[str, Any]:
    """The pulls API answer for pull request 7 as GitHub reports it now."""
    moment = (at or utc_now() + timedelta(minutes=1)).isoformat()
    pull_request = pull_request_event(base=base, merged=merged, state=state)["body"]["pull_request"]
    pull_request["base"]["repo"] = {"id": int(REPOSITORY_ID), "full_name": REPOSITORY_FULL_NAME}
    pull_request["updated_at"] = moment
    pull_request["closed_at"] = moment if state == "closed" else None
    pull_request["merged_at"] = moment if merged else None
    return pull_request


def open_pull_request(repositories: Any) -> None:
    """Deliver pull request 7 opening against ABC-1, then nothing more."""
    events.handle_record(
        repositories,
        sqs_record(pull_request_event(base="staging", updated_at="2026-10-01T10:00:00Z")),
    )


def resyncs(enqueued: list[tuple[str, Any]]) -> list[Any]:
    """The read backs queued so far."""
    return [envelope for _, envelope in enqueued if envelope.payload.get("event") == pr_resync.RESYNC_EVENT]


def run(repositories: Any, envelope: Any) -> None:
    """Run one queued read back through the consumer."""
    events.handle_record(repositories, sqs_record(envelope.payload))


def later(hours: float = 1) -> Any:
    """A moment late enough that a link written now counts as idle."""
    return utc_now() + timedelta(hours=hours)


def link_state(repositories: Any) -> str:
    """Pull request 7's link state on ABC-1."""
    return repositories.github.list_links_for_pr(WORKSPACE, "PR_node")[0].pr_state


def test_a_merge_whose_delivery_was_lost_heals_from_the_read_back(
    repositories: Any,
    installed: str,
    issue: Any,
    preset: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
    github_pull: dict[str, Any],
) -> None:
    """The sweep queues the idle open link, and the read back merges it and moves the issue."""
    open_pull_request(repositories)
    assert status_of(repositories, issue.issue_id) == preset["In Review"]

    assert pr_resync.sweep(repositories, WORKSPACE, now=later()) == 1
    github_pull["answer"] = github_says()
    queued = resyncs(enqueued)
    assert len(queued) == 1
    assert queued[0].payload["body"]["number"] == 7
    run(repositories, queued[0])

    assert github_pull["asked"] == [(INSTALLATION_ID, REPOSITORY_ID, 7)]
    assert link_state(repositories) == "merged"
    assert status_of(repositories, issue.issue_id) == preset["On Staging"]


def test_a_pull_request_still_open_on_github_changes_nothing(
    repositories: Any,
    installed: str,
    issue: Any,
    preset: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
    github_pull: dict[str, Any],
) -> None:
    """A read back of an open pull request leaves the link and the issue as they were."""
    open_pull_request(repositories)
    pr_resync.sweep(repositories, WORKSPACE, now=later())
    github_pull["answer"] = github_says(merged=False, state="open")

    run(repositories, resyncs(enqueued)[0])

    assert link_state(repositories) == "open"
    assert status_of(repositories, issue.issue_id) == preset["In Review"]


def test_a_close_without_a_merge_heals_as_closed(
    repositories: Any,
    installed: str,
    issue: Any,
    preset: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
    github_pull: dict[str, Any],
) -> None:
    """A pull request closed unmerged reads closed and moves the issue nowhere."""
    open_pull_request(repositories)
    pr_resync.sweep(repositories, WORKSPACE, now=later())
    github_pull["answer"] = github_says(merged=False)

    run(repositories, resyncs(enqueued)[0])

    assert link_state(repositories) == "closed"
    assert status_of(repositories, issue.issue_id) == preset["In Review"]


def test_a_fresh_or_ancient_link_is_not_swept(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """Links written moments ago, or left open longer than `MAX_IDLE`, are not read back."""
    open_pull_request(repositories)

    assert pr_resync.sweep(repositories, WORKSPACE) == 0
    assert pr_resync.sweep(repositories, WORKSPACE, now=later(hours=24 * 31)) == 0
    assert resyncs(enqueued) == []


def test_one_pull_request_is_read_back_at_most_once_an_hour(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A second sweep inside the recheck window queues nothing for the same pull request."""
    open_pull_request(repositories)

    assert pr_resync.sweep(repositories, WORKSPACE, now=later()) == 1
    assert pr_resync.sweep(repositories, WORKSPACE, now=later()) == 0
    assert len(resyncs(enqueued)) == 1


def test_a_dry_run_counts_without_queueing(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A dry run answers what it would queue and queues and claims nothing."""
    open_pull_request(repositories)

    assert pr_resync.sweep(repositories, WORKSPACE, now=later(), dry_run=True) == 1
    assert resyncs(enqueued) == []
    assert pr_resync.sweep(repositories, WORKSPACE, now=later()) == 1


def test_later_deliveries_sweep_each_workspace_once_a_window(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """The hook claims one sweep per window however many deliveries arrive in it."""
    open_pull_request(repositories)
    moment = later()

    assert pr_resync.maybe_sweep(repositories, WORKSPACE, now=moment) == 1
    pr_resync._swept.clear()
    assert pr_resync.maybe_sweep(repositories, WORKSPACE, now=moment) == 0
    assert len(resyncs(enqueued)) == 1


def test_a_delivery_runs_the_sweep(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Deliveries for the workspace run the sweep, once in a window however many arrive."""
    swept: list[str] = []

    def record(repositories: Any, workspace_id: str, **_: Any) -> int:
        """Note the sweep instead of running it."""
        swept.append(workspace_id)
        return 0

    monkeypatch.setattr(pr_resync, "sweep", record)

    open_pull_request(repositories)
    events.handle_record(repositories, sqs_record(pull_request_event(number=8, node_id="PR_other")))

    assert swept == [WORKSPACE]


@pytest.mark.parametrize(
    "failure",
    [
        lambda: GitHubNotFound("gone"),
        lambda: ValueError("bad answer"),
    ],
)
def test_an_unreadable_pull_request_is_dropped_quietly(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
    github_pull: dict[str, Any],
    failure: Callable[[], Exception],
) -> None:
    """A read GitHub refuses leaves the link open for the next sweep and does not fail the batch."""
    open_pull_request(repositories)
    pr_resync.sweep(repositories, WORKSPACE, now=later())
    github_pull["answer"] = failure()

    run(repositories, resyncs(enqueued)[0])

    assert link_state(repositories) == "open"


def test_an_installation_low_on_budget_is_not_read_until_its_reset(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
    github_pull: dict[str, Any],
) -> None:
    """A remembered low budget skips the read entirely."""
    open_pull_request(repositories)
    pr_resync.sweep(repositories, WORKSPACE, now=later())
    pr_resync._low_until[INSTALLATION_ID] = later().timestamp()
    github_pull["answer"] = github_says()

    run(repositories, resyncs(enqueued)[0])

    assert github_pull["asked"] == []
    assert link_state(repositories) == "open"


def test_a_link_healed_since_the_sweep_is_not_read(
    repositories: Any,
    installed: str,
    issue: Any,
    preset: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
    github_pull: dict[str, Any],
) -> None:
    """A merge delivery that arrives between the sweep and the read back makes the read unnecessary."""
    open_pull_request(repositories)
    pr_resync.sweep(repositories, WORKSPACE, now=later())
    events.handle_record(
        repositories,
        sqs_record(
            pull_request_event(
                action="closed", merged=True, state="closed", base="staging", updated_at="2026-10-01T11:00:00Z"
            )
        ),
    )

    run(repositories, resyncs(enqueued)[0])

    assert github_pull["asked"] == []
    assert link_state(repositories) == "merged"


def test_a_manual_change_after_the_merge_is_kept(
    repositories: Any,
    installed: str,
    issue: Any,
    preset: dict[str, str],
    status_ids: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
    github_pull: dict[str, Any],
) -> None:
    """A person who moved the issue after the merge keeps their status; only the link heals."""
    open_pull_request(repositories)
    pr_resync.sweep(repositories, WORKSPACE, now=later())
    moved = repositories.issues.get(WORKSPACE, issue.issue_id)
    repositories.issues.replace(
        moved.model_copy(update={"status_id": status_ids["backlog"], "updated_at": utc_now() + timedelta(hours=2)})
    )
    github_pull["answer"] = github_says(at=utc_now() + timedelta(hours=1))

    run(repositories, resyncs(enqueued)[0])

    assert link_state(repositories) == "merged"
    assert status_of(repositories, issue.issue_id) == status_ids["backlog"]


def test_the_plan_reads_each_pull_request_once_newest_first() -> None:
    """Two issues on one pull request make one read, and detached or finished links none."""
    from app.common.db.dynamo.github import IssueLink

    now = utc_now()

    def row(
        node: str, issue_id: str, number: int, *, state: str = "open", age: float = 2, detached: bool = False
    ) -> Any:
        """One link row of `age` hours."""
        return IssueLink.model_construct(
            link_id=f"{node}#{issue_id}",
            repository_id=REPOSITORY_ID,
            pr_number=number,
            pr_state=state,
            detached=detached,
            updated_at=now - timedelta(hours=age),
        )

    targets = pr_resync.plan(
        [
            row("PR_a", "i1", 1, age=5),
            row("PR_a", "i2", 1, age=3),
            row("PR_b", "i1", 2, age=1),
            row("PR_c", "i1", 3, state="merged"),
            row("PR_d", "i1", 4, detached=True),
            row("PR_e", "i1", 5, state="draft", age=4),
        ],
        now,
    )

    assert [(target.number, target.node_id) for target in targets] == [(2, "PR_b"), (1, "PR_a"), (5, "PR_e")]


def test_the_backfill_queues_every_open_link_however_fresh(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """The one-off run skips the idle window and the recheck claim, and a dry run queues nothing."""
    from scripts.resync_open_pull_requests import run as backfill

    open_pull_request(repositories)

    dry = backfill(repositories, [WORKSPACE], queue_url="", dry_run=True)
    assert (dry.workspaces, dry.queued) == (1, 1)
    assert resyncs(enqueued) == []

    first = backfill(repositories, [WORKSPACE], queue_url="https://sqs.test/backfill", dry_run=False)
    second = backfill(repositories, [WORKSPACE], queue_url="https://sqs.test/backfill", dry_run=False)
    assert (first.queued, second.queued) == (1, 1)
    assert [url for url, envelope in enqueued if envelope.payload.get("event") == pr_resync.RESYNC_EVENT] == [
        "https://sqs.test/backfill",
        "https://sqs.test/backfill",
    ]
