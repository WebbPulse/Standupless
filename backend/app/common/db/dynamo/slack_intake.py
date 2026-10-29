"""Emoji reaction intake: the emoji and channels a team files Slack messages from, in the `github` table.

A team that turns intake on holds one row in the workspace's partition, keyed
`slackintake#<team id>`, naming the emoji, the Slack channels it listens in and
the Slack workspace those channel ids belong to. A channel named in
`message_channel_ids` as well is in every message mode: each top-level message
posted there is filed without waiting for the emoji. A reaction or a message
finds every team's row with one prefix query, since a workspace has few teams.

Each message a team files claims one row before the issue is written,
`slackreact#<channel>#<message ts>#<team id>`, so a second reaction, a second
person reacting, a redelivered event or a reaction on a message every message
mode already filed files nothing more. The claim outlives a
disconnect on purpose: reconnecting Slack must not refile old messages.

Every row lives in the workspace's own partition, so the workspace purge removes
them with the rest of the partition.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository

from app.common.db.dynamo.base import as_item, utc_now

INTAKE_PREFIX = "slackintake#"
REACTION_PREFIX = "slackreact#"
MAX_TEAMS = 500


def intake_key(team_id: str) -> str:
    """The sort key of one team's reaction intake setting."""
    return f"{INTAKE_PREFIX}{team_id}"


def reaction_key(channel_id: str, message_ts: str, team_id: str) -> str:
    """The sort key of the claim on one Slack message filed into one team."""
    return f"{REACTION_PREFIX}{channel_id}#{message_ts}#{team_id}"


class SlackReactionIntake(BaseModel):
    """One team's Slack intake: which emoji, in which channels of which Slack workspace.

    `message_channel_ids` holds the channels, among `channel_ids`, where every
    top-level message is filed; the rest file a message only on the emoji.
    """

    workspace_id: str
    github_key: str
    team_id: str
    emoji: str
    channel_ids: list[str] = Field(default_factory=list)
    message_channel_ids: list[str] = Field(default_factory=list)
    slack_team_id: str
    enabled_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class SlackReactionClaim(BaseModel):
    """The claim on one Slack message being filed as an issue in one team.

    `state` is `pending` while the issue is being written and `filed` once it
    exists, carrying its id.
    """

    workspace_id: str
    github_key: str
    team_id: str
    channel_id: str
    message_ts: str
    issue_id: str = ""
    state: Literal["pending", "filed"] = "pending"
    claimed_at: datetime = Field(default_factory=utc_now)


class SlackIntakeStore:
    """Reads and writes reaction intake settings and their per message claims, every method workspace first."""

    def __init__(self, repository: Repository) -> None:
        """Share the `github` table's package repository."""
        self._repository = repository

    def _key(self, workspace_id: str, github_key: str) -> dict[str, str]:
        """The primary key of one row."""
        return {"workspace_id": workspace_id, "github_key": github_key}

    def get(self, workspace_id: str, team_id: str) -> SlackReactionIntake | None:
        """One team's reaction intake setting, or `None` while it is off."""
        if not workspace_id or not team_id:
            return None
        item = self._repository.get(self._key(workspace_id, intake_key(team_id)), consistent=True)
        return SlackReactionIntake.model_validate(dict(item)) if item is not None else None

    def list_workspace(self, workspace_id: str) -> list[SlackReactionIntake]:
        """Every team's reaction intake setting in one workspace."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("github_key").begins_with(INTAKE_PREFIX),
            max_items=MAX_TEAMS,
            consistent=True,
        )
        return [SlackReactionIntake.model_validate(dict(item)) for item in items]

    def put(self, intake: SlackReactionIntake) -> SlackReactionIntake:
        """Store one team's setting, replacing the one before it."""
        self._repository.put(as_item(intake))
        return intake

    def delete(self, workspace_id: str, team_id: str) -> SlackReactionIntake | None:
        """Turn one team's reaction intake off, answering the row that was removed."""
        current = self.get(workspace_id, team_id)
        if current is None:
            return None
        self._repository.delete(self._key(workspace_id, current.github_key))
        return current

    def delete_team(self, workspace_id: str, team_id: str) -> bool:
        """Turn a purged team's reaction intake off."""
        return self.delete(workspace_id, team_id) is not None

    def claim(self, row: SlackReactionClaim) -> bool:
        """Write a message's claim, refusing when the message was already filed or is being filed."""
        try:
            self._repository.put(as_item(row), condition=Attr("github_key").not_exists())
        except ConditionFailed:
            return False
        return True

    def get_claim(self, workspace_id: str, channel_id: str, message_ts: str, team_id: str) -> SlackReactionClaim | None:
        """The claim on one message filed into one team, or `None`."""
        item = self._repository.get(
            self._key(workspace_id, reaction_key(channel_id, message_ts, team_id)), consistent=True
        )
        return SlackReactionClaim.model_validate(dict(item)) if item is not None else None

    def mark_filed(self, row: SlackReactionClaim, issue_id: str) -> SlackReactionClaim:
        """Record the issue a claimed message became."""
        filed = row.model_copy(update={"issue_id": issue_id, "state": "filed"})
        self._repository.put(as_item(filed))
        return filed

    def release(self, workspace_id: str, github_key: str) -> None:
        """Drop one claim, so a message whose issue could not be written can be filed later."""
        self._repository.delete(self._key(workspace_id, github_key))
