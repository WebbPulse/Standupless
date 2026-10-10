"""The committed Slack App manifests agree with the code that answers them.

An App created from a manifest whose URLs, scopes or callback ids drift from the
routes would install cleanly and then fail every request, so each environment's
manifest is held to the hosts, scopes and ids the backend actually uses.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.common.core.config import PRODUCTION_HOST, STAGING_HOST
from app.domains.integrations.slack.api import BOT_SCOPES
from app.domains.integrations.slack.commands import SHORTCUT_CALLBACK

MANIFESTS = Path(__file__).resolve().parents[3].parent / "slack"


def _manifest(name: str) -> dict[str, Any]:
    """One committed manifest."""
    return json.loads((MANIFESTS / f"manifest.{name}.json").read_text())


@pytest.mark.parametrize(
    ("name", "host", "command"),
    [("staging", STAGING_HOST, "/standupless-staging"), ("production", PRODUCTION_HOST, "/standupless")],
)
def test_a_manifest_points_at_its_own_environment(name: str, host: str, command: str) -> None:
    """Every URL is on the environment's API host and every id matches the backend."""
    manifest = _manifest(name)
    api = f"https://api.{host}/api/slack"
    features = manifest["features"]
    settings = manifest["settings"]
    assert manifest["oauth_config"]["redirect_urls"] == [f"{api}/oauth/callback"]
    assert tuple(manifest["oauth_config"]["scopes"]["bot"]) == BOT_SCOPES
    assert "user" not in manifest["oauth_config"]["scopes"]
    assert [(row["command"], row["url"]) for row in features["slash_commands"]] == [(command, f"{api}/commands")]
    assert [(row["type"], row["callback_id"]) for row in features["shortcuts"]] == [("message", SHORTCUT_CALLBACK)]
    assert features["unfurl_domains"] == [host]
    assert settings["event_subscriptions"]["request_url"] == f"{api}/events"
    assert sorted(settings["event_subscriptions"]["bot_events"]) == ["app_uninstalled", "link_shared", "tokens_revoked"]
    assert settings["interactivity"] == {"is_enabled": True, "request_url": f"{api}/interactions"}
    assert settings["socket_mode_enabled"] is False
    assert settings["token_rotation_enabled"] is False
