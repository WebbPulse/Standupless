"""Comment draft routes: one unposted comment per member per issue and per reply thread.

The properties held here are that a draft is its author's alone, that saving
again replaces the thread's draft and keeps when it was first saved, that a
draft is held to what posting it would need, that the listing drops drafts on
issues that are gone, and that posting a comment clears the draft it came from
but never one saved after it.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.views import CommentDraft, draft_key
from app.domains.views.consumers.notify import clear_comment_draft, handle_record
from tests.domains.helpers import GUEST, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM, seed_issue
from tests.domains.views.test_notify_consumer import COMMENTS_ARN, _image, _record, inbox_of, put_comment

ROOT = "01C000000000000000000001"

REPLY = "01C000000000000000000002"


def drafts_path(workspace: str, issue_id: str | None = None) -> str:
    """The drafts listing, or one issue's draft route."""
    base = f"/api/workspaces/{workspace}/drafts"
    return base if issue_id is None else f"{base}/{issue_id}"


def save(client: TestClient, workspace: str, issue_id: str, body: str, parent: str | None = None) -> Any:
    """Save a draft through the route."""
    params = {} if parent is None else {"parent_comment_id": parent}
    return client.put(drafts_path(workspace, issue_id), json={"body": body}, params=params)


def listed(client: TestClient, workspace: str, **params: str) -> "list[dict[str, Any]]":
    """The caller's drafts listing, failing loudly on a refusal."""
    response = client.get(drafts_path(workspace), params=params)
    assert response.status_code == 200, response.text
    return response.json()["drafts"]


def test_a_draft_is_saved_read_and_replaced(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """Saving twice keeps one draft holding the latest body and the first save's time."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace, title="Fix the login")
    sign_in(client, MEMBER)

    first = save(client, workspace, issue["id"], "Half a")
    second = save(client, workspace, issue["id"], "Half a thought")
    read = client.get(drafts_path(workspace, issue["id"]))

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert read.status_code == 200, read.text
    body = read.json()
    assert body["body"] == "Half a thought"
    assert body["issue_key"] == issue["key"]
    assert body["issue_title"] == "Fix the login"
    assert body["parent_comment_id"] is None
    assert body["created_at"] == first.json()["created_at"]
    assert [row["body"] for row in listed(client, workspace)] == ["Half a thought"]


def test_drafts_are_the_callers_own(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """Another member reads no draft, lists none and cannot clear the first one's."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)
    sign_in(client, MEMBER)
    save(client, workspace, issue["id"], "Mine")

    sign_in(client, OWNER)
    missing = client.get(drafts_path(workspace, issue["id"]))
    client.delete(drafts_path(workspace, issue["id"]))

    assert missing.status_code == 404
    assert listed(client, workspace) == []
    sign_in(client, MEMBER)
    assert [row["body"] for row in listed(client, workspace)] == ["Mine"]


def test_a_reply_draft_is_its_own_thread(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """The issue's draft and a reply's draft sit side by side and clear apart."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)
    put_comment(repositories, workspace, issue["id"], ROOT, author_id=OWNER, body="Root")
    sign_in(client, MEMBER)

    save(client, workspace, issue["id"], "On the issue")
    reply = save(client, workspace, issue["id"], "On the reply", parent=ROOT)
    on_issue = listed(client, workspace, issue_id=issue["id"])
    deleted = client.delete(drafts_path(workspace, issue["id"]), params={"parent_comment_id": ROOT})

    assert reply.status_code == 200, reply.text
    assert {(row["parent_comment_id"], row["body"]) for row in on_issue} == {
        (None, "On the issue"),
        (ROOT, "On the reply"),
    }
    assert deleted.status_code == 204
    assert [row["body"] for row in listed(client, workspace)] == ["On the issue"]


def test_a_reply_draft_needs_a_root_comment_on_the_issue(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """A draft is only kept where it could be posted: a missing parent is a 404, a reply a 409."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)
    put_comment(repositories, workspace, issue["id"], ROOT, author_id=OWNER, body="Root")
    put_comment(repositories, workspace, issue["id"], REPLY, author_id=OWNER, body="Reply", parent_comment_id=ROOT)
    sign_in(client, MEMBER)

    missing = save(client, workspace, issue["id"], "Hi", parent="01C0000000000000000000NOPE")
    nested = save(client, workspace, issue["id"], "Hi", parent=REPLY)

    assert missing.status_code == 404
    assert nested.status_code == 409
    assert listed(client, workspace) == []


def test_a_blank_draft_is_refused(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """An empty draft is a discard, which is the delete route's job."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)
    sign_in(client, MEMBER)

    response = save(client, workspace, issue["id"], "   ")

    assert response.status_code == 422


def test_a_guest_cannot_draft_outside_their_team(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """A team the guest is outside answers exactly as an issue that does not exist."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, team_id=OTHER_TEAM)
    sign_in(client, GUEST)

    response = save(client, workspace, issue["id"], "Sneaky")

    assert response.status_code == 404
    assert listed(client, workspace) == []


def test_a_draft_on_a_gone_issue_drops_out_and_is_deleted(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """The listing never names an issue that is gone, and tidies the draft away."""
    gone = "01JB0000000000000000000GONE"
    repositories.views.put_draft(
        CommentDraft(
            workspace_id=workspace,
            view_key=draft_key(MEMBER, gone),
            user_id=MEMBER,
            issue_id=gone,
            team_id=TEAM,
            body="Orphan",
        )
    )
    sign_in(client, MEMBER)

    assert listed(client, workspace) == []
    assert repositories.views.get_draft(workspace, MEMBER, gone) is None


def test_deleting_twice_is_not_an_error(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """Discarding is idempotent, so a composer that empties twice is never refused."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)
    sign_in(client, MEMBER)
    save(client, workspace, issue["id"], "Gone soon")

    first = client.delete(drafts_path(workspace, issue["id"]))
    second = client.delete(drafts_path(workspace, issue["id"]))

    assert (first.status_code, second.status_code) == (204, 204)
    assert client.get(drafts_path(workspace, issue["id"])).status_code == 404


def _posted(workspace: str, issue_id: str, author: str, posted_at: str, **fields: Any) -> "dict[str, Any]":
    """A comments stream record for a comment just posted."""
    return _record(
        COMMENTS_ARN,
        "INSERT",
        new=_image(
            workspace_id=workspace,
            issue_id=issue_id,
            comment_id="01C000000000000000000009",
            author_id=author,
            body="Posted",
            created_at=posted_at,
            **fields,
        ),
    )


def test_posting_clears_the_draft_it_came_from(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """The comment's record clears its author's draft in that thread, and notifies nobody of the draft."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)
    sign_in(client, MEMBER)
    save(client, workspace, issue["id"], "About to post")

    handle_record(
        repositories,
        _posted(workspace, issue["id"], MEMBER, (utc_now() + timedelta(seconds=5)).isoformat()),
    )

    assert repositories.views.get_draft(workspace, MEMBER, issue["id"]) is None
    assert inbox_of(repositories, workspace, OWNER) == []


def test_a_draft_saved_after_the_post_survives(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """Starting the next comment before the post's record lands loses nothing."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)
    sign_in(client, MEMBER)
    save(client, workspace, issue["id"], "The next comment")

    cleared = clear_comment_draft(
        repositories,
        _posted(workspace, issue["id"], MEMBER, (utc_now() - timedelta(minutes=1)).isoformat()),
    )

    assert cleared is False
    assert repositories.views.get_draft(workspace, MEMBER, issue["id"]) is not None


def test_posting_clears_only_the_authors_draft_in_that_thread(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """Another member's draft and the author's reply draft are left alone."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)
    put_comment(repositories, workspace, issue["id"], ROOT, author_id=OWNER, body="Root")
    sign_in(client, MEMBER)
    save(client, workspace, issue["id"], "Reply draft", parent=ROOT)
    sign_in(client, OWNER)
    save(client, workspace, issue["id"], "Owner draft")

    clear_comment_draft(
        repositories,
        _posted(workspace, issue["id"], MEMBER, (utc_now() + timedelta(seconds=5)).isoformat()),
    )

    assert repositories.views.get_draft(workspace, MEMBER, issue["id"], ROOT) is not None
    assert repositories.views.get_draft(workspace, OWNER, issue["id"]) is not None


def test_a_bulk_import_clears_nothing(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """Imported comments are history, not posts, so they never touch a draft."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)
    sign_in(client, MEMBER)
    save(client, workspace, issue["id"], "Keep me")

    cleared = clear_comment_draft(
        repositories,
        _posted(
            workspace,
            issue["id"],
            MEMBER,
            (utc_now() + timedelta(seconds=5)).isoformat(),
            import_batch_id="01JB00000000000000000BATCH",
        ),
    )

    assert cleared is False
    assert repositories.views.get_draft(workspace, MEMBER, issue["id"]) is not None


def test_the_purges_remove_a_teams_and_a_members_drafts(workspace: str, repositories: Any) -> None:
    """A team purge takes every draft on its issues, an account purge every draft of the person."""
    for user_id, issue_id, team_id in (
        (MEMBER, "01JB000000000000000000ISS1", TEAM),
        (MEMBER, "01JB000000000000000000ISS2", OTHER_TEAM),
        (OWNER, "01JB000000000000000000ISS3", TEAM),
        (OWNER, "01JB000000000000000000ISS4", OTHER_TEAM),
    ):
        repositories.views.put_draft(
            CommentDraft(
                workspace_id=workspace,
                view_key=draft_key(user_id, issue_id),
                user_id=user_id,
                issue_id=issue_id,
                team_id=team_id,
                body="Draft",
            )
        )

    by_team = repositories.views.delete_drafts_for_team(workspace, TEAM)
    by_member = repositories.views.delete_drafts_for_user(workspace, MEMBER)

    assert (by_team, by_member) == (2, 1)
    assert [row.issue_id for row in repositories.views.list_drafts(workspace, OWNER)] == [
        "01JB000000000000000000ISS4"
    ]
