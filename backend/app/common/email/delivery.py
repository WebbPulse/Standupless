"""Building the sender once per process, and sending without ever raising.

`deliver` is the only entry point the product uses. It swallows every refusal,
because no email this product sends is the thing the caller is doing: an inbox row
is already written and an invite is already stored by the time a message is
rendered, and failing either of those on an SES outage would turn a delivery
problem into a retry storm on a stream shard.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Optional

from webbpulse.identity.email import EmailMessage, EmailSender, EmailSendFailed, SesV2EmailSender

from app.common.core.config import settings
from app.common.email.gate import RecipientBlocked, check_recipient

_log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class ReplyableEmail(EmailMessage):
    """A rendered message that names where a reply should go.

    `reply_to` is empty for every message nobody should answer, which keeps it
    sent exactly as a plain `EmailMessage` is.
    """

    reply_to: str = ""


def with_reply_to(message: EmailMessage, reply_to: str) -> EmailMessage:
    """The same message with a reply address, or the message itself when there is none."""
    if not reply_to:
        return message
    return ReplyableEmail(
        to=message.to,
        subject=message.subject,
        text=message.text,
        html=message.html,
        tags=dict(message.tags),
        headers=dict(message.headers),
        reply_to=reply_to,
    )


class _ReplyToClient:
    """An SES v2 client view that adds one Reply-To address to every send."""

    def __init__(self, client: Any, reply_to: str) -> None:
        """Wrap a client for one message."""
        self._client = client
        self._reply_to = reply_to

    def send_email(self, **kwargs: Any) -> Any:
        """Forward the send with the reply address set."""
        return self._client.send_email(**kwargs, ReplyToAddresses=[self._reply_to])


class ReplyToSesSender(SesV2EmailSender):
    """`SesV2EmailSender` that honours a `ReplyableEmail`'s reply address."""

    def __init__(self, client: Any, *, from_address: str, configuration_set: str | None = None) -> None:
        """Keep what a per-message sender needs alongside the package sender's own state."""
        super().__init__(client, from_address=from_address, configuration_set=configuration_set)
        self._raw_client = client
        self._from_address = from_address
        self._configuration = configuration_set

    def send(self, message: EmailMessage) -> str:
        """Send one message, with a Reply-To header when the message names one."""
        reply_to = getattr(message, "reply_to", "")
        if not reply_to:
            return super().send(message)
        return SesV2EmailSender(
            _ReplyToClient(self._raw_client, reply_to),
            from_address=self._from_address,
            configuration_set=self._configuration,
        ).send(message)


_sender: Optional[EmailSender] = None

_resolved = False


def email_sender() -> EmailSender | None:
    """The process-wide sender, or `None` when this environment sends no mail.

    Built on first use rather than at import, so a function with no SES grant and
    no from address never constructs a client. `None` is an ordinary state: local
    runs and the test suite have no SES identity.
    """
    global _sender, _resolved
    if _resolved:
        return _sender

    _resolved = True
    if not settings.EMAIL_ENABLED or not settings.EMAIL_FROM:
        _sender = None
        return None

    import boto3

    _sender = ReplyToSesSender(
        boto3.client("sesv2", region_name=settings.AWS_REGION or None),
        from_address=settings.EMAIL_FROM,
        configuration_set=settings.SES_CONFIGURATION_SET or None,
    )
    return _sender


def reset_email_sender(sender: EmailSender | None = None) -> None:
    """Replace the process-wide sender, which is how a test injects a recorder.

    Passing `None` puts it back to being resolved from settings on next use.
    """
    global _sender, _resolved
    _sender = sender
    _resolved = sender is not None


def deliver(message: EmailMessage, *, event: str) -> bool:
    """Send one message, answering whether it went, and never raising.

    Three outcomes are all ordinary and all logged at info: no sender configured,
    a recipient this environment may not reach, and a provider refusal. The caller
    has already done its real work, so none of them is an error it can act on.
    """
    sender = email_sender()
    if sender is None:
        return False

    try:
        check_recipient(message.to, event=event)
    except RecipientBlocked:
        return False

    try:
        sender.send(message)
    except EmailSendFailed as exc:
        _log.info(
            "An email was not delivered.",
            extra={"event": event, "reason": "send_failed", "error_code": _error_code(exc)},
        )
        return False
    return True


def _error_code(exc: EmailSendFailed) -> str:
    """The provider's error code behind a refusal, never its message.

    SES messages can quote the recipient address, so only the `ClientError` code,
    or the underlying exception's type name, reaches the log.
    """
    cause = exc.__cause__
    response = getattr(cause, "response", None)
    if isinstance(response, dict):
        error = response.get("Error")
        if isinstance(error, dict) and error.get("Code"):
            return str(error["Code"])
    return type(cause).__name__ if cause is not None else type(exc).__name__
