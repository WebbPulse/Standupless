"""Binding a Discord server to a workspace, calling Discord as the bot, and forgetting the server.

One workspace holds at most one Discord server, and one server serves at most one
workspace, because every interaction Discord sends names only the server and has
to resolve to exactly one tenant. A second workspace adding the bot to a server
another workspace holds is refused rather than silently moving it.

Discord sends no event when the bot is removed from a server, so the install is
forgotten the first time a call as the bot finds the server gone: listing its
channels, or posting to one of them.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

from app.common.api.dependencies.repositories import Repositories
from app.common.core.config import settings
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.discord import DiscordInstallation, discord_install_key
from app.domains.integrations.chat.destinations import turn_off
from app.domains.integrations.discord import api

_log = logging.getLogger(__name__)

STATE_AUDIENCE = "standupless.discord-install"

NONCE_SCOPE = "discord-install-state"

TEXT_CHANNEL = 0

ANNOUNCEMENT_CHANNEL = 5

POSTABLE_CHANNEL_TYPES = frozenset({TEXT_CHANNEL, ANNOUNCEMENT_CHANNEL})

GONE_GUILD_CODES = frozenset({api.UNKNOWN_GUILD, api.MISSING_ACCESS})

UNINSTALLED_REASON = "The Discord App was removed from the Discord server."

DISCONNECTED_REASON = "Discord was disconnected from this workspace."


class InstallRejected(Exception):
    """An OAuth answer that cannot be bound, with the outcome code the settings page shows."""

    def __init__(self, reason: str) -> None:
        """Carry the outcome code."""
        super().__init__(reason)
        self.reason = reason


class BotUnavailable(Exception):
    """The bot is no longer in the workspace's Discord server."""


def bind(repositories: Repositories, workspace_id: str, user_id: str, answer: Mapping[str, Any]) -> DiscordInstallation:
    """Record the server an install answer names as this workspace's installation, or `InstallRejected`.

    The user access token the answer also carries is never stored: the bot acts
    with the App's own token, so the installer's grant is not needed again.
    """
    guild = answer.get("guild") or {}
    guild_id = str(guild.get("id", "") if isinstance(guild, Mapping) else "")
    if not guild_id.isdigit():
        raise InstallRejected("error")
    store = repositories.github.discord
    holder = store.bound_workspace(guild_id)
    if holder and holder != workspace_id:
        raise InstallRejected("discord_guild_taken")
    now = utc_now()
    previous = store.get(workspace_id)
    installation = DiscordInstallation(
        workspace_id=workspace_id,
        github_key=discord_install_key(guild_id),
        guild_id=guild_id,
        guild_name=str(guild.get("name", "")) if isinstance(guild, Mapping) else "",
        installed_by=user_id,
        installed_at=previous.installed_at if previous and previous.guild_id == guild_id else now,
        updated_at=now,
    )
    if previous is not None and previous.guild_id != guild_id:
        store.delete_links(workspace_id)
        turn_off(repositories, workspace_id, "discord_app", DISCONNECTED_REASON, notify=False)
    stored = store.put(installation)
    register_commands()
    return stored


def register_commands() -> bool:
    """Overwrite the App's global commands with the ones this backend answers, reporting success.

    Idempotent, so every install refreshes them, and a failure only means the
    commands from the last successful install stay in place.
    """
    from app.domains.integrations.discord.commands import COMMANDS

    try:
        api.bot("PUT", f"/applications/{settings.DISCORD_APPLICATION_ID}/commands", list(COMMANDS))
    except api.DiscordError as error:
        _log.warning(
            "Discord refused the command registration.",
            extra={"event": "integrations.discord.commands_failed", "status": error.status_code, "code": error.code},
        )
        return False
    return True


def _gone(error: api.DiscordError) -> bool:
    """Whether a refusal says the bot is no longer in the server."""
    return error.status_code in (403, 404) and error.code in GONE_GUILD_CODES


def list_channels(repositories: Repositories, installation: DiscordInstallation) -> list[dict[str, Any]]:
    """The text and announcement channels of the server, by name, or `BotUnavailable` once the bot is gone."""
    try:
        answer = api.bot("GET", f"/guilds/{installation.guild_id}/channels")
    except api.DiscordError as error:
        if _gone(error):
            forget_guild(repositories, installation.guild_id)
            raise BotUnavailable("the bot is no longer in the server") from error
        raise
    found: list[dict[str, Any]] = []
    for channel in answer if isinstance(answer, list) else []:
        if isinstance(channel, Mapping) and channel.get("type") in POSTABLE_CHANNEL_TYPES and channel.get("id"):
            found.append({"id": str(channel["id"]), "name": str(channel.get("name", ""))})
    return sorted(found, key=lambda channel: channel["name"])


def _forget(repositories: Repositories, workspace_id: str, reason: str, *, notify: bool) -> None:
    """Drop the installation and its people links, and turn off the channels that posted through it."""
    repositories.github.discord.delete(workspace_id)
    repositories.github.discord.delete_links(workspace_id)
    turn_off(repositories, workspace_id, "discord_app", reason, notify=notify)


def disconnect(repositories: Repositories, workspace_id: str) -> bool:
    """Take the bot out of the server and forget the installation, at an admin's request."""
    installation = repositories.github.discord.get(workspace_id)
    if installation is None:
        return False
    try:
        api.bot("DELETE", f"/users/@me/guilds/{installation.guild_id}")
    except api.DiscordError as error:
        _log.info(
            "The bot could not leave the Discord server; forgetting it anyway.",
            extra={"event": "integrations.discord.leave_failed", "status": error.status_code, "code": error.code},
        )
    _forget(repositories, workspace_id, DISCONNECTED_REASON, notify=False)
    return True


def forget_guild(repositories: Repositories, guild_id: str) -> bool:
    """Forget the installation of a server the bot was removed from."""
    workspace_id = repositories.github.discord.bound_workspace(guild_id)
    if not workspace_id:
        return False
    _forget(repositories, workspace_id, UNINSTALLED_REASON, notify=True)
    _log.info("Forgot a Discord server the bot left.", extra={"event": "integrations.discord.uninstalled"})
    return True
