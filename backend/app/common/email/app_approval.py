"""Rendering the emails a third-party app approval sends: the request to admins and the decision to the requester.

Both link to the workspace's connected apps settings, where an admin decides and a
member sees what was decided, so neither email carries anything a forwarded copy
could act on.
"""

from __future__ import annotations

from webbpulse.email_layout import Button, EmailBlock, Heading, Paragraph, Strong
from webbpulse.identity.email import EmailMessage

from app.common.core.config import settings
from app.common.email.brand import render


def render_app_approval_requested(
    *,
    to: str,
    workspace_name: str,
    app_name: str,
    requester_name: str,
    reason: str,
    url: str,
    accent: str | None = None,
) -> EmailMessage:
    """The message telling an admin a member asked to connect a third-party app."""
    workspace = workspace_name.strip() or "your workspace"
    requester = requester_name.strip() or "A member"
    app = app_name.strip() or "a third-party app"
    blocks: list[EmailBlock] = [
        Heading(f"{app} is waiting for approval"),
        Paragraph(f"{requester} asked to connect ", Strong(app), f" to {workspace} on {settings.PROJECT_NAME}."),
    ]
    if reason.strip():
        blocks.append(Paragraph("Their reason: ", Strong(reason.strip())))
    blocks.extend(
        [
            Button("Review the request", url, show_url=True),
            Paragraph("Nothing is connected until an admin approves the app.", muted=True),
        ]
    )
    return render(
        to=to,
        subject=f"{requester} requested access to {app}",
        preheader=f"{requester} asked to connect {app} to {workspace}.",
        blocks=blocks,
        tags={"purpose": "app_approval_requested"},
        accent=accent,
    )


def render_app_approval_decided(
    *,
    to: str,
    workspace_name: str,
    app_name: str,
    decider_name: str,
    approved: bool,
    reason: str,
    url: str,
    accent: str | None = None,
) -> EmailMessage:
    """The message telling a member whether the app they asked for was approved."""
    workspace = workspace_name.strip() or "your workspace"
    decider = decider_name.strip() or "An admin"
    app = app_name.strip() or "the app you requested"
    verb = "approved" if approved else "denied"
    blocks: list[EmailBlock] = [
        Heading(f"{app} was {verb}"),
        Paragraph(f"{decider} {verb} your request to connect ", Strong(app), f" to {workspace}."),
    ]
    if reason.strip():
        blocks.append(Paragraph("Their reason: ", Strong(reason.strip())))
    blocks.append(
        Paragraph("You can authorize the app again now." if approved else "You can send a new request at any time.")
    )
    blocks.append(Button("Open connected apps", url, show_url=True))
    return render(
        to=to,
        subject=f"{app} was {verb} in {workspace}",
        preheader=f"{decider} {verb} your request to connect {app}.",
        blocks=blocks,
        tags={"purpose": "app_approval_decided"},
        accent=accent,
    )
