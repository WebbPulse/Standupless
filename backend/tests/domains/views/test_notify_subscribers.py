"""Subscriber fan-out: comments and status changes reach everyone following an issue.

The issue routes write the `subscriptions` rows, so each test creates its issue
through them and then hands the notify consumer the stream record the write would
produce. The actor is always left out, and nobody hears about one record twice.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.identity.email import RecordingEmailSender

from app.common.email import reset_email_sender
from app.domains.views.consumers.notify import handle_record
from tests.domains.helpers import ADMIN, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import TEAM, seed_issue
from tests.domains.views.test_notify_consumer import (
    COMMENTS_ARN,
    ISSUES_ARN,
    _image,
    _record,
    inbox_of,
    put_comment,
)


@pytest.fixture
def recorder() -> Iterator[RecordingEmailSender]:
    """A recording sender installed as the process-wide one for one test."""
    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


def kinds(repositories: Any, workspace: str, user_id: str) -> list[str]:
    """The kinds of every notification one member holds, newest first."""
    return [row["kind"] for row in inbox_of(repositories, workspace, user_id)]


def comment_record(repositories: Any, workspace: str, issue_id: str, author: str, comment_id: str) -> "dict[str, Any]":
    """Store one comment and return the stream record its insert produces."""
    put_comment(repositories, workspace, issue_id, comment_id, author_id=author, body="A thought")
    return _record(
        COMMENTS_ARN,
        "INSERT",
        new=_image(
            workspace_id=workspace,
            issue_id=issue_id,
            comment_id=comment_id,
            author_id=author,
            team_id=TEAM,
            body="A thought",
        ),
    )


def status_record(workspace: str, issue_id: str, actor: str, assignee: str | None = None) -> "dict[str, Any]":
    """One issue record that moves the status from `OLD` to `NEW`."""
    return _record(
        ISSUES_ARN,
        "MODIFY",
        new=_image(workspace_id=workspace, issue_id=issue_id, status_id="NEW", assignee_id=assignee, updated_by=actor),
        old=_image(workspace_id=workspace, issue_id=issue_id, status_id="OLD", assignee_id=assignee),
    )


def test_a_comment_reaches_every_subscriber_but_its_author(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The creator follows their own issue, and a manual subscriber hears too."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Followed")
    repositories.subscriptions.subscribe(workspace, issue["id"], TEAM, ADMIN, "manual")
    repositories.subscriptions.subscribe(workspace, issue["id"], TEAM, MEMBER, "manual")

    handle_record(
        repositories, comment_record(repositories, workspace, issue["id"], MEMBER, "01JB00000000000000000SUB1")
    )

    assert kinds(repositories, workspace, OWNER) == ["commented"]
    assert kinds(repositories, workspace, ADMIN) == ["commented"]
    assert kinds(repositories, workspace, MEMBER) == []


def test_unsubscribing_stops_comment_notifications(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Leaving an issue is the whole point of the toggle."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Left")
    response = issues_client.delete(f"/api/workspaces/{workspace}/issues/{issue['id']}/subscribers/me")
    assert response.status_code == 200, response.text

    handle_record(
        repositories, comment_record(repositories, workspace, issue["id"], MEMBER, "01JB00000000000000000SUB2")
    )

    assert kinds(repositories, workspace, OWNER) == []


def test_a_status_change_reaches_subscribers_and_the_assignee_but_not_the_actor(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The person who moved the issue already knows it moved."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Moving", assignee_id=MEMBER)
    repositories.subscriptions.unsubscribe(workspace, issue["id"], MEMBER)
    repositories.subscriptions.subscribe(workspace, issue["id"], TEAM, ADMIN, "manual")

    handle_record(repositories, status_record(workspace, issue["id"], actor=ADMIN, assignee=MEMBER))

    assert kinds(repositories, workspace, OWNER) == ["status_changed"]
    assert kinds(repositories, workspace, MEMBER) == ["status_changed"]
    assert kinds(repositories, workspace, ADMIN) == []


def test_a_description_mention_on_create_notifies_the_mentioned(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """Being named in a new issue is news, and it mails with its own headline."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Named", body="Over to @member")

    handle_record(
        repositories,
        _record(
            ISSUES_ARN,
            "INSERT",
            new=_image(
                workspace_id=workspace,
                issue_id=issue["id"],
                created_by=OWNER,
                body="Over to @member",
                mentioned_user_ids=[MEMBER],
            ),
        ),
    )

    assert kinds(repositories, workspace, MEMBER) == ["mentioned"]
    assert kinds(repositories, workspace, OWNER) == []
    assert [item.to for item in recorder.sent] == ["member@example.com"]
    assert "mentioned you in this issue" in recorder.sent[0].text


def test_editing_a_description_notifies_only_the_newly_mentioned(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Someone already named is not pinged again by an unrelated edit."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Edited")

    handle_record(
        repositories,
        _record(
            ISSUES_ARN,
            "MODIFY",
            new=_image(
                workspace_id=workspace,
                issue_id=issue["id"],
                updated_by=OWNER,
                body="cc @member @admin",
                mentioned_user_ids=[MEMBER, ADMIN],
            ),
            old=_image(workspace_id=workspace, issue_id=issue["id"], body="cc @member", mentioned_user_ids=[MEMBER]),
        ),
    )

    assert kinds(repositories, workspace, ADMIN) == ["mentioned"]
    assert kinds(repositories, workspace, MEMBER) == []


def test_assigned_and_mentioned_in_one_write_hears_only_the_assignment(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """One record, one notification per person."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Both")

    handle_record(
        repositories,
        _record(
            ISSUES_ARN,
            "MODIFY",
            new=_image(
                workspace_id=workspace,
                issue_id=issue["id"],
                updated_by=OWNER,
                assignee_id=MEMBER,
                body="yours @member",
                mentioned_user_ids=[MEMBER],
            ),
            old=_image(workspace_id=workspace, issue_id=issue["id"]),
        ),
    )

    assert kinds(repositories, workspace, MEMBER) == ["assigned"]


def test_inbox_off_files_the_row_already_read(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """The email still goes out, and the row keeps the send idempotent without a badge."""
    repositories.users.update(MEMBER, notification_preferences={"status_changed": {"in_app": False}})
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Quiet inbox", assignee_id=MEMBER)

    handle_record(repositories, status_record(workspace, issue["id"], actor=OWNER, assignee=MEMBER))

    rows = inbox_of(repositories, workspace, MEMBER)
    assert [row["kind"] for row in rows] == ["status_changed"]
    assert rows[0].get("unread_at") is None
    assert [item.to for item in recorder.sent] == ["member@example.com"]


def test_both_channels_off_writes_nothing(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """A kind the person turned off entirely leaves no trace."""
    repositories.users.update(MEMBER, notification_preferences={"commented": {"in_app": False, "email": False}})
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Silent", assignee_id=MEMBER)

    handle_record(
        repositories, comment_record(repositories, workspace, issue["id"], OWNER, "01JB00000000000000000SUB3")
    )

    assert kinds(repositories, workspace, MEMBER) == []
    assert recorder.sent == []


def test_email_off_for_one_kind_keeps_the_inbox_and_other_kinds_mailing(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """The per kind switch is narrower than the account wide one."""
    repositories.users.update(MEMBER, notification_preferences={"status_changed": {"email": False}})
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Picky", assignee_id=MEMBER)

    handle_record(repositories, status_record(workspace, issue["id"], actor=OWNER, assignee=MEMBER))
    assert kinds(repositories, workspace, MEMBER) == ["status_changed"]
    assert recorder.sent == []

    handle_record(
        repositories, comment_record(repositories, workspace, issue["id"], OWNER, "01JB00000000000000000SUB4")
    )
    assert [item.to for item in recorder.sent] == ["member@example.com"]
