"""The Slack App installation of one workspace, in the `github` table.

A workspace holds at most one Slack installation, under `slackinstall#<slack team>`
in its own partition. The bot token is a bearer credential, so the row keeps it
only as an AES-GCM envelope, as a channel destination keeps its webhook URL.

Slack names a workspace by its Slack team id alone on every event, command and
interaction it sends, so a pointer row under the `_platform` partition, keyed
`slackteam#<slack team>`, maps that id back to the one workspace it is bound to.
The binding rules are `BoundInstallStore`'s, shared with the Discord App.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.chat_installs import PLATFORM_PARTITION, BoundInstallStore

SLACK_INSTALL_PREFIX = "slackinstall#"
SLACK_TEAM_PREFIX = "slackteam#"

__all__ = [
    "PLATFORM_PARTITION",
    "SLACK_INSTALL_PREFIX",
    "SLACK_TEAM_PREFIX",
    "SlackInstallation",
    "SlackStore",
    "slack_install_key",
    "slack_team_key",
]


def slack_install_key(slack_team_id: str) -> str:
    """The sort key of one workspace's Slack installation."""
    return f"{SLACK_INSTALL_PREFIX}{slack_team_id}"


def slack_team_key(slack_team_id: str) -> str:
    """The sort key of the pointer from a Slack team to its workspace."""
    return f"{SLACK_TEAM_PREFIX}{slack_team_id}"


class SlackInstallation(BaseModel):
    """One workspace's Slack App installation and its sealed bot token."""

    workspace_id: str
    github_key: str
    slack_team_id: str
    slack_team_name: str = ""
    slack_team_domain: str = ""
    bot_user_id: str = ""
    app_id: str = ""
    scopes: list[str] = Field(default_factory=list)
    token_ciphertext: str
    token_nonce: str
    token_salt: str
    token_scheme: str
    installed_by: str
    installed_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class SlackStore(BoundInstallStore[SlackInstallation]):
    """Reads and writes Slack installation rows, every method workspace first."""

    install_prefix = SLACK_INSTALL_PREFIX
    pointer_prefix = SLACK_TEAM_PREFIX
    id_field = "slack_team_id"
    model = SlackInstallation

    def installation_for_team(self, slack_team_id: str) -> SlackInstallation | None:
        """The installation a Slack team id resolves to, or `None`."""
        return self.installation_for(slack_team_id)
