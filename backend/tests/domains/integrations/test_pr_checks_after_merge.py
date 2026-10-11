"""Checks that finish after their pull request merged still reach its links (STUP-214).

GitHub stops naming a pull request on a `check_run` once the head branch is gone,
so these pin the head commit lookup, the read back on merge, and the repair a
read of a stale merged link queues.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.github import IssueLink, PullRequestState, link_key, pr_state_key
from app.domains.integrations import pr_status
from tests.domains.helpers import OWNER, sign_in
from tests.domains.integrations.conftest import (
    APP_SLUG,
    INSTALLATION_ID,
    REPOSITORY_FULL_NAME,
    REPOSITORY_ID,
    WORKSPACE,
    CheckRuns,
)
from tests.domains.integrations.test_pr_stacks import check, check_delivery, deliver, pull_request_delivery


def merged_delivery(number: int) -> dict[str, Any]:
    """The `closed` delivery of pull request `number` merging into main."""
    payload = pull_request_delivery(
        number, f"part-{number}", "main", updated_at="2026-10-01T12:00:00Z", merged=True, state="closed"
    )
    payload["body"]["action"] = "closed"
    payload["delivery"] = f"pr-{number}-merged"
    return payload


def orphan_check_delivery(number: int, run_id: int, status: str, conclusion: str | None) -> dict[str, Any]:
    """A `check_run` delivery on pull request `number`'s head commit that names no pull request."""
    payload = check_delivery(number, run_id, status, conclusion)
    payload["body"]["check_run"]["pull_requests"] = []
    return payload


def stored_link(repositories: Any, number: int) -> IssueLink:
    """The only link of pull request `number`."""
    return repositories.github.list_links_for_pr(WORKSPACE, f"PR_{number}")[0]


def test_a_check_finishing_after_the_merge_reaches_the_link(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
    check_runs: CheckRuns,
) -> None:
    """A completed delivery with empty `pull_requests` is matched to the merged pull request by its head commit."""
    deliver(repositories, pull_request_delivery(10, "part-10", "main"))
    deliver(repositories, check_delivery(10, 200, "in_progress", None))
    check_runs.runs = [{**check(200, "tests", "in_progress", sha="sha10"), "app": {"slug": "ci"}}]
    deliver(repositories, merged_delivery(10))
    assert (stored_link(repositories, 10).pr_state, stored_link(repositories, 10).ci_state) == ("merged", "pending")

    deliver(repositories, orphan_check_delivery(10, 200, "completed", "success"))

    assert stored_link(repositories, 10).ci_state == "success"


def test_an_orphan_check_on_an_unknown_commit_writes_nothing(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A trunk commit's finished check names no pull request and matches none."""
    deliver(repositories, orphan_check_delivery(44, 1, "completed", "success"))

    assert repositories.github.get_pr_state(WORKSPACE, REPOSITORY_ID, 44) is None


def test_the_merge_reads_the_head_commit_checks_back(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
    check_runs: CheckRuns,
) -> None:
    """Closing a tracked pull request folds GitHub's current checks in, the App's own one skipped."""
    deliver(repositories, pull_request_delivery(10, "part-10", "main"))
    deliver(repositories, check_delivery(10, 200, "in_progress", None))
    check_runs.runs = [
        {**check(200, "tests", "completed", "success", sha="sha10"), "app": {"slug": "ci"}},
        {**check(300, "Standupless", "in_progress", sha="sha10"), "app": {"slug": APP_SLUG}},
    ]

    deliver(repositories, merged_delivery(10))

    assert check_runs.asked == [(INSTALLATION_ID, REPOSITORY_ID, "sha10")]
    assert stored_link(repositories, 10).ci_state == "success"
    state = repositories.github.get_pr_state(WORKSPACE, REPOSITORY_ID, 10)
    assert state.reconciled_sha == "sha10"


def seed_stale(repositories: Any, issue: Any, *, reconciled: bool = False) -> None:
    """A merged pull request whose link and row still say its check is running, as rows from before the fix do."""
    repositories.github.save_pr_state(
        PullRequestState(
            workspace_id=WORKSPACE,
            github_key=pr_state_key(REPOSITORY_ID, 20),
            repository_id=REPOSITORY_ID,
            pr_number=20,
            node_id="PR_20",
            head_sha="sha20",
            pr_state="merged",
            reconciled_sha="sha20" if reconciled else "",
            checks={"sha20": {}},
        ),
        expected_version=0,
    )
    state = repositories.github.get_pr_state(WORKSPACE, REPOSITORY_ID, 20)
    pr_status.apply_check_run(state, check(500, "tests", "in_progress", sha="sha20"))
    repositories.github.save_pr_state(state, expected_version=1)
    link_id = f"PR_20#{issue.issue_id}"
    repositories.github.put_link(
        IssueLink(
            workspace_id=WORKSPACE,
            github_key=link_key(link_id),
            ws_issue=f"{WORKSPACE}#{issue.issue_id}",
            link_id=link_id,
            issue_id=issue.issue_id,
            issue_key="ABC-1",
            repository_full_name=REPOSITORY_FULL_NAME,
            pr_number=20,
            pr_title="ABC-1 stale",
            pr_url=f"https://github.com/{REPOSITORY_FULL_NAME}/pull/20",
            pr_state="merged",
            repository_id=REPOSITORY_ID,
            ci_state="pending",
            pr_updated_ms=1,
        )
    )


def test_reading_a_stale_merged_link_queues_a_check_read_that_repairs_it(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
    check_runs: CheckRuns,
) -> None:
    """A merged link still showing running checks queues one read, and running it settles the link."""
    seed_stale(repositories, issue)
    links = repositories.github.list_links_for_pr(WORKSPACE, "PR_20")

    assert pr_status.request_reconcile(repositories, WORKSPACE, links) == 1
    _queue, envelope = enqueued[-1]
    assert envelope.payload["event"] == pr_status.RECONCILE_EVENT

    check_runs.runs = [{**check(500, "tests", "completed", "success", sha="sha20"), "app": {"slug": "ci"}}]
    deliver(repositories, envelope.payload)

    assert stored_link(repositories, 20).ci_state == "success"
    assert pr_status.request_reconcile(repositories, WORKSPACE, [stored_link(repositories, 20)]) == 0


def test_a_commit_already_read_back_is_not_queued_again(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A check GitHub itself still shows running is not asked about on every read."""
    seed_stale(repositories, issue, reconciled=True)
    links = repositories.github.list_links_for_pr(WORKSPACE, "PR_20")

    assert pr_status.request_reconcile(repositories, WORKSPACE, links) == 0
    assert enqueued == []


def test_the_issue_links_route_queues_the_repair(
    client: TestClient,
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
) -> None:
    """The issue panel's read is what queues the repair of a stale merged link."""
    deliver(repositories, pull_request_delivery(10, "part-10", "main"))
    deliver(repositories, check_delivery(10, 200, "in_progress", None))
    deliver(repositories, merged_delivery(10))
    state = repositories.github.get_pr_state(WORKSPACE, REPOSITORY_ID, 10)
    state.reconciled_sha = ""
    repositories.github.save_pr_state(state, expected_version=state.version)
    sign_in(client, OWNER)
    before = len(enqueued)

    response = client.get(f"/api/workspaces/{WORKSPACE}/issues/{issue.issue_id}/github-links")

    assert response.status_code == 200
    queued = [envelope for _queue, envelope in enqueued[before:] if envelope.name == pr_status.RECONCILE_EVENT]
    assert [envelope.payload["body"]["number"] for envelope in queued] == [10]
