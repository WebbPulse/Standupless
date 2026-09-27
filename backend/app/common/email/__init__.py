"""Outbound product email: the sender seam, the recipient gate and delivery.

The sender itself is `webbpulse.identity.email`, which is already generic in the
address and configuration set it takes, so nothing about SES is restated here.
What lives here is the two decisions the package cannot make for a product: which
addresses this environment is still allowed to reach while the account sits in the
SES sandbox, and that a refused send never fails the caller.
"""

from app.common.email.delivery import deliver, email_sender, reset_email_sender
from app.common.email.gate import RecipientBlocked, allowed_recipient

__all__ = [
    "RecipientBlocked",
    "allowed_recipient",
    "deliver",
    "email_sender",
    "reset_email_sender",
]
