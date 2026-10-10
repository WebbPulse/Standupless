"""The Discord App installation of one workspace and the Discord people linked to it, in the `github` table.

A workspace holds at most one Discord server, under `discordinstall#<guild>` in
its own partition, with the `discordguild#<guild>` pointer in `_platform` mapping
a guild back to it, by the rules `BoundInstallStore` shares with the Slack App.
Unlike Slack, Discord gives one bot token for the whole App rather than one per
install, and that token lives in the app secret, so the row holds no credential.

Discord never tells a bot a person's email, so a Discord user is linked to a
Standupless member once, through Discord's own OAuth consent, and the link is kept
as `discorduser#<discord user>` in the workspace's partition. The link stores the
email it was made with, and it only resolves while that member still has that
address, so a changed email unlinks the person rather than carrying over.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Mapping

from boto3.dynamodb.conditions import Key
from pydantic import BaseModel, Field

from app.common.db.dynamo.base import as_item, utc_now
from app.common.db.dynamo.chat_installs import BoundInstallStore

DISCORD_INSTALL_PREFIX = "discordinstall#"
DISCORD_GUILD_PREFIX = "discordguild#"
DISCORD_USER_PREFIX = "discorduser#"

MAX_LINKS = 1000


def discord_install_key(guild_id: str) -> str:
    """The sort key of one workspace's Discord installation."""
    return f"{DISCORD_INSTALL_PREFIX}{guild_id}"


def discord_user_key(discord_user_id: str) -> str:
    """The sort key of one Discord person's link to a member."""
    return f"{DISCORD_USER_PREFIX}{discord_user_id}"


class DiscordInstallation(BaseModel):
    """One workspace's Discord App installation: the server the bot joined."""

    workspace_id: str
    github_key: str
    guild_id: str
    guild_name: str = ""
    installed_by: str
    installed_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class DiscordUserLink(BaseModel):
    """A Discord person linked to one Standupless member through Discord's OAuth consent."""

    workspace_id: str
    github_key: str
    discord_user_id: str
    user_id: str
    email: str
    linked_at: datetime = Field(default_factory=utc_now)


class DiscordStore(BoundInstallStore[DiscordInstallation]):
    """Reads and writes Discord installation and link rows, every method workspace first."""

    install_prefix = DISCORD_INSTALL_PREFIX
    pointer_prefix = DISCORD_GUILD_PREFIX
    id_field = "guild_id"
    model = DiscordInstallation

    def installation_for_guild(self, guild_id: str) -> DiscordInstallation | None:
        """The installation a Discord server resolves to, or `None`."""
        return self.installation_for(guild_id)

    def get_link(self, workspace_id: str, discord_user_id: str) -> DiscordUserLink | None:
        """The member one Discord person is linked to in this workspace, or `None`."""
        if not workspace_id or not discord_user_id:
            return None
        item = self._repository.get(self._key(workspace_id, discord_user_key(discord_user_id)), consistent=True)
        return DiscordUserLink.model_validate(dict(item)) if item is not None else None

    def put_link(self, link: DiscordUserLink) -> DiscordUserLink:
        """Store one Discord person's link, replacing any earlier one."""
        self._repository.put(as_item(link))
        return link

    def _links(self, workspace_id: str) -> list[Mapping[str, Any]]:
        """Every link row of one workspace."""
        return list(
            self._repository.iter_query(
                Key("workspace_id").eq(workspace_id) & Key("github_key").begins_with(DISCORD_USER_PREFIX),
                max_items=MAX_LINKS,
            )
        )

    def delete_links(self, workspace_id: str) -> int:
        """Forget every Discord person linked in this workspace, answering how many went."""
        if not workspace_id:
            return 0
        removed = 0
        for item in self._links(workspace_id):
            self._repository.delete(self._key(workspace_id, str(item["github_key"])))
            removed += 1
        return removed
