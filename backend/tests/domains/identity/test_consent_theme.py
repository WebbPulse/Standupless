"""The Standupless brand for the MCP consent screen.

The consent page is served by the identity package from the API origin, so it carries its
own copy of Inter and its own wording for the product's scopes. These hold that copy to
the frontend's and that wording to the scopes the server actually grants.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.domains.identity.consent_theme import FONT_FILES, SCOPE_LABELS, build_consent_theme, font_bytes
from app.domains.identity.oauth_server_glue import MCP_SCOPES

FRONTEND_FONTS = Path(__file__).resolve().parents[3].parent / "frontend" / "src" / "brand" / "fonts"


@pytest.mark.parametrize("weight", sorted(FONT_FILES))
def test_fonts_match_the_frontend(weight: int) -> None:
    """Each inlined weight is byte for byte the file the SPA self-hosts."""
    assert font_bytes(weight) == (FRONTEND_FONTS / FONT_FILES[weight]).read_bytes()


def test_every_granted_scope_is_worded() -> None:
    """No scope the server grants falls back to the package's inferred wording."""
    assert set(MCP_SCOPES) <= set(SCOPE_LABELS)


def test_the_theme_builds() -> None:
    """The theme passes the package's validation and carries the brand."""
    theme = build_consent_theme()
    assert theme.color_scheme == "dark"
    assert theme.dark.accent == "#f2703a"
    assert theme.light.accent == "#b8451a"
    assert [face.weight for face in theme.font_faces] == [400, 500, 600]
    assert theme.logo_url.startswith("data:image/svg+xml;base64,")
    assert "Connected apps" in theme.revoke_note


def test_no_copy_has_an_em_dash() -> None:
    """Product copy never uses an em dash."""
    theme = build_consent_theme()
    copy = [theme.revoke_note] + [part for label in SCOPE_LABELS.values() for part in label[:2]]
    assert not any("—" in text for text in copy)
