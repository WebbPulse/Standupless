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


PUBLIC_OPERATIONS = {
    ("GET", "/api/workspaces/{workspace_id}/attachments/{attachment_id}/content"),
    ("GET", "/api/shared/{token}"),
    ("GET", "/api/shared/{token}/issue"),
    ("GET", "/api/shared/{token}/view"),
    ("GET", "/api/github/callback"),
    ("POST", "/api/github/webhooks"),
    ("GET", "/api/mcp"),
    ("POST", "/api/mcp"),
    ("DELETE", "/api/mcp"),
}
"""The operations outside `/api/auth` the gateway serves with no identity authorizer."""


def test_every_protected_operation_declares_the_identity_security_scheme() -> None:
    """Each operation behind the identity authorizer carries a security requirement, and no other does.

    The gateway enforces the identity token on every domain route key except the
    public ones above, and clients and the e2e coverage group read `security` to know
    which operations those are. A protected route whose dependency skips the scheme
    reads as public, so the document would disagree with the deployed authorizer.
    """
    from scripts.export_openapi import document

    for path, item in document()["paths"].items():
        if path.startswith("/api/auth"):
            continue
        for method, operation in item.items():
            declared = bool(operation.get("security"))
            public = (method.upper(), path) in PUBLIC_OPERATIONS
            assert declared is not public, (
                f"{method.upper()} {path} declares security={operation.get('security')!r}, "
                f"but it is {'public' if public else 'behind the identity authorizer'} at the gateway"
            )
