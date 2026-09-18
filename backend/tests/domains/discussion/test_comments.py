"""The comment routes: the thread, the single-comment reads, and the two writes.

The happy paths live here and the refusals live in `test_discussion_authz`, so a
change that loosens a rule fails in the file about rules rather than quietly
passing here.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.discussion.conftest import PROJECT, seed_issue
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, sign_in


def post_comment(client: TestClient, workspace: str, issue_id: str, **payload: Any) -> "dict[str, Any]":
    """Create one comment through the route, failing loudly on a refusal."""
    body: "dict[str, Any]" = {"body": "A comment"}
    body.update(payload)
    response = client.post(f"/api/workspaces/{workspace}/issues/{issue_id}/comments", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def test_a_member_can_comment_on_an_issue(client: TestClient, workspace: str, issue: Any) -> None:
    """The create route answers 201 with the stored comment and its author."""
    sign_in(client, MEMBER)
    created = post_comment(client, workspace, issue.issue_id, body="Hello there")

    assert created["body"] == "Hello there"
    assert created["issue_id"] == issue.issue_id
    assert created["project_id"] == PROJECT
    assert created["author_id"] == MEMBER
    assert created["author"]["display_name"] == "Mel Member"
    assert created["parent_comment_id"] is None
    assert created["edited_at"] is None
    assert created["reply_count"] == 0


def test_a_thread_reads_oldest_first(client: TestClient, workspace: str, issue: Any) -> None:
    """The list is ascending, so a thread reads in the order it was written."""
    sign_in(client, MEMBER)
    for index in range(3):
        post_comment(client, workspace, issue.issue_id, body=f"Comment {index}")

    response = client.get(f"/api/workspaces/{workspace}/issues/{issue.issue_id}/comments")
    assert response.status_code == 200, response.text
    bodies = [row["body"] for row in response.json()["comments"]]
    assert bodies == ["Comment 0", "Comment 1", "Comment 2"]


def test_the_thread_pages_with_an_opaque_cursor(client: TestClient, workspace: str, issue: Any) -> None:
    """A page hands back a cursor that resumes exactly where it stopped."""
    sign_in(client, MEMBER)
    for index in range(3):
        post_comment(client, workspace, issue.issue_id, body=f"Comment {index}")

    first = client.get(f"/api/workspaces/{workspace}/issues/{issue.issue_id}/comments?limit=2").json()
    assert len(first["comments"]) == 2
    assert first["next_cursor"]

    second = client.get(
        f"/api/workspaces/{workspace}/issues/{issue.issue_id}/comments",
        params={"limit": 2, "cursor": first["next_cursor"]},
    ).json()
    assert [row["body"] for row in second["comments"]] == ["Comment 2"]


def test_a_cursor_from_another_thread_is_dropped(
    client: TestClient, repositories: Any, workspace: str, issue: Any
) -> None:
    """A cursor is scoped, so one thread's cursor never pages another's rows.

    The foreign cursor is dropped and the read starts from the beginning of the
    thread that was actually asked for, rather than being handed to DynamoDB as a
    start key into a partition the cursor was not minted against.
    """
    other = seed_issue(repositories, workspace, PROJECT, "01JB0000000000000000000IS3", 2)
    sign_in(client, MEMBER)
    for index in range(3):
        post_comment(client, workspace, issue.issue_id, body=f"Comment {index}")
    post_comment(client, workspace, other.issue_id, body="Only one here")

    cursor = client.get(f"/api/workspaces/{workspace}/issues/{issue.issue_id}/comments?limit=1").json()["next_cursor"]
    response = client.get(
        f"/api/workspaces/{workspace}/issues/{other.issue_id}/comments",
        params={"cursor": cursor},
    )
    assert response.status_code == 200, response.text
    assert [row["body"] for row in response.json()["comments"]] == ["Only one here"]


def test_a_reply_counts_against_its_parent(client: TestClient, workspace: str, issue: Any) -> None:
    """`reply_count` counts direct replies, over the thread rather than the page."""
    sign_in(client, MEMBER)
    parent = post_comment(client, workspace, issue.issue_id, body="Parent")
    post_comment(client, workspace, issue.issue_id, body="Reply", parent_comment_id=parent["comment_id"])

    rows = client.get(f"/api/workspaces/{workspace}/issues/{issue.issue_id}/comments").json()["comments"]
    by_id = {row["comment_id"]: row for row in rows}
    assert by_id[parent["comment_id"]]["reply_count"] == 1


def test_replies_are_one_level_deep(client: TestClient, workspace: str, issue: Any) -> None:
    """Replying to a reply is a 409 rather than a silently reparented comment."""
    sign_in(client, MEMBER)
    parent = post_comment(client, workspace, issue.issue_id, body="Parent")
    reply = post_comment(client, workspace, issue.issue_id, body="Reply", parent_comment_id=parent["comment_id"])

    response = client.post(
        f"/api/workspaces/{workspace}/issues/{issue.issue_id}/comments",
        json={"body": "Nested", "parent_comment_id": reply["comment_id"]},
    )
    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "CONFLICT"


def test_a_mention_resolves_to_a_member_id(client: TestClient, workspace: str, issue: Any) -> None:
    """`mentions` holds user ids, resolved from the handles in the body."""
    sign_in(client, MEMBER)
    created = post_comment(client, workspace, issue.issue_id, body="ping @admin please")
    assert created["mentions"] == [ADMIN]


def test_a_mention_of_a_stranger_is_dropped(client: TestClient, workspace: str, issue: Any) -> None:
    """An unmatched handle is dropped rather than stored as a dangling id."""
    sign_in(client, MEMBER)
    created = post_comment(client, workspace, issue.issue_id, body="ping @nobody")
    assert created["mentions"] == []


def test_a_comment_is_read_by_id_with_its_issue(client: TestClient, workspace: str, issue: Any) -> None:
    """The single read takes `issue_id`, because that is the partition."""
    sign_in(client, MEMBER)
    created = post_comment(client, workspace, issue.issue_id, body="Readable")

    response = client.get(
        f"/api/workspaces/{workspace}/comments/{created['comment_id']}",
        params={"issue_id": issue.issue_id},
    )
    assert response.status_code == 200, response.text
    assert response.json()["body"] == "Readable"


def test_reading_a_comment_without_its_issue_is_refused(client: TestClient, workspace: str, issue: Any) -> None:
    """`issue_id` is required, so the read can never become a scan."""
    sign_in(client, MEMBER)
    created = post_comment(client, workspace, issue.issue_id, body="Readable")

    response = client.get(f"/api/workspaces/{workspace}/comments/{created['comment_id']}")
    assert response.status_code == 422, response.text


def test_an_author_edits_their_own_comment(client: TestClient, workspace: str, issue: Any) -> None:
    """An edit rewrites the body, stamps `edited_at` and re-extracts mentions."""
    sign_in(client, MEMBER)
    created = post_comment(client, workspace, issue.issue_id, body="First")

    response = client.patch(
        f"/api/workspaces/{workspace}/comments/{created['comment_id']}",
        json={"issue_id": issue.issue_id, "body": "Second, cc @admin"},
    )
    assert response.status_code == 200, response.text
    edited = response.json()
    assert edited["body"] == "Second, cc @admin"
    assert edited["edited_at"] is not None
    assert edited["mentions"] == [ADMIN]


def test_an_edit_that_drops_a_mention_stops_claiming_it(client: TestClient, workspace: str, issue: Any) -> None:
    """Mentions are recomputed on an edit, so removing one takes it off the row."""
    sign_in(client, MEMBER)
    created = post_comment(client, workspace, issue.issue_id, body="cc @admin")
    assert created["mentions"] == [ADMIN]

    edited = client.patch(
        f"/api/workspaces/{workspace}/comments/{created['comment_id']}",
        json={"issue_id": issue.issue_id, "body": "never mind"},
    ).json()
    assert edited["mentions"] == []


def test_an_author_deletes_their_own_comment(client: TestClient, workspace: str, issue: Any) -> None:
    """A delete answers 204 and the comment stops being readable."""
    sign_in(client, MEMBER)
    created = post_comment(client, workspace, issue.issue_id, body="Regrettable")

    response = client.delete(
        f"/api/workspaces/{workspace}/comments/{created['comment_id']}",
        params={"issue_id": issue.issue_id},
    )
    assert response.status_code == 204, response.text

    after = client.get(
        f"/api/workspaces/{workspace}/comments/{created['comment_id']}",
        params={"issue_id": issue.issue_id},
    )
    assert after.status_code == 404


def test_a_project_admin_deletes_someone_elses_comment(client: TestClient, workspace: str, issue: Any) -> None:
    """Deleting is the moderation verb, so an admin may remove another's comment."""
    sign_in(client, MEMBER)
    created = post_comment(client, workspace, issue.issue_id, body="Moderated")

    sign_in(client, ADMIN)
    response = client.delete(
        f"/api/workspaces/{workspace}/comments/{created['comment_id']}",
        params={"issue_id": issue.issue_id},
    )
    assert response.status_code == 204, response.text


def test_deleting_a_parent_reparents_its_replies(client: TestClient, workspace: str, issue: Any) -> None:
    """A reply outlives its parent, reparented to the thread root.

    Removing one comment must never take someone else's words with it.
    """
    sign_in(client, MEMBER)
    parent = post_comment(client, workspace, issue.issue_id, body="Parent")
    reply = post_comment(client, workspace, issue.issue_id, body="Reply", parent_comment_id=parent["comment_id"])

    client.delete(
        f"/api/workspaces/{workspace}/comments/{parent['comment_id']}",
        params={"issue_id": issue.issue_id},
    )

    rows = client.get(f"/api/workspaces/{workspace}/issues/{issue.issue_id}/comments").json()["comments"]
    remaining = {row["comment_id"]: row for row in rows}
    assert reply["comment_id"] in remaining
    assert remaining[reply["comment_id"]]["parent_comment_id"] is None


def test_deleting_a_comment_removes_its_reactions(client: TestClient, workspace: str, issue: Any) -> None:
    """Nothing but the comment's id names its reaction partition, so they go with it."""
    sign_in(client, MEMBER)
    created = post_comment(client, workspace, issue.issue_id, body="Reacted to")
    client.put(
        f"/api/workspaces/{workspace}/reactions",
        json={
            "target_id": created["comment_id"],
            "target_kind": "comment",
            "issue_id": issue.issue_id,
            "emoji": "\N{THUMBS UP SIGN}",
        },
    )

    client.delete(
        f"/api/workspaces/{workspace}/comments/{created['comment_id']}",
        params={"issue_id": issue.issue_id},
    )

    replacement = post_comment(client, workspace, issue.issue_id, body="Another")
    rows = client.get(f"/api/workspaces/{workspace}/issues/{issue.issue_id}/comments").json()["comments"]
    assert all(row["reactions"] == [] for row in rows if row["comment_id"] == replacement["comment_id"])

    left = client.get(
        f"/api/workspaces/{workspace}/reactions",
        params={"target_id": created["comment_id"], "target_kind": "comment", "issue_id": issue.issue_id},
    )
    assert left.status_code == 404


def test_an_empty_body_is_refused(client: TestClient, workspace: str, issue: Any) -> None:
    """A blank comment is a 422 naming the field rather than an empty row."""
    sign_in(client, MEMBER)
    response = client.post(
        f"/api/workspaces/{workspace}/issues/{issue.issue_id}/comments",
        json={"body": "   "},
    )
    assert response.status_code == 422, response.text


def test_a_guest_in_the_project_may_comment(client: TestClient, workspace: str, issue: Any) -> None:
    """A guest is a member of the project it was added to, so it writes there."""
    sign_in(client, GUEST)
    created = post_comment(client, workspace, issue.issue_id, body="Guest comment")
    assert created["author_id"] == GUEST


def test_an_owner_reads_the_thread(client: TestClient, workspace: str, issue: Any) -> None:
    """An owner sees every project's threads without an explicit project role."""
    sign_in(client, MEMBER)
    post_comment(client, workspace, issue.issue_id, body="Visible")

    sign_in(client, OWNER)
    response = client.get(f"/api/workspaces/{workspace}/issues/{issue.issue_id}/comments")
    assert response.status_code == 200, response.text
    assert len(response.json()["comments"]) == 1
