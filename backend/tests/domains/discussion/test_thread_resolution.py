"""Resolving a comment thread, unresolving it, and a reply reopening it.

The mark lives on the thread's root comment, so every assertion reads it back
through the thread list, which is the read the issue view collapses from. The
history rows are read straight off the activity table, because the history route
belongs to the issues domain.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.activity import as_activity
from tests.domains.discussion.test_comments import post_comment
from tests.domains.helpers import GUEST, MEMBER, OWNER, sign_in


def resolution_path(workspace: str, issue_id: str, comment_id: str) -> str:
    """The resolution route for one comment."""
    return f"/api/workspaces/{workspace}/issues/{issue_id}/comments/{comment_id}/resolution"


def thread_rows(repositories: Any, workspace: str, issue_id: str) -> list[Any]:
    """Every thread resolution row on one issue, resolves ahead of reopens.

    Ordered by kind rather than by id, because two rows written in the same
    millisecond carry ULIDs whose order is random, and each test here writes at
    most one row of each kind.
    """
    page = repositories.activity.list_for_issue(workspace, issue_id, limit=50)
    rows = [as_activity(item) for item in page.items]
    return sorted(
        (row for row in rows if row.kind in ("thread_resolved", "thread_unresolved")),
        key=lambda row: row.kind,
    )


def root_of(client: TestClient, workspace: str, issue_id: str, comment_id: str) -> "dict[str, Any]":
    """The stored comment as the thread list hands it back."""
    response = client.get(f"/api/workspaces/{workspace}/issues/{issue_id}/comments")
    assert response.status_code == 200, response.text
    return next(row for row in response.json()["comments"] if row["comment_id"] == comment_id)


def test_a_member_resolves_a_thread(client: TestClient, repositories: Any, workspace: str, issue: Any) -> None:
    """Resolving stores who resolved it on the root and records one history row."""
    sign_in(client, MEMBER)
    root = post_comment(client, workspace, issue.issue_id, body="Should we ship this?")
    assert root["resolution"] is None

    response = client.put(resolution_path(workspace, issue.issue_id, root["comment_id"]))
    assert response.status_code == 200, response.text
    assert response.json()["resolution"]["resolved_by"] == MEMBER
    assert response.json()["resolution"]["resolved_at"]

    assert root_of(client, workspace, issue.issue_id, root["comment_id"])["resolution"]["resolved_by"] == MEMBER
    rows = thread_rows(repositories, workspace, issue.issue_id)
    assert [(row.kind, row.actor_id, row.to_value, row.field) for row in rows] == [
        ("thread_resolved", MEMBER, root["comment_id"], None)
    ]


def test_resolving_twice_records_one_row(client: TestClient, repositories: Any, workspace: str, issue: Any) -> None:
    """A second resolve answers the same mark and leaves the history alone."""
    sign_in(client, MEMBER)
    root = post_comment(client, workspace, issue.issue_id)
    first = client.put(resolution_path(workspace, issue.issue_id, root["comment_id"])).json()

    sign_in(client, OWNER)
    second = client.put(resolution_path(workspace, issue.issue_id, root["comment_id"]))
    assert second.status_code == 200, second.text
    assert second.json()["resolution"] == first["resolution"]
    assert len(thread_rows(repositories, workspace, issue.issue_id)) == 1


def test_anyone_can_unresolve_a_thread(client: TestClient, repositories: Any, workspace: str, issue: Any) -> None:
    """A different member clears the mark, whoever set it, and the history says so."""
    sign_in(client, MEMBER)
    root = post_comment(client, workspace, issue.issue_id)
    client.put(resolution_path(workspace, issue.issue_id, root["comment_id"]))

    sign_in(client, GUEST)
    response = client.delete(resolution_path(workspace, issue.issue_id, root["comment_id"]))
    assert response.status_code == 200, response.text
    assert response.json()["resolution"] is None

    assert root_of(client, workspace, issue.issue_id, root["comment_id"])["resolution"] is None
    rows = thread_rows(repositories, workspace, issue.issue_id)
    assert [(row.kind, row.actor_id, row.field) for row in rows] == [
        ("thread_resolved", MEMBER, None),
        ("thread_unresolved", GUEST, None),
    ]


def test_unresolving_an_open_thread_changes_nothing(
    client: TestClient, repositories: Any, workspace: str, issue: Any
) -> None:
    """Clearing a mark that is not there is a no-op, not a history row."""
    sign_in(client, MEMBER)
    root = post_comment(client, workspace, issue.issue_id)

    response = client.delete(resolution_path(workspace, issue.issue_id, root["comment_id"]))
    assert response.status_code == 200, response.text
    assert response.json()["resolution"] is None
    assert thread_rows(repositories, workspace, issue.issue_id) == []


def test_a_reply_cannot_be_resolved(client: TestClient, workspace: str, issue: Any) -> None:
    """Only a thread's first comment carries the mark, so a reply is a 409."""
    sign_in(client, MEMBER)
    root = post_comment(client, workspace, issue.issue_id)
    reply = post_comment(client, workspace, issue.issue_id, parent_comment_id=root["comment_id"])

    response = client.put(resolution_path(workspace, issue.issue_id, reply["comment_id"]))
    assert response.status_code == 409, response.text


def test_an_unknown_comment_is_a_404(client: TestClient, workspace: str, issue: Any) -> None:
    """A comment id that names nothing on the issue is not found."""
    sign_in(client, MEMBER)
    response = client.put(resolution_path(workspace, issue.issue_id, "01JB0000000000000000000NOPE"))
    assert response.status_code == 404, response.text


def test_a_guest_outside_the_team_cannot_resolve(client: TestClient, workspace: str, hidden_issue: Any) -> None:
    """The issue decides who may resolve, so a guest outside its team gets a 404."""
    sign_in(client, OWNER)
    root = post_comment(client, workspace, hidden_issue.issue_id)

    sign_in(client, GUEST)
    response = client.put(resolution_path(workspace, hidden_issue.issue_id, root["comment_id"]))
    assert response.status_code == 404, response.text


def test_a_reply_reopens_a_resolved_thread(client: TestClient, repositories: Any, workspace: str, issue: Any) -> None:
    """Replying clears the mark and the history names the reply as the reason."""
    sign_in(client, MEMBER)
    root = post_comment(client, workspace, issue.issue_id)
    client.put(resolution_path(workspace, issue.issue_id, root["comment_id"]))

    sign_in(client, OWNER)
    post_comment(client, workspace, issue.issue_id, parent_comment_id=root["comment_id"], body="One more thing")

    assert root_of(client, workspace, issue.issue_id, root["comment_id"])["resolution"] is None
    rows = thread_rows(repositories, workspace, issue.issue_id)
    assert [(row.kind, row.actor_id, row.field, row.to_value) for row in rows] == [
        ("thread_resolved", MEMBER, None, root["comment_id"]),
        ("thread_unresolved", OWNER, "reply", root["comment_id"]),
    ]


def test_a_reply_to_an_open_thread_records_nothing(
    client: TestClient, repositories: Any, workspace: str, issue: Any
) -> None:
    """Only a resolved thread reopens, so a normal reply leaves no resolution row."""
    sign_in(client, MEMBER)
    root = post_comment(client, workspace, issue.issue_id)
    post_comment(client, workspace, issue.issue_id, parent_comment_id=root["comment_id"])

    assert thread_rows(repositories, workspace, issue.issue_id) == []
