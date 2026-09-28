"""Rendering the account deletion notice.

Sent to the account's own address once it has been deleted, so a deletion someone
else started from a signed in browser is noticed and can be reported.
"""

from __future__ import annotations

import html
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
<p><a href="$link">Contact us</a></p>
</body>
</html>
"""
)


def contact_url() -> str:
    """The SPA page that names the address to write to about an account."""
    return f"{settings.frontend_base_url}/privacy"


def render_account_deletion(*, to: str, workspaces_deleted: list[str]) -> EmailMessage:
    """Render the notice for a deleted account.

    Names every workspace that went with the account because nobody else was in it,
    since those are the surprising part.
    """
    product = settings.PROJECT_NAME
    subject = f"Your {product} account was deleted"
    headline = f"Your {product} account was deleted."
    detail = (
        "You have been signed out everywhere, and your profile, sign in methods, API keys, connected apps, "
        "personal views and notifications are being deleted now. You have been removed from every workspace. "
        "Issues and comments you wrote stay in their workspaces and show as written by a deleted user."
    )
    if workspaces_deleted:
        detail += " These workspaces had no other members and are being deleted with it: " + ", ".join(
            workspaces_deleted
        )
        detail += "."
    detail += " If you did not ask for this, contact us straight away."
    values = {"subject": subject, "headline": headline, "detail": detail, "link": contact_url()}
    escaped = {key: html.escape(value, quote=True) for key, value in values.items()}
    return EmailMessage(
        to=to,
        subject=subject,
        text=_TEXT.substitute(values),
        html=_DOCUMENT.substitute(escaped),
        tags={"purpose": "account_deleted"},
    )
