"""Email hanging off the notify consumer's conditional put.

The property that matters is that the mail is exactly as idempotent as the badge.
It is sent only when the put wrote a row, so a redelivered stream record sends no
second copy, and nothing about a send can fail the record.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.dynamodb import table_name
from webbpulse.identity.email import RecordingEmailSender

from app.common.core.config import settings
from app.common.email import reset_email_sender
from app.domains.views.consumers.notify import handle_record
from tests.domains.helpers import MEMBER, OWNER, sign_in
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


def assignment(workspace: str, issue_id: str, assignee: str = MEMBER) -> "dict[str, Any]":
    """One record that assigns an issue, which is the simplest thing that notifies."""
    return _record(
        ISSUES_ARN,
        "MODIFY",
        new=_image(workspace_id=workspace, issue_id=issue_id, assignee_id=assignee, updated_by=OWNER),
        old=_image(workspace_id=workspace, issue_id=issue_id),
    )


def test_an_inbox_row_also_mails_its_recipient(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """Every kind of inbox row goes out as one email to the person it is for."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Do the thing", assignee_id=MEMBER)

    handle_record(repositories, assignment(workspace, issue["id"]))

    assert len(inbox_of(repositories, workspace, MEMBER)) == 1
    assert [item.to for item in recorder.sent] == ["member@example.com"]
    assert recorder.sent[0].subject == f"[{issue['key']}] Do the thing"
    assert f"{settings.frontend_base_url}/w/acme/issues/{issue['key']}" in recorder.sent[0].text


def test_a_redelivered_record_writes_no_row_and_sends_no_second_email(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """The whole reason the send hangs off the conditional put rather than the call."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Once", assignee_id=MEMBER)
    record = assignment(workspace, issue["id"])

    handle_record(repositories, record)
    handle_record(repositories, record)

    assert len(inbox_of(repositories, workspace, MEMBER)) == 1
    assert len(recorder.sent) == 1


def test_a_self_notification_mails_nobody(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """No row is written, so by construction no mail goes out either."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Mine", assignee_id=OWNER)

    handle_record(repositories, assignment(workspace, issue["id"], assignee=OWNER))

    assert inbox_of(repositories, workspace, OWNER) == []
    assert recorder.sent == []


def test_turning_the_preference_off_keeps_the_inbox_row(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """The switch is about email alone. The in-app inbox is primary and stays."""
    repositories.users.update(MEMBER, email_notifications=False)
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Quiet", assignee_id=MEMBER)

    handle_record(repositories, assignment(workspace, issue["id"]))

    assert len(inbox_of(repositories, workspace, MEMBER)) == 1
    assert recorder.sent == []


def test_an_unverified_recipient_still_gets_the_inbox_row(
    issues_client: TestClient,
    workspace: str,
    repositories: Any,
    statuses: Any,
    recorder: RecordingEmailSender,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A sandbox this address is outside of is a delivery fact, not a notification one."""
    monkeypatch.setattr(settings, "EMAIL_VERIFIED_RECIPIENTS", "someone-else@example.com")
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Unreachable", assignee_id=MEMBER)

    handle_record(repositories, assignment(workspace, issue["id"]))

    assert len(inbox_of(repositories, workspace, MEMBER)) == 1
    assert recorder.sent == []


def test_a_refused_send_never_fails_the_record(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """SES being down must not wedge the consumer or cost the shard a retry."""
    reset_email_sender(RecordingEmailSender(fail=True))
    try:
        sign_in(issues_client, OWNER)
        issue = seed_issue(issues_client, workspace, title="Down", assignee_id=MEMBER)

        handle_record(repositories, assignment(workspace, issue["id"]))
    finally:
        reset_email_sender(None)

    assert len(inbox_of(repositories, workspace, MEMBER)) == 1


def test_a_comment_email_carries_the_comment(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """A comment notification that showed no comment would say nothing useful."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Discussed", assignee_id=MEMBER)
    comment_id = "01JB0000000000000000000C1"
    put_comment(
        repositories,
        workspace,
        issue["id"],
        comment_id,
        author_id=OWNER,
        body="This one needs a second look",
    )

    handle_record(
        repositories,
        _record(
            COMMENTS_ARN,
            "INSERT",
            new=_image(
                workspace_id=workspace,
                issue_id=issue["id"],
                comment_id=comment_id,
                author_id=OWNER,
                team_id=TEAM,
                body="This one needs a second look",
            ),
        ),
    )

    assert [item.to for item in recorder.sent] == ["member@example.com"]
    assert "This one needs a second look" in recorder.sent[0].text


def test_a_mention_mails_the_mentioned_member(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """A mention is the strongest signal the contract sends, so it mails too."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Named", assignee_id=OWNER)
    comment_id = "01JB0000000000000000000C2"
    put_comment(repositories, workspace, issue["id"], comment_id, author_id=OWNER, body="over to you")

    handle_record(
        repositories,
        _record(
            COMMENTS_ARN,
            "INSERT",
            new=_image(
                workspace_id=workspace,
                issue_id=issue["id"],
                comment_id=comment_id,
                author_id=OWNER,
                team_id=TEAM,
                body="over to you",
                mentions=[MEMBER],
            ),
        ),
    )

    assert [item.to for item in recorder.sent] == ["member@example.com"]
    assert "mentioned you in a comment" in recorder.sent[0].text


def test_the_arn_still_has_to_name_a_known_table(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """An unrecognised source writes nothing, so it mails nothing."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Elsewhere", assignee_id=MEMBER)
    other = f"arn:aws:dynamodb:us-west-2:1234:table/{table_name('views', settings.dynamodb_table_prefix)}/stream/x"

    handle_record(
        repositories,
        _record(
            other,
            "MODIFY",
            new=_image(workspace_id=workspace, issue_id=issue["id"], assignee_id=MEMBER, updated_by=OWNER),
        ),
    )

    assert recorder.sent == []
