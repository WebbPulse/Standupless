"""Building the sender once per process, and sending without ever raising.

`deliver` is the only entry point the product uses. It swallows every refusal,
because no email this product sends is the thing the caller is doing: an inbox row
is already written and an invite is already stored by the time a message is
rendered, and failing either of those on an SES outage would turn a delivery
problem into a retry storm on a stream shard.
"""

from __future__ import annotations

import logging
from typing import Optional

from webbpulse.identity.email import EmailMessage, EmailSender, EmailSendFailed, SesV2EmailSender

from app.common.core.config import settings
from app.common.email.gate import RecipientBlocked, check_recipient

_log = logging.getLogger(__name__)

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

    _sender = SesV2EmailSender(
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
            extra={"event": event, "reason": "send_failed", "detail": str(exc)},
        )
        return False
    return True
