"""Notification email through the real SES v2 sender, against moto.

The recorder tests beside this one prove which rows mail and which do not. These
prove the same outcomes end to end through `SesV2EmailSender` and a moto SES
backend: the message lands in SES, the sandbox gate keeps an unverified address
out of the call entirely, the preference keeps the recipient out of it too, and a
refusal from SES itself leaves the inbox row standing and the record succeeding.
"""

from __future__ import annotations

from typing import Any, Iterator

import boto3
import pytest
from fastapi.testclient import TestClient
from moto.core import DEFAULT_ACCOUNT_ID
from moto.ses import ses_backends

from app.common.core.config import settings
from app.common.email import email_sender, reset_email_sender
from app.domains.views.consumers.notify import handle_record
from tests.domains.helpers import MEMBER, OWNER, sign_in
from tests.domains.views.conftest import seed_issue
from tests.domains.views.test_notify_consumer import inbox_of
from tests.domains.views.test_notify_email import assignment

REGION = "us-west-2"

SENDER = "no-reply@standupless.example"

CONFIGURATION_SET = "standupless-transactional"


def sent_messages() -> list[Any]:
    """Every message moto's SES backend accepted in this test."""
    return list(ses_backends[DEFAULT_ACCOUNT_ID][REGION].sent_messages)


def rejected_count() -> int:
    """How many sends moto's SES backend refused in this test."""
    return int(ses_backends[DEFAULT_ACCOUNT_ID][REGION].rejected_messages_count)


@pytest.fixture
def ses(repositories: Any, monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    """A moto SES v2 client and the process-wide sender resolved from settings.

    Rides the mock the `repositories` fixture already opened, so the table writes
    and the send share one fake account. The sender is left for `email_sender` to
    build from settings, which is the path a deployed function takes.
    """
    monkeypatch.setattr(settings, "EMAIL_ENABLED", True)
    monkeypatch.setattr(settings, "EMAIL_FROM", SENDER)
    monkeypatch.setattr(settings, "SES_CONFIGURATION_SET", CONFIGURATION_SET)
    monkeypatch.setattr(settings, "AWS_REGION", REGION)
    client = boto3.client("sesv2", region_name=REGION)
    client.create_configuration_set(ConfigurationSetName=CONFIGURATION_SET)
    reset_email_sender(None)
    yield client
    reset_email_sender(None)


@pytest.fixture
def verified_sender(ses: Any) -> None:
    """The sending identity verified, as terraform leaves it in every environment."""
    ses.create_email_identity(EmailIdentity=SENDER)


def test_an_assignment_is_sent_through_ses(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, verified_sender: None
) -> None:
    """The row is written and the same event reaches SES addressed to the assignee."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Ship it", assignee_id=MEMBER)

    handle_record(repositories, assignment(workspace, issue["id"]))

    assert email_sender() is not None
    assert len(inbox_of(repositories, workspace, MEMBER)) == 1
    [message] = sent_messages()
    assert message.source == SENDER
    assert message.destinations["ToAddresses"] == ["member@example.com"]
    assert message.subject == f"[{issue['key']}] Ship it"
    assert f"/w/acme/issues/{issue['key']}" in message.body


def test_an_unverified_recipient_is_skipped_before_ses(
    issues_client: TestClient,
    workspace: str,
    repositories: Any,
    statuses: Any,
    verified_sender: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """In the sandbox an address off the list never reaches SES, so it costs no refusal."""
    monkeypatch.setattr(settings, "EMAIL_VERIFIED_RECIPIENTS", "owner@example.com")
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Sandboxed", assignee_id=MEMBER)

    handle_record(repositories, assignment(workspace, issue["id"]))

    assert len(inbox_of(repositories, workspace, MEMBER)) == 1
    assert sent_messages() == []
    assert rejected_count() == 0


def test_the_preference_off_sends_nothing_to_ses(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, verified_sender: None
) -> None:
    """Email off is email off. The inbox row, which is primary, is still written."""
    repositories.users.update(MEMBER, email_notifications=False)
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Muted", assignee_id=MEMBER)

    handle_record(repositories, assignment(workspace, issue["id"]))

    assert len(inbox_of(repositories, workspace, MEMBER)) == 1
    assert sent_messages() == []


def test_a_refusal_from_ses_is_logged_and_the_record_succeeds(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, ses: Any
) -> None:
    """An unverified sender is refused by SES itself, and that never fails the record."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Refused", assignee_id=MEMBER)

    handle_record(repositories, assignment(workspace, issue["id"]))

    assert len(inbox_of(repositories, workspace, MEMBER)) == 1
    assert sent_messages() == []
    assert rejected_count() == 1
