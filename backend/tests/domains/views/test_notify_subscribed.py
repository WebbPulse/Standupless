"""Being subscribed by a teammate: the person added hears who added them.

The issues route writes the subscription with `added_by`, and each test hands the
notify consumer the stream record that insert produces. A row someone made for
themselves, or an automatic one, carries no `added_by` and notifies nobody.
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
from tests.domains.helpers import ADMIN, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import seed_issue
from tests.domains.views.test_notify_consumer import _image, _record, flush_digests, inbox_of

SUBSCRIPTIONS_ARN = (
    f"arn:aws:dynamodb:us-west-2:1234:table/{table_name('subscriptions', settings.dynamodb_table_prefix)}/stream/x"
)


@pytest.fixture
def recorder() -> Iterator[RecordingEmailSender]:
    """A recording sender installed as the process-wide one for one test."""
    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


def insert_record(repositories: Any, workspace: str, issue_id: str, user_id: str) -> "dict[str, Any]":
    """The stream record the stored subscription's insert produces."""
    row = repositories.subscriptions.get(workspace, issue_id, user_id)
    assert row is not None
    return _record(
        SUBSCRIPTIONS_ARN,
        "INSERT",
        new=_image(
            ws_issue=row.ws_issue,
            user_id=row.user_id,
            workspace_id=row.workspace_id,
            issue_id=row.issue_id,
            team_id=row.team_id,
            reason=row.reason,
            added_by=row.added_by,
            created_at=row.created_at.isoformat(),
        ),
    )


def test_a_teammate_subscribing_you_notifies_and_names_them(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """The inbox row and the email both say who did it, and a replay writes nothing more."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Followed for you")
    response = issues_client.put(f"/api/workspaces/{workspace}/issues/{issue['id']}/subscribers/{MEMBER}")
    assert response.status_code == 200, response.text

    record = insert_record(repositories, workspace, issue["id"], MEMBER)
    handle_record(repositories, record)
    handle_record(repositories, record)
    flush_digests(repositories)

    rows = inbox_of(repositories, workspace, MEMBER)
    assert [row["kind"] for row in rows] == ["subscribed"]
    assert rows[0]["actor_id"] == OWNER
    assert rows[0]["actor_name"] == "Olive Owner"
    assert inbox_of(repositories, workspace, OWNER) == []
    assert [item.to for item in recorder.sent] == ["member@example.com"]
    assert "Olive Owner subscribed you to this issue" in recorder.sent[0].text


def test_subscribing_yourself_notifies_nobody(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A row without `added_by` is skipped even if the filter let it through."""
    sign_in(issues_client, ADMIN)
    issue = seed_issue(issues_client, workspace, title="Self")
    issues_client.put(f"/api/workspaces/{workspace}/issues/{issue['id']}/subscribers/me")
    sign_in(issues_client, MEMBER)
    issues_client.put(f"/api/workspaces/{workspace}/issues/{issue['id']}/subscribers/me")

    handle_record(repositories, insert_record(repositories, workspace, issue["id"], MEMBER))
    flush_digests(repositories)

    assert inbox_of(repositories, workspace, MEMBER) == []


def test_the_subscribed_kind_honours_the_recipients_preferences(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """Turning the kind off on both channels leaves no trace."""
    repositories.users.update(MEMBER, notification_preferences={"subscribed": {"in_app": False, "email": False}})
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Muted")
    issues_client.put(f"/api/workspaces/{workspace}/issues/{issue['id']}/subscribers/{MEMBER}")

    handle_record(repositories, insert_record(repositories, workspace, issue["id"], MEMBER))
    flush_digests(repositories)

    assert inbox_of(repositories, workspace, MEMBER) == []
    assert recorder.sent == []
