"""Comments pinned to a passage of the issue description, through the comment routes."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.discussion.test_comments import post_comment
from tests.domains.helpers import MEMBER, sign_in


def comments_path(workspace: str, issue_id: str) -> str:
    """The comments collection of one issue."""
    return f"/api/workspaces/{workspace}/issues/{issue_id}/comments"


def test_an_anchored_comment_reads_back_with_its_passage(client: TestClient, workspace: str, issue: Any) -> None:
    """The anchor is stored on the root and comes back on the create and the list."""
    sign_in(client, MEMBER)
    anchor = {"quote": "  the board query ", "prefix": "We should cache ", "suffix": " before launch"}

    created = post_comment(client, workspace, issue.issue_id, body="Which query?", anchor=anchor)
    listed = client.get(comments_path(workspace, issue.issue_id)).json()["comments"]

    expected = {"quote": "the board query", "prefix": "We should cache ", "suffix": " before launch"}
    assert created["anchor"] == expected
    assert listed[0]["anchor"] == expected


def test_a_plain_comment_has_no_anchor(client: TestClient, workspace: str, issue: Any) -> None:
    """A comment posted without a passage reads back with a null anchor."""
    sign_in(client, MEMBER)

    created = post_comment(client, workspace, issue.issue_id)

    assert created["anchor"] is None


def test_the_context_either_side_is_trimmed(client: TestClient, workspace: str, issue: Any) -> None:
    """Context past the cap is cut to the characters nearest the passage."""
    sign_in(client, MEMBER)

    created = post_comment(
        client,
        workspace,
        issue.issue_id,
        anchor={"quote": "needle", "prefix": "x" * 10 + "p" * 64, "suffix": "s" * 64 + "y" * 10},
    )

    assert created["anchor"]["prefix"] == "p" * 64
    assert created["anchor"]["suffix"] == "s" * 64


def test_a_blank_or_oversized_quote_is_refused(client: TestClient, workspace: str, issue: Any) -> None:
    """A passage must be real text under the cap."""
    sign_in(client, MEMBER)
    path = comments_path(workspace, issue.issue_id)

    blank = client.post(path, json={"body": "Hi", "anchor": {"quote": "   "}})
    long = client.post(path, json={"body": "Hi", "anchor": {"quote": "q" * 1001}})

    assert blank.status_code == 422, blank.text
    assert long.status_code == 422, long.text


def test_a_reply_cannot_carry_an_anchor(client: TestClient, workspace: str, issue: Any) -> None:
    """A reply belongs to its root's passage, so naming another one is refused."""
    sign_in(client, MEMBER)
    root = post_comment(client, workspace, issue.issue_id, anchor={"quote": "the board query"})

    response = client.post(
        comments_path(workspace, issue.issue_id),
        json={"body": "Reply", "parent_comment_id": root["comment_id"], "anchor": {"quote": "other"}},
    )

    assert response.status_code == 422, response.text
