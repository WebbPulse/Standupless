"""The Standupless email brand every outbound message renders through.

The layout itself is `webbpulse.email_layout`, shared with the identity emails, so
what lives here is only what makes it Standupless: the name, the hosted PNG logo,
the brand orange, the app's design tokens as an email theme and the links a footer
carries. The theme is dark first, as the app is: every client shows the dark palette,
whatever its own mode, and the light palette is kept only as the documented token map. Every URL is built from
`settings.frontend_base_url`, so each environment mails links and a logo on its
own domain without any new setting.
"""

from __future__ import annotations

from collections.abc import Sequence
from urllib.parse import quote

from webbpulse.email_layout import EmailBlock, EmailBrand, EmailLink, EmailPalette, EmailTheme, Paragraph
from webbpulse.identity.email import EmailMessage, render_branded

from app.common.core.config import settings

BRAND_ACCENT = "#b8451a"
"""The brand orange, the light theme `--brand-accent` in `frontend/src/brand/tokens.css`."""

BRAND_ACCENT_DARK = "#f2703a"
"""The dark theme `--brand-accent` in `frontend/src/brand/tokens.css`."""

EMAIL_THEME = EmailTheme(
    light=EmailPalette(
        page="#f7f7f8",
        card="#ffffff",
        line="#e5e5ea",
        text="#1b1c20",
        muted="#62646f",
        quote="#f7f7f8",
        quote_text="#62646f",
    ),
    dark=EmailPalette(
        page="#141518",
        card="#1b1c20",
        line="#2a2b31",
        text="#e7e7eb",
        muted="#9b9da7",
        quote="#232429",
        quote_text="#9b9da7",
    ),
    font_stack="Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    mono_stack="ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
    on_accent_light="#ffffff",
    on_accent_dark="#17120f",
    card_radius=8,
    button_radius=6,
    inline_radius=4,
    scheme="dark",
)
"""The app's tokens from `frontend/src/index.css` and `brand/tokens.css`, as email-safe hex.

Page is `--surface`, the card `--bg` in light and `--surface` in dark, borders
`--line`, text `--text` and `--text-muted`, quotes the `--surface` and `--raised`
fills with muted text as the app draws a blockquote, the stacks `--font-sans` and
`--font-mono`, text on the accent `--brand-accent-foreground`, and the radii
`--radius-lg`, `--radius-md` and `--radius-sm`. `scheme` is dark because the app
defaults to dark, so the dark palette and dark accent are what every message draws inline.
"""

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
    a stored colour is user input and a notification should still mail. A workspace
    accent is lightened until links read on the dark card, as the app derives its dark
    accent, and that lightened colour is what the dark-first theme draws.
    """
    base = settings.frontend_base_url
    brand = EmailBrand(
        product_name=settings.PROJECT_NAME,
        logo_url=logo_url(),
        accent_color=BRAND_ACCENT,
        dark_accent_color=BRAND_ACCENT_DARK,
        home_url=base,
        footer_links=(EmailLink("Privacy", f"{base}/privacy"),),
        theme=EMAIL_THEME,
    )
    themed = brand.with_accent(accent)
    if themed is brand:
        return brand
    return brand.with_accent(accent, themed.dark_link_color)


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
