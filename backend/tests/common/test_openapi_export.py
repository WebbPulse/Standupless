"""The committed OpenAPI document matches the routes the code serves.

This is the same guard `dynamodb_tables.json` has: an artifact generated from the
code is committed, and a test fails until the regeneration lands. Without it the
published document silently describes last month's API.
"""

from __future__ import annotations

from scripts.export_openapi import TARGET, render


def test_the_exported_openapi_document_is_up_to_date() -> None:
    """`openapi.json` matches what the export script would write right now.

    Regenerate with `uv run python scripts/export_openapi.py` and commit the
    result. A diff here is a real change to the served surface, so it is meant to
    be read rather than accepted blindly.
    """
    assert TARGET.exists(), "openapi.json is missing: run uv run python scripts/export_openapi.py"
    assert TARGET.read_text(encoding="utf-8") == render(), (
        "openapi.json is stale: run uv run python scripts/export_openapi.py and commit the result"
    )


def test_the_document_carries_every_public_route() -> None:
    """The anonymous routes appear in the published document.

    The share reads and the MCP endpoint are part of the contract an integrator
    reads, so excluding them from the schema would leave the one surface reachable
    without a session undocumented.
    """
    from scripts.export_openapi import document

    paths = document()["paths"]
    for path in ("/api/shared/{token}", "/api/shared/{token}/issue", "/api/shared/{token}/view", "/api/mcp"):
        assert path in paths, f"{path} is missing from the exported document"
