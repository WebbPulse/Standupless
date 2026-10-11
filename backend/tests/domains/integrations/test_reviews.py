"""The Reviews list: pull requests waiting on the caller as a reviewer.

Pinned end to end: `pull_request` and `pull_request_review` deliveries through the
consumer, then the list read through the route and the MCP tool, plus the inbox
notice a review request leaves.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.github import ReviewEntry
from app.domains.integrations.consumers import events
from app.domains.integrations.reviews import group_for
from tests.domains.helpers import MEMBER, OWNER, sign_in
from tests.domains.integrations.conftest import (
    INSTALLATION_ID,
    REPOSITORY_FULL_NAME,
    REPOSITORY_ID,
    WORKSPACE,
    sqs_record,
)
from tests.domains.integrations.test_events_consumer import link_github_account
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for
from tests.domains.integrations.test_pr_stacks import state_row

OWNER_GITHUB = 500
MEMBER_GITHUB = 501
STRANGER_GITHUB = 999

REPOSITORY = {"id": int(REPOSITORY_ID), "full_name": REPOSITORY_FULL_NAME}


def pull_request(
    number: int,
    *,
    title: str = "Refactor the parser",
    reviewers: tuple[int, ...] = (MEMBER_GITHUB,),
    updated_at: str = "2026-10-01T10:00:00Z",
    **extra: Any,
) -> dict[str, Any]:
    """One pull request payload by the owner's GitHub account, asking `reviewers` for a review."""
    payload: dict[str, Any] = {
        "number": number,
        "node_id": f"PR_{number}",
        "title": title,
        "body": "",
        "state": "open",
        "merged": False,
        "draft": False,
        "html_url": f"https://github.com/{REPOSITORY_FULL_NAME}/pull/{number}",
        "head": {"ref": f"branch-{number}", "sha": f"sha{number}", "repo": dict(REPOSITORY)},
        "base": {"ref": "main", "sha": "base", "repo": dict(REPOSITORY)},
        "user": {"login": "olive", "id": OWNER_GITHUB},
        "author_association": "MEMBER",
        "created_at": "2026-10-01T09:00:00Z",
        "updated_at": updated_at,
        "requested_reviewers": [{"login": f"user{github_id}", "id": github_id} for github_id in reviewers],
        "requested_teams": [],
    }
    payload.update(extra)
    return payload


def pr_delivery(
    number: int,
    action: str = "review_requested",
    *,
    requested: int | None = MEMBER_GITHUB,
    sender: int = OWNER_GITHUB,
    **fields: Any,
) -> dict[str, Any]:
    """One `pull_request` delivery, naming `requested` as the newly requested reviewer."""
    body: dict[str, Any] = {
        "action": action,
        "installation": {"id": int(INSTALLATION_ID)},
        "repository": dict(REPOSITORY),
        "pull_request": pull_request(number, **fields),
        "sender": {"login": f"user{sender}", "id": sender},
    }
    if requested is not None:
        body["requested_reviewer"] = {"login": f"user{requested}", "id": requested}
    return {"event": "pull_request", "delivery": f"pr-{number}-{action}-{fields.get('updated_at', '')}", "body": body}


def review_delivery(number: int, review_id: int, state: str, *, reviewer: int = MEMBER_GITHUB) -> dict[str, Any]:
    """One submitted `pull_request_review` delivery by `reviewer`, after GitHub cleared their request."""
    return {
        "event": "pull_request_review",
        "delivery": f"review-{review_id}",
        "body": {
            "action": "submitted",
            "installation": {"id": int(INSTALLATION_ID)},
            "repository": dict(REPOSITORY),
            "pull_request": pull_request(number, reviewers=(), updated_at="2026-10-01T11:00:00Z"),
            "review": {"id": review_id, "state": state, "user": {"login": f"user{reviewer}", "id": reviewer}},
            "sender": {"login": f"user{reviewer}", "id": reviewer},
        },
    }


def deliver(repositories: Any, payload: dict[str, Any]) -> None:
    """Run one delivery through the consumer."""
    events.handle_record(repositories, sqs_record(payload))


def link_both(repositories: Any) -> None:
    """Link the owner's and the member's GitHub accounts."""
    link_github_account(repositories, OWNER_GITHUB, OWNER)
    link_github_account(repositories, MEMBER_GITHUB, MEMBER)


def notifications(repositories: Any, user_id: str) -> list[dict[str, Any]]:
    """Every inbox row one member holds."""
    return [dict(item) for item in repositories.inbox.list(WORKSPACE, user_id).items]


def reviews(client: TestClient, user_id: str) -> dict[str, Any]:
    """The Reviews list as `user_id` reads it through the route."""
    sign_in(client, user_id)
    response = client.get(f"/api/workspaces/{WORKSPACE}/reviews")
    assert response.status_code == 200, response.text
    return response.json()


def test_a_requested_review_lands_on_the_reviewers_list_without_any_linked_issue(
    client: TestClient,
    repositories: Any,
    installed: str,
    enqueued: list[tuple[str, Any]],
) -> None:
    """A pull request that names no issue still reaches a requested member's list."""
    link_both(repositories)
    deliver(repositories, pr_delivery(20))

    body = reviews(client, MEMBER)

    assert body["github_linked"] is True
    assert body["counts"] == {"needs_review": 1, "changes_requested": 0, "approved": 0}
    [item] = body["items"]
    assert item["number"] == 20
    assert item["group"] == "needs_review"
    assert item["title"] == "Refactor the parser"
    assert item["repository_full_name"] == REPOSITORY_FULL_NAME
    assert item["author_login"] == "olive"
    assert item["url"].endswith("/pull/20")
    assert item["issues"] == []
    assert reviews(client, OWNER)["items"] == []


def test_a_decision_moves_the_pull_request_between_groups(
    client: TestClient,
    repositories: Any,
    installed: str,
    enqueued: list[tuple[str, Any]],
) -> None:
    """Approving moves it to approved, requesting changes to changes requested, a re-request back to needs review."""
    link_both(repositories)
    deliver(repositories, pr_delivery(21))

    deliver(repositories, review_delivery(21, 100, "APPROVED"))
    assert [item["group"] for item in reviews(client, MEMBER)["items"]] == ["approved"]

    deliver(repositories, review_delivery(21, 101, "CHANGES_REQUESTED"))
    assert [item["group"] for item in reviews(client, MEMBER)["items"]] == ["changes_requested"]

    deliver(repositories, pr_delivery(21, updated_at="2026-10-01T12:00:00Z"))
    assert [item["group"] for item in reviews(client, MEMBER)["items"]] == ["needs_review"]


def test_a_merged_pull_request_leaves_the_list_and_drops_its_pointer(
    client: TestClient,
    repositories: Any,
    installed: str,
    enqueued: list[tuple[str, Any]],
) -> None:
    """Merging is terminal: the pointer goes and the list is empty."""
    link_both(repositories)
    deliver(repositories, pr_delivery(22))
    assert repositories.github.list_review_pointers(WORKSPACE, str(MEMBER_GITHUB))

    deliver(
        repositories,
        pr_delivery(22, "closed", requested=None, updated_at="2026-10-01T12:00:00Z", state="closed", merged=True),
    )

    assert repositories.github.list_review_pointers(WORKSPACE, str(MEMBER_GITHUB)) == []
    assert reviews(client, MEMBER)["items"] == []


def test_an_unrequested_reviewer_loses_the_pull_request(
    client: TestClient,
    repositories: Any,
    installed: str,
    enqueued: list[tuple[str, Any]],
) -> None:
    """Removing the request before any decision takes the pull request off the list."""
    link_both(repositories)
    deliver(repositories, pr_delivery(23))

    deliver(repositories, pr_delivery(23, "review_request_removed", reviewers=(), updated_at="2026-10-01T12:00:00Z"))

    assert reviews(client, MEMBER)["items"] == []


def test_a_pull_request_asking_nobody_linked_writes_nothing(
    repositories: Any,
    installed: str,
    enqueued: list[tuple[str, Any]],
) -> None:
    """A pull request with no linked issue and no member reviewer gets no state row and no notice."""
    link_both(repositories)
    deliver(repositories, pr_delivery(24, reviewers=(STRANGER_GITHUB,), requested=STRANGER_GITHUB))

    assert repositories.github.get_pr_state(WORKSPACE, REPOSITORY_ID, 24) is None
    assert repositories.github.list_review_pointers(WORKSPACE, str(STRANGER_GITHUB)) == []


def test_a_caller_with_no_linked_github_account_is_told_so(
    client: TestClient,
    repositories: Any,
    installed: str,
    enqueued: list[tuple[str, Any]],
) -> None:
    """The list says the account is not linked rather than claiming nothing waits."""
    body = reviews(client, MEMBER)

    assert body == {
        "github_linked": False,
        "counts": {"needs_review": 0, "changes_requested": 0, "approved": 0},
        "items": [],
    }


def test_a_review_request_notifies_the_reviewer_once(
    repositories: Any,
    installed: str,
    enqueued: list[tuple[str, Any]],
) -> None:
    """The requested member gets one inbox notice with the pull request's link, even on a redelivery."""
    link_both(repositories)
    deliver(repositories, pr_delivery(25))
    deliver(repositories, pr_delivery(25))

    [notice] = notifications(repositories, MEMBER)
    assert notice["kind"] == "review_requested"
    assert notice["issue_key"] == f"{REPOSITORY_FULL_NAME}#25"
    assert notice["issue_title"] == "Refactor the parser"
    assert notice["url"].endswith("/pull/25")
    assert notice["actor_id"] == OWNER
    assert notifications(repositories, OWNER) == []


def test_requesting_your_own_review_notifies_nobody(
    repositories: Any,
    installed: str,
    enqueued: list[tuple[str, Any]],
) -> None:
    """A member who asks themselves for a review gets no notice, but the list still carries it."""
    link_both(repositories)
    deliver(repositories, pr_delivery(26, sender=MEMBER_GITHUB))

    assert notifications(repositories, MEMBER) == []
    assert repositories.github.list_review_pointers(WORKSPACE, str(MEMBER_GITHUB))


def test_a_reviewer_who_turned_the_notice_off_gets_none(
    repositories: Any,
    installed: str,
    enqueued: list[tuple[str, Any]],
) -> None:
    """The in-app switch for review requests is honoured."""
    link_both(repositories)
    repositories.users.update(MEMBER, notification_preferences={"review_requested": {"in_app": False}})

    deliver(repositories, pr_delivery(27))

    assert notifications(repositories, MEMBER) == []


def test_list_my_reviews_over_mcp_matches_the_route(
    client: TestClient,
    repositories: Any,
    installed: str,
    enqueued: list[tuple[str, Any]],
) -> None:
    """The MCP tool answers the same list as the route."""
    link_both(repositories)
    deliver(repositories, pr_delivery(28))
    secret = mint_for(repositories, MEMBER, ("issues:read",))

    found = answer(tool(client, secret, "list_my_reviews"))

    assert found["github_linked"] is True
    assert [item["number"] for item in found["items"]] == [28]


def test_group_for_reads_the_latest_decision_and_skips_closed_pull_requests() -> None:
    """A requested reviewer needs to review; otherwise their newest decision places the pull request."""
    decided = state_row(
        pr_state="open",
        reviews={
            "mel": ReviewEntry(review_id=2, state="approved", user_id="501"),
            "old": ReviewEntry(review_id=1, state="changes_requested", user_id="501"),
        },
    )
    assert group_for(decided, "501") == "approved"
    assert group_for(decided, "777") is None
    assert group_for(state_row(pr_state="open", requested_user_ids=["501"]), "501") == "needs_review"
    assert group_for(state_row(pr_state="closed", requested_user_ids=["501"]), "501") is None
