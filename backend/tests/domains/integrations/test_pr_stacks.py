"""Stacked pull requests and their review and check state.

The stack detection is pinned on plain link rows, and the state that feeds it is
pinned end to end: a `pull_request`, `pull_request_review` and `check_run`
delivery through the consumer, then the issue's links read through the route and
through the MCP `get_issue` tool.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.github import IssueLink, PullRequestState, link_key, pr_state_key
from app.domains.integrations import pr_status
from app.domains.integrations.consumers import events
from app.domains.integrations.pr_stacks import stack_positions
from tests.domains.helpers import OWNER, sign_in
from tests.domains.integrations.conftest import (
    APP_SLUG,
    INSTALLATION_ID,
    REPOSITORY_FULL_NAME,
    REPOSITORY_ID,
    WORKSPACE,
    sqs_record,
)
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for

ISSUE_ID = "01JB0000000000000000000IS1"

REPOSITORY = {"id": int(REPOSITORY_ID), "full_name": REPOSITORY_FULL_NAME}


def link(
    number: int,
    head: str,
    base: str = "main",
    *,
    state: str = "open",
    previous: tuple[str, ...] = (),
    review: str = "none",
    ci: str = "none",
    repository_id: str = REPOSITORY_ID,
    from_fork: bool = False,
) -> IssueLink:
    """One link row of the seeded issue, for pull request `number` on branch `head`."""
    link_id = f"PR_{number}#{ISSUE_ID}"
    return IssueLink(
        workspace_id=WORKSPACE,
        github_key=link_key(link_id),
        ws_issue=f"{WORKSPACE}#{ISSUE_ID}",
        link_id=link_id,
        issue_id=ISSUE_ID,
        issue_key="ABC-1",
        repository_full_name=REPOSITORY_FULL_NAME,
        pr_number=number,
        pr_title=f"ABC-1 part {number}",
        pr_url=f"https://github.com/{REPOSITORY_FULL_NAME}/pull/{number}",
        pr_state=state,
        repository_id=repository_id,
        head_ref=head,
        base_ref=base,
        previous_base_refs=list(previous),
        from_fork=from_fork,
        review_state=review,
        ci_state=ci,
        pr_updated_ms=1,
    )


def three_stack() -> list[IssueLink]:
    """Three pull requests, each based on the one before, listed newest first as the index reads them."""
    return [
        link(12, "part-3", "part-2", review="approved", ci="success"),
        link(11, "part-2", "part-1", review="approved", ci="pending"),
        link(10, "part-1", "main", review="approved", ci="success"),
    ]


def test_three_pull_requests_on_each_others_branches_form_one_stack() -> None:
    """Positions count from the pull request on the trunk, and the stack aggregates its entries."""
    positions = stack_positions(three_stack())

    assert {key: value.position for key, value in positions.items()} == {
        f"PR_10#{ISSUE_ID}": 1,
        f"PR_11#{ISSUE_ID}": 2,
        f"PR_12#{ISSUE_ID}": 3,
    }
    first = positions[f"PR_10#{ISSUE_ID}"]
    assert first.size == 3
    assert first.stack_id == f"{REPOSITORY_ID}:10"
    assert first.pr_state == "open"
    assert first.review_state == "approved"
    assert first.ci_state == "pending"
    assert {value.stack_id for value in positions.values()} == {first.stack_id}


def test_a_stack_keeps_its_shape_after_its_bottom_pull_request_merges() -> None:
    """GitHub retargets the next pull request onto the trunk, and its earlier base keeps it in place."""
    rows = [
        link(12, "part-3", "part-2", ci="failure"),
        link(11, "part-2", "main", previous=("part-1",), review="changes_requested", ci="success"),
        link(10, "part-1", "main", state="merged", review="approved", ci="success"),
    ]

    positions = stack_positions(rows)

    assert [positions[f"PR_{number}#{ISSUE_ID}"].position for number in (10, 11, 12)] == [1, 2, 3]
    aggregate = positions[f"PR_10#{ISSUE_ID}"]
    assert aggregate.pr_state == "open"
    assert aggregate.review_state == "changes_requested"
    assert aggregate.ci_state == "failure"


def test_a_fully_merged_stack_reads_as_merged() -> None:
    """Once every entry merged, the stack is merged and nothing is left to review."""
    rows = [link(10, "part-1", state="merged"), link(11, "part-2", "part-1", state="merged")]

    aggregate = stack_positions(rows)[f"PR_10#{ISSUE_ID}"]

    assert aggregate.pr_state == "merged"
    assert aggregate.review_state == "none"
    assert aggregate.ci_state == "none"


def test_an_unstacked_pull_request_has_no_stack() -> None:
    """Two pull requests on the trunk side by side are two rows, not a stack."""
    assert stack_positions([link(10, "part-1"), link(11, "other", "main")]) == {}


def test_a_fork_or_another_repository_never_parents_a_stack() -> None:
    """Branch names only mean something inside one repository."""
    rows = [
        link(10, "part-1", repository_id="999"),
        link(11, "part-2", "part-1"),
        link(12, "part-3", from_fork=True),
        link(13, "part-4", "part-3"),
    ]

    assert stack_positions(rows) == {}


def test_a_branch_cycle_is_cut_at_the_lowest_number() -> None:
    """Two pull requests based on each other still answer, with the lower one at the bottom."""
    positions = stack_positions([link(10, "a", "b"), link(11, "b", "a")])

    assert positions[f"PR_10#{ISSUE_ID}"].position == 1
    assert positions[f"PR_11#{ISSUE_ID}"].position == 2


def state_row(**fields: Any) -> PullRequestState:
    """A state row for pull request 7 with `fields` applied."""
    return PullRequestState(
        workspace_id=WORKSPACE,
        github_key=pr_state_key(REPOSITORY_ID, 7),
        repository_id=REPOSITORY_ID,
        pr_number=7,
        **fields,
    )


def review(review_id: int, login: str, state: str) -> dict[str, Any]:
    """One review object as GitHub sends it."""
    return {"id": review_id, "state": state, "user": {"login": login}}


def test_the_review_decision_keeps_each_reviewers_latest_decision() -> None:
    """A later comment leaves an approval standing, a later request for changes replaces it."""
    state = state_row()
    pr_status.apply_review(state, review(2, "ann", "approved"), "submitted")
    pr_status.apply_review(state, review(3, "ann", "commented"), "submitted")
    assert pr_status.review_state(state) == "approved"

    pr_status.apply_review(state, review(4, "bob", "changes_requested"), "submitted")
    assert pr_status.review_state(state) == "changes_requested"

    pr_status.apply_review(state, review(1, "bob", "approved"), "submitted")
    assert pr_status.review_state(state) == "changes_requested"

    pr_status.apply_review(state, review(4, "bob", "changes_requested"), "dismissed")
    assert pr_status.review_state(state) == "approved"


def test_a_requested_reviewer_with_no_review_is_pending() -> None:
    """A review request with nothing submitted reads as waiting on review."""
    assert pr_status.review_state(state_row(requested_reviewers=1)) == "pending"
    assert pr_status.review_state(state_row()) == "none"


def check(run_id: int, name: str, status: str, conclusion: str | None = None, sha: str = "head") -> dict[str, Any]:
    """One check run object as GitHub sends it."""
    return {"id": run_id, "name": name, "status": status, "conclusion": conclusion, "head_sha": sha}


def test_the_check_state_follows_the_newest_run_of_each_check_on_the_head() -> None:
    """A rerun replaces a failure, a late status cannot reopen a finished run, and old commits do not count."""
    state = state_row(head_sha="head")
    pr_status.apply_check_run(state, check(1, "lint", "completed", "failure"))
    pr_status.apply_check_run(state, check(5, "tests", "in_progress"))
    assert pr_status.ci_state(state) == "failure"

    pr_status.apply_check_run(state, check(2, "lint", "completed", "success"))
    assert pr_status.ci_state(state) == "pending"

    pr_status.apply_check_run(state, check(5, "tests", "completed", "skipped"))
    pr_status.apply_check_run(state, check(5, "tests", "queued"))
    assert pr_status.ci_state(state) == "success"

    pr_status.apply_check_run(state, check(9, "lint", "completed", "failure", sha="older"))
    assert pr_status.ci_state(state) == "success"


def pull_request_delivery(
    number: int, head: str, base: str, *, updated_at: str = "2026-10-01T10:00:00Z", **extra: Any
) -> dict[str, Any]:
    """One `pull_request` delivery naming ABC-1, for pull request `number` from `head` into `base`."""
    pull_request: dict[str, Any] = {
        "number": number,
        "node_id": f"PR_{number}",
        "title": f"ABC-1 part {number}",
        "body": "",
        "state": "open",
        "merged": False,
        "draft": False,
        "html_url": f"https://github.com/{REPOSITORY_FULL_NAME}/pull/{number}",
        "head": {"ref": head, "sha": f"sha{number}", "repo": dict(REPOSITORY)},
        "base": {"ref": base, "sha": "base", "repo": dict(REPOSITORY)},
        "user": {"login": "someone", "id": 4242},
        "author_association": "MEMBER",
        "updated_at": updated_at,
        "requested_reviewers": [{"login": "ann"}],
        "requested_teams": [],
    }
    pull_request.update(extra)
    return {
        "event": "pull_request",
        "delivery": f"pr-{number}",
        "body": {
            "action": "opened",
            "installation": {"id": int(INSTALLATION_ID)},
            "repository": {"id": int(REPOSITORY_ID), "full_name": REPOSITORY_FULL_NAME},
            "pull_request": pull_request,
        },
    }


def review_delivery(number: int, review_id: int, state: str) -> dict[str, Any]:
    """One `pull_request_review` delivery on pull request `number`."""
    pull_request = pull_request_delivery(number, "", "")["body"]["pull_request"]
    pull_request["updated_at"] = "2026-10-01T09:00:00Z"
    return {
        "event": "pull_request_review",
        "delivery": f"review-{review_id}",
        "body": {
            "action": "submitted",
            "installation": {"id": int(INSTALLATION_ID)},
            "repository": {"id": int(REPOSITORY_ID), "full_name": REPOSITORY_FULL_NAME},
            "pull_request": pull_request,
            "review": review(review_id, "ann", state),
        },
    }


def check_delivery(number: int, run_id: int, status: str, conclusion: str | None, *, app: str = "ci") -> dict[str, Any]:
    """One `check_run` delivery on pull request `number`'s head commit."""
    return {
        "event": "check_run",
        "delivery": f"check-{run_id}",
        "body": {
            "action": "completed" if status == "completed" else "created",
            "installation": {"id": int(INSTALLATION_ID)},
            "repository": {"id": int(REPOSITORY_ID), "full_name": REPOSITORY_FULL_NAME},
            "check_run": {
                **check(run_id, "tests", status, conclusion, sha=f"sha{number}"),
                "app": {"slug": app},
                "pull_requests": [{"number": number, "base": {"repo": {"id": int(REPOSITORY_ID)}}}],
            },
        },
    }


def deliver(repositories: Any, payload: dict[str, Any]) -> None:
    """Run one delivery through the consumer."""
    events.handle_record(repositories, sqs_record(payload))


def test_reviews_and_checks_reach_the_link_through_the_consumer(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A linked pull request's link row carries its branches, review decision and checks."""
    deliver(repositories, pull_request_delivery(10, "part-1", "main"))
    stored = repositories.github.list_links_for_pr(WORKSPACE, "PR_10")[0]
    assert (stored.head_ref, stored.base_ref, stored.review_state, stored.ci_state) == (
        "part-1",
        "main",
        "pending",
        "none",
    )

    deliver(repositories, review_delivery(10, 100, "APPROVED"))
    deliver(repositories, check_delivery(10, 200, "in_progress", None))
    stored = repositories.github.list_links_for_pr(WORKSPACE, "PR_10")[0]
    assert (stored.review_state, stored.ci_state) == ("approved", "pending")

    deliver(repositories, check_delivery(10, 200, "completed", "failure"))
    deliver(repositories, check_delivery(10, 300, "completed", "success", app=APP_SLUG))
    stored = repositories.github.list_links_for_pr(WORKSPACE, "PR_10")[0]
    assert stored.ci_state == "failure"


def test_checks_and_reviews_on_an_unlinked_pull_request_write_nothing(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """Only a pull request that links an issue gets a state row."""
    deliver(repositories, check_delivery(44, 1, "completed", "success"))
    deliver(repositories, review_delivery(44, 2, "APPROVED"))

    assert repositories.github.get_pr_state(WORKSPACE, REPOSITORY_ID, 44) is None


def test_a_retargeted_base_is_remembered_from_the_edit(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """An `edited` delivery's `changes.base.ref.from` joins the history even if the open was never seen."""
    payload = pull_request_delivery(11, "part-2", "main", updated_at="2026-10-01T11:00:00Z")
    payload["body"]["action"] = "edited"
    payload["body"]["changes"] = {"base": {"ref": {"from": "part-1"}, "sha": {"from": "x"}}}
    deliver(repositories, payload)

    stored = repositories.github.list_links_for_pr(WORKSPACE, "PR_11")[0]
    assert stored.base_ref == "main"
    assert stored.previous_base_refs == ["part-1"]


def seed_stack(repositories: Any) -> None:
    """Three stacked pull requests on ABC-1, the bottom one merged and its successor retargeted."""
    deliver(repositories, pull_request_delivery(10, "part-1", "main"))
    deliver(repositories, pull_request_delivery(11, "part-2", "part-1"))
    deliver(repositories, pull_request_delivery(12, "part-3", "part-2"))
    deliver(repositories, pull_request_delivery(13, "lone", "main"))
    merged = pull_request_delivery(10, "part-1", "main", updated_at="2026-10-01T12:00:00Z", merged=True, state="closed")
    merged["body"]["action"] = "closed"
    deliver(repositories, merged)
    deliver(repositories, pull_request_delivery(11, "part-2", "main", updated_at="2026-10-01T12:01:00Z"))


def test_the_issue_links_route_returns_the_stack(
    client: TestClient,
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
) -> None:
    """The route gives every stacked link its position and the stack's aggregate, and leaves the lone one alone."""
    seed_stack(repositories)
    sign_in(client, OWNER)

    response = client.get(f"/api/workspaces/{WORKSPACE}/issues/{issue.issue_id}/github-links")

    assert response.status_code == 200
    rows = {row["pr_number"]: row for row in response.json()["items"]}
    assert rows[13]["stack"] is None
    assert [rows[number]["stack"]["position"] for number in (10, 11, 12)] == [1, 2, 3]
    assert {rows[number]["stack"]["size"] for number in (10, 11, 12)} == {3}
    assert rows[10]["pr_state"] == "merged"
    assert rows[11]["base_ref"] == "main"
    assert rows[10]["stack"]["pr_state"] == "open"
    assert rows[12]["review_state"] == "pending"
    assert rows[12]["ci_state"] == "none"


def test_get_issue_over_mcp_returns_the_stack(
    client: TestClient,
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
) -> None:
    """The MCP issue read carries the same pull requests and stack grouping as the route."""
    seed_stack(repositories)
    secret = mint_for(repositories, OWNER, ("issues:read",))

    found = answer(tool(client, secret, "get_issue", {"issue_id": "ABC-1"}))

    rows = {row["pr_number"]: row for row in found["pull_requests"]}
    assert set(rows) == {10, 11, 12, 13}
    assert rows[12]["stack"]["position"] == 3
    assert rows[13]["stack"] is None
