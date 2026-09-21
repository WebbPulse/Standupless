"""The recipient gate and the delivery swallow.

Two properties carry this module. An address this environment cannot reach is
dropped before SES is called, and nothing `deliver` can meet ever raises, because
every caller has already done its real work by the time a message is rendered.
"""

from __future__ import annotations

import logging
from typing import Iterator

import pytest
from webbpulse.identity.email import EmailMessage, RecordingEmailSender

from app.common.core.config import settings
from app.common.email import allowed_recipient, deliver, reset_email_sender


@pytest.fixture
def recorder() -> Iterator[RecordingEmailSender]:
    """A recording sender installed as the process-wide one for one test."""
    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


@pytest.fixture
def verified(monkeypatch: pytest.MonkeyPatch) -> None:
    """Restrict this environment to one verified address, as the sandbox does."""
    monkeypatch.setattr(settings, "EMAIL_VERIFIED_RECIPIENTS", "allowed@example.com")


def message(to: str = "allowed@example.com") -> EmailMessage:
    """One trivial message addressed wherever the test needs it."""
    return EmailMessage(to=to, subject="Subject", text="Text", html="<p>Text</p>")


def test_an_empty_list_admits_every_address() -> None:
    """Unrestricted is the production state, so it needs no code change to reach."""
    assert settings.EMAIL_VERIFIED_RECIPIENTS == ""
    assert allowed_recipient("anyone@example.com") is True


def test_only_a_verified_address_is_admitted(verified: None) -> None:
    """In the sandbox the list is the whole set of reachable mailboxes."""
    assert allowed_recipient("allowed@example.com") is True
    assert allowed_recipient("ALLOWED@Example.com") is True
    assert allowed_recipient("someone@example.com") is False
    assert allowed_recipient("") is False


def test_a_blocked_recipient_is_never_sent_to(
    recorder: RecordingEmailSender, verified: None, caplog: pytest.LogCaptureFixture
) -> None:
    """The send is skipped, the reason is logged, and the caller is told nothing went."""
    with caplog.at_level(logging.INFO):
        sent = deliver(message("someone@example.com"), event="tests.email")

    assert sent is False
    assert recorder.sent == []
    record = next(item for item in caplog.records if getattr(item, "event", "") == "tests.email")
    assert record.reason == "recipient_not_verified"


def test_a_blocked_recipient_is_not_named_in_the_log(
    recorder: RecordingEmailSender, verified: None, caplog: pytest.LogCaptureFixture
) -> None:
    """A skipped send is attributable without a mailbox landing in the logs."""
    with caplog.at_level(logging.INFO):
        deliver(message("someone@example.com"), event="tests.email")

    assert "someone@example.com" not in caplog.text


def test_a_verified_recipient_is_sent_to(recorder: RecordingEmailSender, verified: None) -> None:
    """The gate is a filter, not a switch: an admitted address still goes."""
    assert deliver(message(), event="tests.email") is True
    assert [item.to for item in recorder.sent] == ["allowed@example.com"]


def test_a_refused_send_is_swallowed(caplog: pytest.LogCaptureFixture) -> None:
    """SES being down answers false rather than raising into the caller."""
    reset_email_sender(RecordingEmailSender(fail=True))
    try:
        with caplog.at_level(logging.INFO):
            sent = deliver(message(), event="tests.email")
    finally:
        reset_email_sender(None)

    assert sent is False
    record = next(item for item in caplog.records if getattr(item, "event", "") == "tests.email")
    assert record.reason == "send_failed"


def test_no_configured_sender_sends_nothing() -> None:
    """A local run and the test suite have no SES identity, which is not an error."""
    reset_email_sender(None)
    assert deliver(message(), event="tests.email") is False
