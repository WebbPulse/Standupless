"""Rendering the account deletion notice.

Sent to the account's own address when its deletion is scheduled or cancelled, so
a deletion someone else started from a signed in browser is noticed while it can
still be undone.
"""

from __future__ import annotations

import html
from datetime import datetime
from string import Template

from webbpulse.identity.email import EmailMessage

from app.common.core.config import settings

_TEXT = Template(
    """$headline

$detail

$link
"""
)

_DOCUMENT = Template(
    """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>$subject</title></head>
<body style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; \
font-size: 15px; line-height: 1.5; color: #1a1a1a;">
<p>$headline</p>
<p>$detail</p>
<p><a href="$link">Open account security</a></p>
</body>
</html>
"""
)


def security_url() -> str:
    """The SPA page an account deletion is scheduled and cancelled from."""
    return f"{settings.frontend_base_url}/security"


def render_account_deletion(
    *,
    to: str,
    purge_after: datetime | None,
    workspaces_deleted: list[str],
    cancelled: bool = False,
) -> EmailMessage:
    """Render the notice for a scheduled or cancelled account deletion.

    The scheduled notice names the date and every workspace that goes with the
    account because nobody else is in it, since those are the surprising part.
    """
    product = settings.PROJECT_NAME
    if cancelled:
        subject = f"Your {product} account deletion was cancelled"
        headline = f"The scheduled deletion of your {product} account was cancelled."
        detail = "Nothing will be deleted. Your account stays as it is."
    else:
        subject = f"Your {product} account is scheduled for deletion"
        when = purge_after.strftime("%d %B %Y") if purge_after is not None else "the end of the grace period"
        headline = f"Your {product} account is scheduled for permanent deletion on {when}."
        detail = (
            "Your profile, sign in methods, API keys, personal views and notifications will be deleted, "
            "and you will be removed from every workspace. Issues and comments you wrote stay in their "
            "workspaces and show as written by a deleted user."
        )
        if workspaces_deleted:
            detail += " These workspaces have no other members and will be deleted with it: " + ", ".join(
                workspaces_deleted
            )
            detail += "."
        detail += " Sign in and cancel from account security before then if you did not ask for this."
    values = {"subject": subject, "headline": headline, "detail": detail, "link": security_url()}
    escaped = {key: html.escape(value, quote=True) for key, value in values.items()}
    return EmailMessage(
        to=to,
        subject=subject,
        text=_TEXT.substitute(values),
        html=_DOCUMENT.substitute(escaped),
        tags={"purpose": "account_deletion_cancelled" if cancelled else "account_deletion_scheduled"},
    )
