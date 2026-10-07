"""The Standupless brand for the identity package's MCP consent screen.

The package renders the page; this supplies the palette, the mark, Inter and the wording
for this product's scopes. The colours are the frontend's tokens in
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
    "issues:read": ("Read issues", "Including comments, relations and subscribers.", "read"),
    "issues:write": (
        "Create and update issues",
        "Assign, archive, link, bulk edit and move issues between cycles. It never deletes an issue.",
        "write",
    ),
    "comments:write": ("Post comments", "Comments appear under your name.", "write"),
    "teams:read": ("Read teams", "Team settings and your role in each team.", "read"),
    "teams:write": ("Create and change teams", "Name, key, cycle and archive settings.", "write"),
    "members:read": ("Read members", "Workspace and team members with their roles.", "read"),
    "members:write": (
        "Manage members",
        "Add or remove team members and, as an admin, invite, change roles or remove workspace members.",
        "write",
    ),
    "statuses:read": ("Read workflow statuses", "", "read"),
    "statuses:write": ("Change workflow statuses", "Add, rename, reorder and delete statuses.", "write"),
    "labels:read": ("Read labels", "", "read"),
    "labels:write": ("Change labels", "Create, rename, recolour and delete labels.", "write"),
    "projects:read": ("Read projects", "Including project updates.", "read"),
    "projects:write": ("Change projects", "Create, update and delete projects and project updates.", "write"),
    "milestones:read": ("Read milestones", "", "read"),
    "milestones:write": ("Change milestones", "Create, update and delete milestones.", "write"),
    "cycles:read": ("Read cycles", "", "read"),
    "cycles:write": ("Change cycles", "Create, update and delete cycles.", "write"),
    "releases:read": ("Read releases", "Including release pipelines.", "read"),
    "releases:write": (
        "Record releases",
        "Record, advance, edit and delete releases and, as a team admin, change release pipelines.",
        "write",
    ),
    "views:read": ("Read saved views", "", "read"),
    "views:write": ("Change saved views", "Create, update and delete your views and team views.", "write"),
    "notifications:read": ("Read your inbox", "", "read"),
    "notifications:write": ("Manage your inbox", "Mark read, snooze and delete notifications.", "write"),
    "settings:read": ("Read workspace settings", "", "read"),
    "settings:write": ("Change workspace settings", "Only if you are a workspace admin.", "write"),
    "admin": (
        "Act as a workspace admin",
        "Only if you are one. Never deletes the workspace, touches billing or mints keys.",
        "write",
    ),
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
