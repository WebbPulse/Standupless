"""Rendering the workspace deletion email, and the invite email defined in `app.common.email.invite`."""

from __future__ import annotations

from datetime import datetime
from urllib.parse import quote

from webbpulse.email_layout import Button, Heading, Paragraph, Strong
from webbpulse.identity.email import EmailMessage

from app.common.core.config import settings
from app.common.email.brand import render
from app.common.email.invite import accept_url, render_invite

__all__ = ["accept_url", "render_invite", "render_workspace_deletion", "settings_url"]


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
    accent: str | None = None,
) -> EmailMessage:
    """Render the notice sent to a workspace's owners and admins when its deletion is scheduled or cancelled.

    The scheduled notice names the date the purge runs and says it can be cancelled
    until then, so an admin who did not ask for it has the whole grace period to act.
    """
    workspace = workspace_name.strip() or "a workspace"
    actor = actor_name.strip() or "A workspace admin"
    product = settings.PROJECT_NAME
    if cancelled:
        subject = f"Deletion of {workspace} was cancelled"
        heading = "Workspace deletion cancelled"
        action = "cancelled the scheduled deletion of"
        details = [Paragraph("Nothing will be deleted. The workspace stays as it is.")]
    else:
        subject = f"{workspace} is scheduled for deletion"
        heading = "Workspace scheduled for deletion"
        action = "scheduled the deletion of"
        when = purge_after.strftime("%d %B %Y") if purge_after is not None else "the end of the grace period"
        details = [
            Paragraph(
                "Everything in it, including teams, issues, comments, attachments, views, share links, "
                "API keys and the GitHub connection, will be permanently deleted on ",
                Strong(when),
                ".",
            ),
            Paragraph("Any owner or admin can cancel the deletion from workspace settings until then."),
        ]
    return render(
        to=to,
        subject=subject,
        preheader=f"{actor} {action} {workspace}.",
        blocks=[
            Heading(heading),
            Paragraph(f"{actor} {action} the ", Strong(workspace), f" workspace on {product}."),
            *details,
            Button("Open workspace settings", settings_url(slug)),
        ],
        footer_note="You are receiving this because you are an owner or admin of this workspace.",
        tags={"purpose": "workspace_deletion_cancelled" if cancelled else "workspace_deletion_scheduled"},
        accent=accent,
    )
