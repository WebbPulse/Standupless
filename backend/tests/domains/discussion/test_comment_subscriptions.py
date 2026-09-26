"""Commenting subscribes the commenter and everyone the comment mentions."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.discussion.test_comments import post_comment
from tests.domains.helpers import ADMIN, GUEST, MEMBER, sign_in


def subscribers(repositories: Any, workspace: str, issue_id: str) -> "dict[str, str]":
    """Each subscriber of one issue mapped to the reason they first followed it."""
    return {row.user_id: row.reason for row in repositories.subscriptions.list_for_issue(workspace, issue_id)}


def test_a_comment_subscribes_its_author_and_mentions(
    client: TestClient, workspace: str, issue: Any, repositories: Any
) -> None:
    """The next comment on the issue then reaches both of them."""
    sign_in(client, MEMBER)
    post_comment(client, workspace, issue.issue_id, body="What do you think, @admin?")

    assert subscribers(repositories, workspace, issue.issue_id) == {MEMBER: "commenter", ADMIN: "mentioned"}


def test_an_edit_subscribes_only_the_newly_mentioned(
    client: TestClient, workspace: str, issue: Any, repositories: Any
) -> None:
    """Someone who unsubscribed stays unsubscribed when an edit still mentions them."""
    sign_in(client, MEMBER)
    created = post_comment(client, workspace, issue.issue_id, body="cc @admin")
    repositories.subscriptions.unsubscribe(workspace, issue.issue_id, ADMIN)

    response = client.patch(
        f"/api/workspaces/{workspace}/comments/{created['comment_id']}",
        json={"issue_id": issue.issue_id, "body": "cc @admin and @guest"},
    )
    assert response.status_code == 200, response.text

    assert subscribers(repositories, workspace, issue.issue_id) == {MEMBER: "commenter", GUEST: "mentioned"}
