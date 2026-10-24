"""The "mentioned in" backlinks a comment leaves on the issues it names by key.

The rows are read straight off the activity table, because the history route
belongs to the issues domain and this one only writes the rows.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.activity import as_activity
from tests.domains.discussion.conftest import TEAM, seed_issue
from tests.domains.discussion.test_comments import post_comment
from tests.domains.helpers import GUEST, MEMBER, sign_in

TARGET = "01JB0000000000000000000IS9"


def backlinks(repositories: Any, workspace: str, issue_id: str) -> list[Any]:
    """Every "mentioned" row on one issue, newest first."""
    page = repositories.activity.list_for_issue(workspace, issue_id, limit=50)
    return [row for row in (as_activity(item) for item in page.items) if row.kind == "mentioned"]


def test_a_comment_naming_an_issue_leaves_a_backlink(
    client: TestClient, repositories: Any, workspace: str, issue: Any
) -> None:
    """The named issue's history says which issue and comment mentioned it."""
    seed_issue(repositories, workspace, TEAM, TARGET, 2)
    sign_in(client, MEMBER)
    created = post_comment(client, workspace, issue.issue_id, body="Same root cause as ABC-2")

    rows = backlinks(repositories, workspace, TARGET)
    assert len(rows) == 1
    assert rows[0].field == "comment"
    assert rows[0].actor_id == MEMBER
    assert rows[0].to_value["id"] == issue.issue_id
    assert rows[0].to_value["key"] == "ABC-1"
    assert rows[0].to_value["comment_id"] == created["comment_id"]


def test_an_edit_backlinks_only_the_keys_it_adds(
    client: TestClient, repositories: Any, workspace: str, issue: Any
) -> None:
    """Rewording a comment that already names an issue does not mention it twice."""
    seed_issue(repositories, workspace, TEAM, TARGET, 2)
    third = seed_issue(repositories, workspace, TEAM, "01JB0000000000000000000IS8", 3)
    sign_in(client, MEMBER)
    created = post_comment(client, workspace, issue.issue_id, body="See ABC-2")

    response = client.patch(
        f"/api/workspaces/{workspace}/comments/{created['comment_id']}",
        json={"issue_id": issue.issue_id, "body": "See ABC-2 and ABC-3"},
    )
    assert response.status_code == 200, response.text

    assert len(backlinks(repositories, workspace, TARGET)) == 1
    assert len(backlinks(repositories, workspace, third.issue_id)) == 1


def test_a_key_in_code_or_on_its_own_issue_leaves_nothing(
    client: TestClient, repositories: Any, workspace: str, issue: Any
) -> None:
    """A quoted key is not a reference, and an issue does not backlink itself."""
    seed_issue(repositories, workspace, TEAM, TARGET, 2)
    sign_in(client, MEMBER)
    post_comment(client, workspace, issue.issue_id, body="ABC-1 logs `ABC-2` here")

    assert backlinks(repositories, workspace, TARGET) == []
    assert backlinks(repositories, workspace, issue.issue_id) == []


def test_a_key_in_a_team_the_author_cannot_see_leaves_nothing(
    client: TestClient, repositories: Any, workspace: str, issue: Any, hidden_issue: Any
) -> None:
    """A guest naming an issue outside their teams writes no row onto it."""
    sign_in(client, GUEST)
    post_comment(client, workspace, issue.issue_id, body="Maybe XYZ-1 too")

    assert backlinks(repositories, workspace, hidden_issue.issue_id) == []
