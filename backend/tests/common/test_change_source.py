"""Deriving a change's source from the verified claims of each credential kind."""

from __future__ import annotations

from typing import Any

import pytest

from app.common.api.dependencies.authz import source_of
from app.common.change_source import source_for


@pytest.mark.parametrize(
    ("claims", "expected"),
    [
        ({"sub": "u"}, "web"),
        ({"sub": "u", "actor_kind": "api_key", "tenant_id": "w", "scopes": ["issues:read"]}, "api"),
        ({"sub": "u", "actor": "service", "tenant_id": "w"}, "api"),
        ({"sub": "u", "client_id": "agent", "scopes": ["issues:read"]}, "mcp"),
        ({"sub": "u", "scopes": ["issues:read"]}, "mcp"),
        ({"sub": "u", "source": "cli"}, "web"),
    ],
)
def test_the_source_follows_the_credential(claims: dict[str, Any], expected: str) -> None:
    """Each credential kind lands its own source, and a `source` claim is not read."""
    assert source_of(claims) == expected


@pytest.mark.parametrize(
    ("claims", "expected"),
    [
        ({"sub": "u", "actor_kind": "api_key", "tenant_id": "w"}, "cli"),
        ({"sub": "u", "actor": "service", "tenant_id": "w"}, "api"),
        ({"sub": "u"}, "web"),
        ({"sub": "u", "client_id": "agent", "scopes": ["issues:read"]}, "mcp"),
    ],
)
def test_the_cli_agent_narrows_only_an_api_key(claims: dict[str, Any], expected: str) -> None:
    """The CLI's User-Agent marks a personal key's change as the CLI and moves no other credential."""
    assert source_of(claims, "standupless-cli/0.1.0") == expected


def test_automated_actors_are_their_own_source() -> None:
    """A GitHub or job row names that origin when no client source was given."""
    assert source_for(None, "github") == "github"
    assert source_for(None, "system") == "system"
    assert source_for(None, "user") is None
    assert source_for("mcp", "user") == "mcp"
