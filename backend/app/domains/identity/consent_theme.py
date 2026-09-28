"""The Standupless brand for the identity package's MCP consent screen.

The package renders the page; this supplies the palette, the mark, Inter and the wording
for this product's five scopes. The colours are the frontend's tokens in
`frontend/src/index.css`, and the fonts are the same woff2 files the SPA self-hosts,
inlined because the page is served from the API origin and must load nothing else.
"""

from __future__ import annotations

import base64
from functools import cache
from importlib import resources
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:  # pragma: no cover
    from webbpulse.identity import ConsentTheme

ACCENT_LIGHT = "#b8451a"
ACCENT_DARK = "#f2703a"

FONT_FILES: dict[int, str] = {
    400: "Inter-Regular.woff2",
    500: "Inter-Medium.woff2",
    600: "Inter-SemiBold.woff2",
}
"""The Inter weights the page uses, by weight, as shipped in `consent_assets`."""

SCOPE_LABELS: dict[str, tuple[str, str, Literal["read", "write"]]] = {
    "issues:read": ("Read issues and projects", "Including comments, labels and project updates.", "read"),
    "issues:write": (
        "Create and update issues and projects",
        "Labels, links, archiving and project updates. It can never delete anything.",
        "write",
    ),
    "comments:write": ("Post and edit comments", "Comments appear under your name.", "write"),
    "teams:read": ("Read teams and members", "Including cycles, statuses and labels.", "read"),
    "views:read": ("Read saved views", "", "read"),
}
"""Plain-language wording for each MCP scope: label, detail and access."""


def _mark(color: str) -> str:
    """The Standupless mark in one colour, as an SVG data URI."""
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="{color}">'
        '<rect x="4" y="21.5" width="12" height="5" rx="2.5"/>'
        '<rect x="10" y="13.5" width="12" height="5" rx="2.5"/>'
        '<rect x="23" y="5.5" width="5" height="5" rx="2.5"/></svg>'
    )
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode("ascii")


def font_bytes(weight: int) -> bytes:
    """The woff2 bytes for one Inter weight."""
    assets = resources.files("app.domains.identity").joinpath("consent_assets")
    return assets.joinpath(FONT_FILES[weight]).read_bytes()


@cache
def build_consent_theme() -> "ConsentTheme":
    """The Standupless `ConsentTheme`, built once per process."""
    from webbpulse.identity import ConsentPalette, ConsentTheme, FontFace, ScopeLabel

    light = ConsentPalette(
        background="#ffffff",
        surface="#f7f7f8",
        raised="#efeff2",
        line="#e5e5ea",
        line_strong="#cfd0d7",
        text="#1b1c20",
        text_muted="#62646f",
        text_faint="#686a74",
        accent=ACCENT_LIGHT,
        accent_foreground="#ffffff",
        accent_ring="#b8451a66",
        danger="#c42b33",
    )
    dark = ConsentPalette(
        background="#141518",
        surface="#1b1c20",
        raised="#232429",
        line="#2a2b31",
        line_strong="#3a3c44",
        text="#e7e7eb",
        text_muted="#9b9da7",
        text_faint="#8a8d99",
        accent=ACCENT_DARK,
        accent_foreground="#17120f",
        accent_ring="#f2703a80",
        danger="#f0616a",
    )
    return ConsentTheme(
        light=light,
        dark=dark,
        color_scheme="dark",
        logo_url=_mark(ACCENT_LIGHT),
        logo_dark_url=_mark(ACCENT_DARK),
        font_family="Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        font_faces=tuple(FontFace.woff2(weight, font_bytes(weight)) for weight in FONT_FILES),
        scope_labels={
            scope: ScopeLabel(label, detail, access) for scope, (label, detail, access) in SCOPE_LABELS.items()
        },
        revoke_note="You can disconnect it any time from Connected apps in your workspace settings.",
    )
