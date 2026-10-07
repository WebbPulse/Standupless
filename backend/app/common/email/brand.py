"""The Standupless email brand every outbound message renders through.

The layout itself is `webbpulse.email_layout`, shared with the identity emails, so
what lives here is only what makes it Standupless: the name, the hosted PNG logo,
the brand orange and the links a footer carries. Every URL is built from
`settings.frontend_base_url`, so each environment mails links and a logo on its
own domain without any new setting.
"""

from __future__ import annotations

from collections.abc import Sequence
from urllib.parse import quote

from webbpulse.email_layout import EmailBlock, EmailBrand, EmailLink, Paragraph
from webbpulse.identity.email import EmailMessage, render_branded

from app.common.core.config import settings

BRAND_ACCENT = "#b8451a"
"""The brand orange, the light theme `--brand-accent` in `frontend/src/brand/tokens.css`."""

LOGO_PATH = "/email-logo.png"
"""Where the frontend serves the email logo, drawn by `frontend/src/brand/generate-email-logo.py`."""


def logo_url() -> str:
    """The absolute URL of the PNG logo for this environment."""
    return f"{settings.frontend_base_url}{LOGO_PATH}"


def notification_settings_url(workspace_slug: str) -> str:
    """The notification settings page of one workspace, or the workspace list when the slug is gone."""
    base = settings.frontend_base_url
    if not workspace_slug:
        return f"{base}/workspaces"
    return f"{base}/w/{quote(workspace_slug, safe='')}/settings/notifications"


def email_brand(accent: str | None = None) -> EmailBrand:
    """The Standupless brand, in a workspace's accent when one is set and valid.

    An unusable accent falls back to the brand orange rather than raising, because
    a stored colour is user input and a notification should still mail.
    """
    base = settings.frontend_base_url
    return EmailBrand(
        product_name=settings.PROJECT_NAME,
        logo_url=logo_url(),
        accent_color=BRAND_ACCENT,
        home_url=base,
        footer_links=(EmailLink("Privacy", f"{base}/privacy"),),
    ).with_accent(accent)


def render(
    *,
    to: str,
    subject: str,
    blocks: Sequence[EmailBlock],
    tags: dict[str, str],
    preheader: str = "",
    footer_note: str = "",
    footer_links: Sequence[EmailLink] = (),
    accent: str | None = None,
) -> EmailMessage:
    """Render one Standupless message in HTML and plain text through the shared shell."""
    return render_branded(
        email_brand(accent),
        to=to,
        subject=subject,
        blocks=blocks,
        preheader=preheader,
        footer_note=Paragraph(footer_note) if footer_note else None,
        footer_links=footer_links,
        tags=tags,
    )
