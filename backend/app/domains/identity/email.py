"""Rendering the account deletion notice.

Sent to the account's own address once it has been deleted, so a deletion someone
else started from a signed in browser is noticed and can be reported.
"""

from __future__ import annotations

from webbpulse.email_layout import BulletList, Button, Heading, ListItem, Paragraph
from webbpulse.identity.email import EmailMessage

from app.common.core.config import settings
from app.common.email.brand import render


def contact_url() -> str:
    """The SPA page that names the address to write to about an account."""
    return f"{settings.frontend_base_url}/privacy"


def render_account_deletion(*, to: str, workspaces_deleted: list[str]) -> EmailMessage:
    """Render the notice for a deleted account.

    Names every workspace that went with the account because nobody else was in it,
    since those are the surprising part. Always in the brand orange: the account
    belongs to no single workspace.
    """
    product = settings.PROJECT_NAME
    blocks = [
        Heading(f"Your {product} account was deleted"),
        Paragraph(
            "You have been signed out everywhere, and your profile, sign in methods, API keys, connected apps, "
            "personal views and notifications are being deleted now. You have been removed from every workspace."
        ),
        Paragraph("Issues and comments you wrote stay in their workspaces and show as written by a deleted user."),
    ]
    if workspaces_deleted:
        blocks.append(Paragraph("These workspaces had no other members and are being deleted with it:"))
        blocks.append(BulletList(tuple(ListItem(name) for name in workspaces_deleted)))
    blocks.append(Paragraph("If you did not ask for this, contact us straight away."))
    blocks.append(Button("Contact us", contact_url()))
    return render(
        to=to,
        subject=f"Your {product} account was deleted",
        preheader="You have been signed out everywhere and removed from every workspace.",
        blocks=blocks,
        tags={"purpose": "account_deleted"},
    )
