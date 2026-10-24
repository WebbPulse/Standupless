"""Who a Discord person is in Standupless: linked once by their verified email, checked afresh every time.

Discord never shows a bot anyone's email, so the first command a person runs
answers with a link through Discord's own consent screen, asking for `identify`
and `email`. The callback accepts it only when the Discord account is the one the
link was minted for and Discord says its email is verified, and only when that
email is a live member of the workspace the server is bound to. Every later
command checks the link against the member again, so a member who leaves, is
disabled or changes their email is no longer acted for.

The consent URL with its signed state is about 600 characters, past the 512 a
Discord link button allows, so the button carries a short signed start link
instead. Following it mints the full single use state there and then and sends the
browser on to Discord, so the callback's checks are exactly the same.

A member can also link from their notification settings. They are signed in
already, so the state names them and the consent asks for `identify` alone: the
callback accepts whichever Discord account answers it and links it to that member,
as long as they are still a live member with a confirmed email.

Either way a finished link also writes the member's Discord chat route, so their
personal notifications reach them as direct messages from the bot.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Mapping
from urllib.parse import urlencode

from webbpulse.security import ExpiredToken, InvalidToken, create_token, decode_token

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.core.config import settings
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.chat_routes import ChatRoute
from app.common.db.dynamo.discord import DiscordInstallation, DiscordUserLink, discord_user_key
from app.domains.integrations.chat.people import NotLinked, member_context
from app.domains.integrations.discord import api
from app.domains.integrations.install_state import STATE_TTL_SECONDS, mint_state

LINK_AUDIENCE = "standupless.discord-link"

LINK_NONCE_SCOPE = "discord-link-state"

START_AUDIENCE = "standupless.discord-link-start"

START_PARAMETER = "link"

PROVIDER = "discord"

SETTINGS_ORIGIN = "settings"

__all__ = [
    "LINK_AUDIENCE",
    "LINK_NONCE_SCOPE",
    "START_AUDIENCE",
    "START_PARAMETER",
    "PROVIDER",
    "SETTINGS_ORIGIN",
    "LinkRejected",
    "NotLinked",
    "complete_link",
    "context_for",
    "link_url",
    "settings_link_url",
    "unlink",
    "start_link",
    "start_url",
]


class LinkRejected(Exception):
    """A link callback that cannot be accepted, with the reason the page shows."""

    def __init__(self, reason: str) -> None:
        """Carry the reason."""
        super().__init__(reason)
        self.reason = reason


def context_for(repositories: Repositories, installation: DiscordInstallation, discord_user_id: str) -> AuthzContext:
    """The authorization context of the member a Discord person is linked to, or `NotLinked`."""
    if not discord_user_id:
        raise NotLinked("no Discord user")
    link = repositories.github.discord.get_link(installation.workspace_id, discord_user_id)
    if link is None:
        raise NotLinked("not linked")
    context = member_context(repositories, installation.workspace_id, link.email)
    if context.user_id != link.user_id:
        raise NotLinked("the email now belongs to another account")
    return context


def link_url(installation: DiscordInstallation, discord_user_id: str) -> str:
    """The consent link one Discord person follows to link their account, good for ten minutes and once."""
    state, _ = mint_state(
        installation.workspace_id,
        f"discord:{discord_user_id}",
        audience=LINK_AUDIENCE,
        extra={"discord_user_id": discord_user_id, "guild_id": installation.guild_id},
    )
    return api.link_url(state)


def settings_link_url(installation: DiscordInstallation, user_id: str) -> tuple[str, datetime]:
    """The consent link a signed in member follows from settings, asking only for `identify`, and its expiry."""
    state, expires_at = mint_state(
        installation.workspace_id,
        user_id,
        audience=LINK_AUDIENCE,
        extra={"guild_id": installation.guild_id, "origin": SETTINGS_ORIGIN},
    )
    return api.link_url(state, api.SETTINGS_LINK_SCOPES), expires_at


def start_url(installation: DiscordInstallation, discord_user_id: str) -> str:
    """The short link a button sends one Discord person to, good for ten minutes, which starts their consent."""
    ticket = create_token(
        {"g": installation.guild_id, "u": discord_user_id},
        settings.SECRET_KEY,
        expires_in=timedelta(seconds=STATE_TTL_SECONDS),
        audience=START_AUDIENCE,
    )
    return f"{api.redirect_uri()}?{urlencode({START_PARAMETER: ticket})}"


def start_link(repositories: Repositories, ticket: str) -> str:
    """The consent URL a start link leads to, minted fresh for the person it names, or `LinkRejected`."""
    try:
        claims = decode_token(ticket, settings.SECRET_KEY, audience=START_AUDIENCE, require=["exp", "iat", "g", "u"])
    except (ExpiredToken, InvalidToken) as error:
        raise LinkRejected("invalid_state") from error
    guild_id = str(claims.get("g", ""))
    discord_user_id = str(claims.get("u", ""))
    installation = repositories.github.discord.installation_for_guild(guild_id) if guild_id.isdigit() else None
    if installation is None:
        raise LinkRejected("not_installed")
    if not discord_user_id:
        raise LinkRejected("invalid_state")
    return link_url(installation, discord_user_id)


def _verified_email(person: Mapping[str, Any]) -> str:
    """The email Discord holds for a person when it says the address is verified, or `""`."""
    if person.get("verified") is not True or person.get("bot"):
        return ""
    return str(person.get("email") or "").strip().lower()


def _settings_member(repositories: Repositories, workspace_id: str, user_id: str) -> tuple[str, str]:
    """The member who started a link from settings and their confirmed email, or `LinkRejected`."""
    user = repositories.users.get(user_id)
    if user is None or not user.email_verified:
        raise LinkRejected("unverified_email")
    try:
        context = member_context(repositories, workspace_id, user.email_lower)
    except NotLinked as error:
        raise LinkRejected("no_member") from error
    if context.user_id != user.id:
        raise LinkRejected("no_member")
    return user.id, user.email_lower


def _store_route(repositories: Repositories, installation: DiscordInstallation, link: DiscordUserLink) -> None:
    """Point the member's Discord direct messages at the person just linked, dropping links it replaces."""
    routes = repositories.inbox.chat_routes
    earlier = routes.get(installation.workspace_id, link.user_id, PROVIDER)
    if earlier is not None and earlier.external_user_id != link.discord_user_id:
        repositories.github.discord.delete_link(installation.workspace_id, earlier.external_user_id)
    routes.put(
        ChatRoute(
            workspace_id=installation.workspace_id,
            user_id=link.user_id,
            provider=PROVIDER,
            external_user_id=link.discord_user_id,
            external_team_id=installation.guild_id,
            linked_at=utc_now(),
        )
    )


def complete_link(repositories: Repositories, claims: Mapping[str, Any], access_token: str) -> DiscordUserLink:
    """Link the Discord person behind an access token to a member, or `LinkRejected`.

    A link started from a Discord command names the Discord account and matches it
    by its verified email. A link started from settings names the member and takes
    whichever Discord account consented.
    """
    workspace_id = str(claims.get("workspace_id", ""))
    installation = repositories.github.discord.get(workspace_id)
    if installation is None or installation.guild_id != str(claims.get("guild_id", "")):
        raise LinkRejected("not_installed")
    try:
        person = api.current_user(access_token)
    except api.DiscordError as error:
        raise LinkRejected("error") from error
    discord_user_id = str(person.get("id", ""))
    if claims.get("origin") == SETTINGS_ORIGIN:
        if not discord_user_id or person.get("bot"):
            raise LinkRejected("wrong_account")
        user_id, email = _settings_member(repositories, workspace_id, str(claims.get("user_id", "")))
    else:
        if not discord_user_id or discord_user_id != str(claims.get("discord_user_id", "")):
            raise LinkRejected("wrong_account")
        email = _verified_email(person)
        if not email:
            raise LinkRejected("unverified_email")
        try:
            user_id = member_context(repositories, workspace_id, email).user_id
        except NotLinked as error:
            raise LinkRejected("no_member") from error
    previous = repositories.github.discord.get_link(workspace_id, discord_user_id)
    if previous is not None and previous.user_id != user_id:
        repositories.inbox.chat_routes.delete(workspace_id, previous.user_id, PROVIDER)
    link = DiscordUserLink(
        workspace_id=workspace_id,
        github_key=discord_user_key(discord_user_id),
        discord_user_id=discord_user_id,
        user_id=user_id,
        email=email,
    )
    stored = repositories.github.discord.put_link(link)
    _store_route(repositories, installation, stored)
    return stored


def unlink(repositories: Repositories, workspace_id: str, user_id: str) -> bool:
    """Stop one member's Discord direct messages and forget their Discord link, answering whether there was one."""
    route = repositories.inbox.chat_routes.get(workspace_id, user_id, PROVIDER)
    if route is None:
        return False
    link = repositories.github.discord.get_link(workspace_id, route.external_user_id)
    if link is not None and link.user_id == user_id:
        repositories.github.discord.delete_link(workspace_id, route.external_user_id)
    return repositories.inbox.chat_routes.delete(workspace_id, user_id, PROVIDER)
