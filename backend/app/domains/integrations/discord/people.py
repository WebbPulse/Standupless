"""Who a Discord person is in Standupless: linked once by their verified email, checked afresh every time.

Discord never shows a bot anyone's email, so the first command a person runs
answers with a link through Discord's own consent screen, asking for `identify`
and `email`. The callback accepts it only when the Discord account is the one the
link was minted for and Discord says its email is verified, and only when that
email is a live member of the workspace the server is bound to. Every later
command checks the link against the member again, so a member who leaves, is
disabled or changes their email is no longer acted for.
"""

from __future__ import annotations

from typing import Any, Mapping

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.discord import DiscordInstallation, DiscordUserLink, discord_user_key
from app.domains.integrations.chat.people import NotLinked, member_context
from app.domains.integrations.discord import api
from app.domains.integrations.install_state import mint_state

LINK_AUDIENCE = "standupless.discord-link"

LINK_NONCE_SCOPE = "discord-link-state"

__all__ = ["LINK_AUDIENCE", "LINK_NONCE_SCOPE", "LinkRejected", "NotLinked", "complete_link", "context_for", "link_url"]


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


def _verified_email(person: Mapping[str, Any]) -> str:
    """The email Discord holds for a person when it says the address is verified, or `""`."""
    if person.get("verified") is not True or person.get("bot"):
        return ""
    return str(person.get("email") or "").strip().lower()


def complete_link(repositories: Repositories, claims: Mapping[str, Any], access_token: str) -> DiscordUserLink:
    """Link the Discord person behind an access token to the member with their verified email, or `LinkRejected`."""
    workspace_id = str(claims.get("workspace_id", ""))
    installation = repositories.github.discord.get(workspace_id)
    if installation is None or installation.guild_id != str(claims.get("guild_id", "")):
        raise LinkRejected("not_installed")
    try:
        person = api.current_user(access_token)
    except api.DiscordError as error:
        raise LinkRejected("error") from error
    discord_user_id = str(person.get("id", ""))
    if not discord_user_id or discord_user_id != str(claims.get("discord_user_id", "")):
        raise LinkRejected("wrong_account")
    email = _verified_email(person)
    if not email:
        raise LinkRejected("unverified_email")
    try:
        context = member_context(repositories, workspace_id, email)
    except NotLinked as error:
        raise LinkRejected("no_member") from error
    link = DiscordUserLink(
        workspace_id=workspace_id,
        github_key=discord_user_key(discord_user_id),
        discord_user_id=discord_user_id,
        user_id=context.user_id,
        email=email,
    )
    return repositories.github.discord.put_link(link)
