"""The recipient gate: which addresses this environment may still mail.

The account is in the SES sandbox, so a send to an unverified address is refused
at the API and costs a retry. Rather than learning that from SES one bounce at a
time, the allowed addresses are named in a setting fed from the same terraform
variable that verifies them, and anything else is dropped before the call.

An empty setting means unrestricted. That is what makes SES production access a
terraform change rather than a code change: the list is emptied and every address
passes.
"""

from __future__ import annotations

import logging

from app.common.core.config import settings

_log = logging.getLogger(__name__)


class RecipientBlocked(Exception):
    """This environment may not mail that address.

    Raised rather than returned so a caller that forgets to check still does not
    send, and caught by `deliver`, which is the only place it is ever meaningful.
    """


def allowed_recipient(address: str) -> bool:
    """Whether SES in this environment will accept mail for `address`.

    Compared lowercased, because a verified identity is case insensitive in
    practice while the address on a user row is stored as it was typed.
    """
    candidate = address.strip().lower()
    if not candidate:
        return False
    allowed = settings.email_verified_recipients
    if not allowed:
        return True
    return candidate in allowed


def check_recipient(address: str, *, event: str) -> None:
    """Raise `RecipientBlocked` unless this environment may mail `address`.

    The log line names the event rather than the address, so a skipped send is
    attributable in an environment's logs without writing a mailbox into them.
    """
    if allowed_recipient(address):
        return
    _log.info(
        "Skipped an email to an address this environment cannot reach.",
        extra={
            "event": event,
            "reason": "recipient_not_verified",
            "domain": address.strip().lower().partition("@")[2],
        },
    )
    raise RecipientBlocked(address)
