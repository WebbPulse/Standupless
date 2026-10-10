"""The committed Discord App settings and commands agree with the code that answers them.

The Discord Developer Portal has no manifest import, so the settings each
environment's App is registered with are committed as a record the owner copies
from, and are held here to the hosts, scopes and permissions the backend uses. The
committed commands file is what the backend registers on every install, so a
reviewer sees a command change as a diff.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.common.core.config import PRODUCTION_HOST, STAGING_HOST
from app.domains.integrations.discord.api import BOT_PERMISSIONS, INSTALL_SCOPES, LINK_SCOPES
from app.domains.integrations.discord.commands import COMMANDS

DISCORD = Path(__file__).resolve().parents[3].parent / "discord"


def _read(name: str) -> Any:
    """One committed file."""
    return json.loads((DISCORD / name).read_text())


def test_the_committed_commands_are_the_registered_ones() -> None:
    """`discord/commands.json` is exactly what an install registers."""
    assert _read("commands.json") == json.loads(json.dumps(list(COMMANDS)))


def test_the_message_command_has_no_description() -> None:
    """Discord refuses a message command that carries a description."""
    message_commands = [command for command in COMMANDS if command["type"] == 3]
    assert [command["name"] for command in message_commands] == ["Create issue"]
    assert all("description" not in command for command in message_commands)


@pytest.mark.parametrize(("name", "host"), [("staging", STAGING_HOST), ("production", PRODUCTION_HOST)])
def test_an_application_points_at_its_own_environment(name: str, host: str) -> None:
    """Every URL is on the environment's API host and every scope and permission matches the backend."""
    application = _read(f"application.{name}.json")
    api = f"https://api.{host}/api/discord"
    assert application["interactions_endpoint_url"] == f"{api}/interactions"
    assert application["oauth2"]["redirects"] == [f"{api}/oauth/callback"]
    assert application["oauth2"]["requires_code_grant"] is True
    assert application["oauth2"]["install_link"] == "none"
    assert application["installation_contexts"] == {"guild_install": True, "user_install": False}
    assert tuple(application["install_scopes"]) == INSTALL_SCOPES
    assert tuple(application["link_scopes"]) == LINK_SCOPES
    assert int(application["bot_permissions"]) == BOT_PERMISSIONS
    assert application["privileged_gateway_intents"] == []
