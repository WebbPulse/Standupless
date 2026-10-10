"""The Slack App installation of one workspace, in the `github` table.

A workspace holds at most one Slack installation, under `slackinstall#<slack team>`
in its own partition. The bot token is a bearer credential, so the row keeps it
only as an AES-GCM envelope, as a channel destination keeps its webhook URL.

Slack names a workspace by its Slack team id alone on every event, command and
interaction it sends, so a pointer row under the `_platform` partition, keyed
`slackteam#<slack team>`, maps that id back to the one workspace it is bound to.
The pointer is only trusted while the workspace still holds the matching
installation, so a pointer a workspace purge left behind resolves to nothing.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository

from app.common.db.dynamo.base import as_item, first, utc_now

SLACK_INSTALL_PREFIX = "slackinstall#"
SLACK_TEAM_PREFIX = "slackteam#"
PLATFORM_PARTITION = "_platform"


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


class SlackTeamPointer(BaseModel):
    """Which workspace one Slack team is bound to."""

    workspace_id: str = PLATFORM_PARTITION
    github_key: str
    slack_team_id: str
    bound_workspace_id: str
    updated_at: datetime = Field(default_factory=utc_now)


class SlackStore:
    """Reads and writes Slack installation rows, every method workspace first."""

    def __init__(self, repository: Repository) -> None:
        """Share the `github` table's package repository."""
        self._repository = repository

    def _key(self, workspace_id: str, github_key: str) -> dict[str, str]:
        """The primary key of one row."""
        return {"workspace_id": workspace_id, "github_key": github_key}

    def _rows(self, workspace_id: str) -> list[Mapping[str, Any]]:
        """Every Slack installation row of one workspace, read strongly consistent."""
        if not workspace_id:
            return []
        return list(
            self._repository.iter_query(
                Key("workspace_id").eq(workspace_id) & Key("github_key").begins_with(SLACK_INSTALL_PREFIX),
                max_items=10,
                consistent=True,
            )
        )

    def get(self, workspace_id: str) -> SlackInstallation | None:
        """The workspace's Slack installation, or `None`."""
        item = first(self._rows(workspace_id))
        return SlackInstallation.model_validate(dict(item)) if item is not None else None

    def bound_workspace(self, slack_team_id: str) -> str:
        """The workspace a Slack team is installed in, or `""` when none holds it now."""
        if not slack_team_id:
            return ""
        item = self._repository.get(self._key(PLATFORM_PARTITION, slack_team_key(slack_team_id)), consistent=True)
        if item is None:
            return ""
        workspace_id = str(item.get("bound_workspace_id", ""))
        installation = self.get(workspace_id)
        if installation is None or installation.slack_team_id != slack_team_id:
            return ""
        return workspace_id

    def installation_for_team(self, slack_team_id: str) -> SlackInstallation | None:
        """The installation a Slack team id resolves to, or `None`."""
        workspace_id = self.bound_workspace(slack_team_id)
        return self.get(workspace_id) if workspace_id else None

    def put(self, installation: SlackInstallation) -> SlackInstallation:
        """Store the workspace's installation, replacing any other Slack team it held."""
        for item in self._rows(installation.workspace_id):
            if str(item["github_key"]) != installation.github_key:
                self._drop(installation.workspace_id, str(item.get("slack_team_id", "")))
        self._repository.put(as_item(installation))
        pointer = SlackTeamPointer(
            github_key=slack_team_key(installation.slack_team_id),
            slack_team_id=installation.slack_team_id,
            bound_workspace_id=installation.workspace_id,
        )
        self._repository.put(as_item(pointer))
        return installation

    def _drop(self, workspace_id: str, slack_team_id: str) -> None:
        """Remove one installation row and its pointer when the pointer still names this workspace."""
        self._repository.delete(self._key(workspace_id, slack_install_key(slack_team_id)))
        pointer = self._key(PLATFORM_PARTITION, slack_team_key(slack_team_id))
        try:
            self._repository.delete(pointer, condition=Attr("bound_workspace_id").eq(workspace_id))
        except ConditionFailed:
            return

    def delete(self, workspace_id: str) -> SlackInstallation | None:
        """Forget the workspace's installation, answering the row that was removed."""
        current = self.get(workspace_id)
        if current is None:
            return None
        self._drop(workspace_id, current.slack_team_id)
        return current
