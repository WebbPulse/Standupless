"""Rendering the workspace invite and workspace deletion emails.

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


_DELETION_TEXT = Template(
    """$actor $action the $workspace_name workspace on $product_name.

$detail

$link
"""
)

_DELETION_DOCUMENT = Template(
    """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>$subject</title></head>
<body style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; \
font-size: 15px; line-height: 1.5; color: #1a1a1a;">
<p>$actor $action the <strong>$workspace_name</strong> workspace on $product_name.</p>
<p>$detail</p>
<p><a href="$link">Open workspace settings</a></p>
</body>
</html>
"""
)


def settings_url(slug: str) -> str:
    """The SPA link to one workspace's settings, where a deletion is cancelled."""
    return f"{settings.frontend_base_url}/w/{quote(slug, safe='')}/settings"


def render_workspace_deletion(
    *,
    to: str,
    workspace_name: str,
    slug: str,
    actor_name: str,
    purge_after: datetime | None,
    cancelled: bool = False,
) -> EmailMessage:
    """Render the notice sent to a workspace's owners and admins when its deletion is scheduled or cancelled.

    The scheduled notice names the date the purge runs and says it can be cancelled
    until then, so an admin who did not ask for it has the whole grace period to act.
    """
    workspace = workspace_name.strip() or "a workspace"
    actor = actor_name.strip() or "A workspace admin"
    if cancelled:
        subject = f"Deletion of {workspace} was cancelled"
        action = "cancelled the scheduled deletion of"
        detail = "Nothing will be deleted. The workspace stays as it is."
    else:
        subject = f"{workspace} is scheduled for deletion"
        action = "scheduled the deletion of"
        when = purge_after.strftime("%d %B %Y") if purge_after is not None else "the end of the grace period"
        detail = (
            f"Everything in it, including teams, issues, comments, attachments, views, share links, "
            f"API keys and the GitHub connection, will be permanently deleted on {when}. "
            "Any owner or admin can cancel the deletion from workspace settings until then."
        )
    values = {
        "subject": subject,
        "actor": actor,
        "action": action,
        "workspace_name": workspace,
        "product_name": settings.PROJECT_NAME,
        "detail": detail,
        "link": settings_url(slug),
    }
    escaped = {key: html.escape(value, quote=True) for key, value in values.items()}
    return EmailMessage(
        to=to,
        subject=subject,
        text=_DELETION_TEXT.substitute(values),
        html=_DELETION_DOCUMENT.substitute(escaped),
        tags={"purpose": "workspace_deletion_cancelled" if cancelled else "workspace_deletion_scheduled"},
    )
