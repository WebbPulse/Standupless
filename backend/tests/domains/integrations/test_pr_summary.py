"""The pull request summary an issue row carries for its list and board chip.

Pinned end to end through the consumer: a linking delivery writes it, a review,
check or merge moves it, and a delivery that stops naming the issue clears it.
The summary is consumer owned, so a person's edit never restores a stale copy.
"""

from __future__ import annotations

from typing import Any

from app.common.api.schemas.issues import IssueRead
from app.common.db.dynamo.issues import PullRequestSummary
from app.domains.integrations import pr_summary
from tests.domains.integrations.conftest import WORKSPACE
from tests.domains.integrations.test_pr_stacks import (
    ISSUE_ID,
    check_delivery,
    deliver,
    link,
    pull_request_delivery,
    review_delivery,
)


def stored_summary(repositories: Any) -> PullRequestSummary | None:
    """The summary on the seeded issue's row as it is stored."""
    issue = repositories.issues.get(WORKSPACE, ISSUE_ID)
    assert issue is not None
    return issue.pull_request_summary


def test_the_summary_orders_the_most_advanced_first_and_skips_detached_links() -> None:
    """Merged beats open beats draft beats closed, a newer number breaks a tie, and a detached link is gone."""
    built = pr_summary.build_summary(
        [
            link(10, "a", state="closed"),
            link(11, "b", state="open"),
            link(12, "c", state="merged"),
            link(13, "d", state="open"),
            link(14, "e", state="draft"),
            link(15, "f").model_copy(update={"detached": True}),
        ]
    )

    assert built is not None
    assert built.count == 5
    assert [entry.number for entry in built.pull_requests] == [12, 13, 11, 14, 10]
    assert pr_summary.build_summary([link(15, "f").model_copy(update={"detached": True})]) is None


def test_a_linking_delivery_writes_the_summary(
    repositories: Any, installed: str, issue: Any, enqueued: list[tuple[str, Any]], github_env: None
) -> None:
    """The first delivery naming the issue gives its row the pull request, without touching `updated_at`."""
    before = repositories.issues.get(WORKSPACE, ISSUE_ID)

    deliver(repositories, pull_request_delivery(10, "part-1", "main"))

    summary = stored_summary(repositories)
    assert summary is not None
    assert summary.count == 1
    lead = summary.pull_requests[0]
    assert (lead.number, lead.state, lead.review_state, lead.ci_state) == (10, "open", "pending", "none")
    assert lead.url.endswith("/pull/10")
    assert lead.title == "ABC-1 part 10"
    after = repositories.issues.get(WORKSPACE, ISSUE_ID)
    assert after.updated_at == before.updated_at
    assert after.read_revision() == before.read_revision()


def test_reviews_checks_and_a_merge_move_the_summary(
    repositories: Any, installed: str, issue: Any, enqueued: list[tuple[str, Any]], github_env: None
) -> None:
    """A review and a check move the lead entry, and a merge puts the merged pull request first."""
    deliver(repositories, pull_request_delivery(10, "part-1", "main"))
    deliver(repositories, pull_request_delivery(11, "part-2", "main"))

    deliver(repositories, review_delivery(10, 100, "APPROVED"))
    deliver(repositories, check_delivery(10, 200, "completed", "failure"))
    summary = stored_summary(repositories)
    assert summary is not None
    entries = {entry.number: entry for entry in summary.pull_requests}
    assert (entries[10].review_state, entries[10].ci_state) == ("approved", "failure")
    assert [entry.number for entry in summary.pull_requests] == [11, 10]

    merged = pull_request_delivery(10, "part-1", "main", updated_at="2026-10-01T12:00:00Z", merged=True, state="closed")
    merged["body"]["action"] = "closed"
    deliver(repositories, merged)

    summary = stored_summary(repositories)
    assert summary is not None
    assert summary.count == 2
    assert (summary.pull_requests[0].number, summary.pull_requests[0].state) == (10, "merged")


def test_a_delivery_that_stops_naming_the_issue_clears_the_summary(
    repositories: Any, installed: str, issue: Any, enqueued: list[tuple[str, Any]], github_env: None
) -> None:
    """An edit that drops the key detaches the link, and the issue's chip goes with it."""
    deliver(repositories, pull_request_delivery(10, "part-1", "main"))
    assert stored_summary(repositories) is not None

    edited = pull_request_delivery(10, "part-1", "main", updated_at="2026-10-01T12:00:00Z", title="Unrelated")
    edited["body"]["action"] = "edited"
    deliver(repositories, edited)

    assert stored_summary(repositories) is None
    assert repositories.issues.read_pull_request_summary(WORKSPACE, ISSUE_ID) == (None, 2)


def test_a_person_editing_the_issue_keeps_the_summary(
    repositories: Any, installed: str, issue: Any, enqueued: list[tuple[str, Any]], github_env: None
) -> None:
    """An edit built from a read taken before the summary landed never writes it back stale."""
    stale = repositories.issues.get(WORKSPACE, ISSUE_ID)
    deliver(repositories, pull_request_delivery(10, "part-1", "main"))

    repositories.issues.replace(stale.model_copy(update={"title": "Renamed"}))

    assert stale.pull_request_summary is None
    assert repositories.issues.get(WORKSPACE, ISSUE_ID).title == "Renamed"
    summary = stored_summary(repositories)
    assert summary is not None and summary.count == 1


def test_the_issue_read_carries_the_summary(
    repositories: Any, installed: str, issue: Any, enqueued: list[tuple[str, Any]], github_env: None
) -> None:
    """The API shape has the summary when the issue links a pull request, and null when it does not."""
    assert IssueRead.from_row(repositories.issues.get(WORKSPACE, ISSUE_ID)).pull_request_summary is None

    deliver(repositories, pull_request_delivery(10, "part-1", "main"))

    read = IssueRead.from_row(repositories.issues.get(WORKSPACE, ISSUE_ID))
    assert read.pull_request_summary is not None
    assert read.pull_request_summary.count == 1
    assert read.pull_request_summary.pull_requests[0].number == 10
