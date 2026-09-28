"""Rendering the workspace deletion email, and the invite email defined in `app.common.email.invite`."""

from __future__ import annotations

import html
from datetime import datetime
from string import Template
from urllib.parse import quote

from webbpulse.identity.email import EmailMessage

from app.common.core.config import settings
from app.common.email.invite import accept_url, render_invite

__all__ = ["accept_url", "render_invite", "render_workspace_deletion", "settings_url"]

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
