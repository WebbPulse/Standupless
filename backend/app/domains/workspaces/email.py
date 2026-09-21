"""Rendering the workspace invite email.

The link carries the token the create response also returns, so the copy-link flow
and the mailed link are the same invite and redeeming either one consumes it. The
token is in the URL because that is what the SPA's accept page reads, and the
invite row stores only its hash, so this render is the one place it is readable
alongside the address it was minted for.
"""

from __future__ import annotations

import html
from datetime import datetime
from string import Template
from urllib.parse import quote

from webbpulse.identity.email import EmailMessage

from app.common.core.config import settings

_TEXT = Template(
    """$inviter invited you to the $workspace_name workspace on $product_name as a $role.

Open the link below to accept:

$link

The invite expires on $expires.

If you were not expecting this, you can ignore this message. Nothing is created
until you accept.
"""
)

_DOCUMENT = Template(
    """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>$subject</title></head>
<body style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; \
font-size: 15px; line-height: 1.5; color: #1a1a1a;">
<p>$inviter invited you to the <strong>$workspace_name</strong> workspace on \
$product_name as a $role.</p>
<p><a href="$link">Accept the invite</a></p>
<p>The invite expires on $expires.</p>
<p>If you were not expecting this, you can ignore this message. Nothing is created \
until you accept.</p>
</body>
</html>
"""
)


def accept_url(token: str) -> str:
    """The SPA link that redeems one invite token."""
    return f"{settings.frontend_base_url}/invites/accept?token={quote(token, safe='')}"


def render_invite(
    *,
    to: str,
    token: str,
    workspace_name: str,
    role: str,
    inviter_name: str,
    expires_at: datetime,
) -> EmailMessage:
    """Render the invite message for one address.

    `inviter_name` falls back to a neutral phrase rather than an id, because the
    admin who sent it may have no display name and an id in an email says nothing
    to the person reading it.
    """
    workspace = workspace_name.strip() or "a workspace"
    inviter = inviter_name.strip() or "A workspace admin"
    subject = f"You are invited to {workspace} on {settings.PROJECT_NAME}"

    values = {
        "subject": subject,
        "inviter": inviter,
        "workspace_name": workspace,
        "product_name": settings.PROJECT_NAME,
        "role": role,
        "link": accept_url(token),
        "expires": expires_at.strftime("%d %B %Y"),
    }
    escaped = {key: html.escape(value, quote=True) for key, value in values.items()}

    return EmailMessage(
        to=to,
        subject=subject,
        text=_TEXT.substitute(values),
        html=_DOCUMENT.substitute(escaped),
        tags={"purpose": "workspace_invite"},
    )
