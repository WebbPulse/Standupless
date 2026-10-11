"""Tests for the Standupless email brand: the app's tokens as an email theme."""

from __future__ import annotations

import re
from pathlib import Path

from webbpulse.email_layout import Button, Heading, Paragraph, Quote

from app.common.email.brand import BRAND_ACCENT, BRAND_ACCENT_DARK, EMAIL_THEME, email_brand, render

FRONTEND = Path(__file__).resolve().parents[3] / "frontend" / "src"


def _tokens(css: str, selector: str) -> dict[str, str]:
    """The `--name: #hex` tokens declared in the first block opened by `selector`."""
    block = css.split(selector, 1)[1].split("}", 1)[0]
    return dict(re.findall(r"--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;", block))


def _html(accent: str | None = None) -> str:
    """One message with every block kind the senders use, rendered in a workspace accent."""
    return render(
        to="member@example.com",
        subject="Hello",
        blocks=[Heading("Hi"), Paragraph("Body"), Quote("Quoted"), Button("Open", "https://x.example/open")],
        tags={"purpose": "test"},
        footer_note="Why you got this.",
        accent=accent,
    ).html


def test_the_email_theme_matches_the_frontend_tokens() -> None:
    """The palette is the app's own, so a token change in the frontend fails here until the email follows."""
    index = (FRONTEND / "index.css").read_text()
    brand = (FRONTEND / "brand" / "tokens.css").read_text()
    light = _tokens(index, ":root {")
    dark = _tokens(index, ":root[data-theme='dark'] {")
    brand_light = _tokens(brand, ":root {")
    brand_dark = _tokens(brand, ":root[data-theme='dark'] {")

    assert (EMAIL_THEME.light.page, EMAIL_THEME.light.card) == (light["surface"], light["bg"])
    assert (EMAIL_THEME.light.line, EMAIL_THEME.light.text, EMAIL_THEME.light.muted) == (
        light["line"],
        light["text"],
        light["text-muted"],
    )
    assert (EMAIL_THEME.dark.page, EMAIL_THEME.dark.card, EMAIL_THEME.dark.quote) == (
        dark["bg"],
        dark["surface"],
        dark["raised"],
    )
    assert (EMAIL_THEME.dark.line, EMAIL_THEME.dark.text, EMAIL_THEME.dark.muted) == (
        dark["line"],
        dark["text"],
        dark["text-muted"],
    )
    assert BRAND_ACCENT == brand_light["brand-accent"]
    assert BRAND_ACCENT_DARK == brand_dark["brand-accent"]
    assert EMAIL_THEME.on_accent_light == brand_light["brand-accent-foreground"]
    assert EMAIL_THEME.on_accent_dark == brand_dark["brand-accent-foreground"]


def test_the_default_email_is_dark_first_like_the_app() -> None:
    """Inline styles carry the dark tokens and the dark orange, and the dark rules pin the same values."""
    html = _html()

    assert EMAIL_THEME.scheme == "dark"
    assert "font-family:Inter, ui-sans-serif" in html
    assert f"border:1px solid {EMAIL_THEME.dark.line};border-radius:8px;" in html
    assert f"border-radius:6px;background-color:{BRAND_ACCENT_DARK};" in html
    assert "color:#17120f;text-decoration:none" in html
    assert BRAND_ACCENT not in html
    assert f".wp-bg{{background-color:{EMAIL_THEME.dark.page} !important;}}" in html
    assert f".wp-button{{background-color:{BRAND_ACCENT_DARK} !important;}}" in html
    assert ".wp-button-text{color:#17120f !important;}" in html
    for stale in ("#f4f4f5", "#18181b", "#71717a", "#e4e4e7", "-apple-system, BlinkMacSystemFont"):
        assert stale not in html


def test_a_workspace_accent_is_lightened_for_dark_mode() -> None:
    """A dark workspace accent gets a dark-mode variant that reads on the dark card, as the app derives it."""
    brand = email_brand("#1d4ed8")

    assert brand.accent == "#1d4ed8"
    assert brand.dark_accent not in ("#1d4ed8", BRAND_ACCENT_DARK)
    assert f".wp-button{{background-color:{brand.dark_accent} !important;}}" in _html("#1d4ed8")


def test_an_unusable_accent_keeps_the_brand_orange_in_both_schemes() -> None:
    """A stored value that is not a colour falls back to both brand oranges."""
    brand = email_brand("orange")

    assert (brand.accent, brand.dark_accent) == (BRAND_ACCENT, BRAND_ACCENT_DARK)
