"""Rendering the workspace invite email.

The link carries the token the create response also returns, so the copy-link flow
and the mailed link are the same invite and redeeming either one consumes it. The
token is in the URL because that is what the SPA's accept page reads, and the
invite row stores only its hash, so this render is the one place it is readable
alongside the address it was minted for. Shared by the invite route and the MCP
invite tool, so both send the same message.
"""

from __future__ import annotations

from datetime import datetime
from urllib.parse import quote

from webbpulse.email_layout import Button, Heading, Paragraph, Strong
from webbpulse.identity.email import EmailMessage

from app.common.core.config import settings
from app.common.email.brand import render


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
    accent: str | None = None,
) -> EmailMessage:
    """Render the invite message for one address.

    `inviter_name` falls back to a neutral phrase rather than an id, because the
    admin who sent it may have no display name and an id in an email says nothing
    to the person reading it. `accent` is the workspace's own colour when it has one.
    """
    workspace = workspace_name.strip() or "a workspace"
    inviter = inviter_name.strip() or "A workspace admin"
    product = settings.PROJECT_NAME
    return render(
        to=to,
        subject=f"You are invited to {workspace} on {product}",
        preheader=f"{inviter} invited you to join {workspace} as a {role}.",
        blocks=[
            Heading(f"Join {workspace} on {product}"),
            Paragraph(f"{inviter} invited you to the ", Strong(workspace), f" workspace on {product} as a {role}."),
            Button("Accept the invite", accept_url(token), show_url=True),
            Paragraph(f"The invite expires on {expires_at.strftime('%d %B %Y')}."),
            Paragraph(
                "If you were not expecting this, you can ignore this message. Nothing is created until you accept.",
                muted=True,
            ),
        ],
        tags={"purpose": "workspace_invite"},
        accent=accent,
    )
