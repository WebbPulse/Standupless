"""The GitLab connections of one workspace, in the `github` table.

A connection is one GitLab group or project, on gitlab.com or a self-managed
instance, whose merge request events a workspace admin chose to receive. Each is
one row in the workspace's own partition, keyed `gitlabconn#<connection id>`.

The access token is a bearer credential, so the row keeps it only as an AES-GCM
envelope keyed from the environment's master key, as a Slack bot token is kept.
The webhook secret GitLab echoes in `X-Gitlab-Token` is kept only as its SHA-256
digest, since the receiver needs to compare it and never to send it.

The webhook URL names the workspace and the connection, so the receiver reads the
one row by its key and no pointer row in the `_platform` partition is needed.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository

from app.common.db.dynamo.base import as_item, utc_now

GITLAB_CONNECTION_PREFIX = "gitlabconn#"

MAX_CONNECTIONS = 50
"""The most GitLab connections one workspace may hold, far above any real need."""

ScopeKind = Literal["group", "project"]


def gitlab_connection_key(connection_id: str) -> str:
    """The sort key of one GitLab connection."""
    return f"{GITLAB_CONNECTION_PREFIX}{connection_id}"


class GitlabConnection(BaseModel):
    """One GitLab group or project a workspace receives merge request events from."""

    workspace_id: str
    github_key: str
    connection_id: str
    instance_url: str
    scope_kind: ScopeKind
    scope_id: str
    scope_path: str
    scope_name: str = ""
    web_url: str = ""
    token_ciphertext: str
    token_nonce: str
    token_salt: str
    token_scheme: str
    token_hint: str = ""
    webhook_secret_hash: str
    connected_by: str
    connected_at: datetime = Field(default_factory=utc_now)
    secret_rotated_at: datetime | None = None
    updated_at: datetime = Field(default_factory=utc_now)


class GitlabStore:
    """Reads and writes GitLab connection rows, every method workspace first."""

    def __init__(self, repository: Repository) -> None:
        """Share the `github` table's package repository."""
        self._repository = repository

    def _key(self, workspace_id: str, connection_id: str) -> dict[str, str]:
        """The primary key of one connection row."""
        return {"workspace_id": workspace_id, "github_key": gitlab_connection_key(connection_id)}

    def get(self, workspace_id: str, connection_id: str) -> GitlabConnection | None:
        """One connection, read strongly consistent, or `None`."""
        if not workspace_id or not connection_id:
            return None
        item = self._repository.get(self._key(workspace_id, connection_id), consistent=True)
        return GitlabConnection.model_validate(dict(item)) if item is not None else None

    def list(self, workspace_id: str) -> list[GitlabConnection]:
        """Every connection of one workspace, oldest first."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("github_key").begins_with(GITLAB_CONNECTION_PREFIX),
            max_items=MAX_CONNECTIONS + 1,
            consistent=True,
        )
        rows = [GitlabConnection.model_validate(dict(item)) for item in items]
        return sorted(rows, key=lambda row: row.connected_at)

    def create(self, connection: GitlabConnection) -> bool:
        """Store a new connection, answering `False` when one with that id already exists."""
        try:
            self._repository.put(as_item(connection), condition=Attr("github_key").not_exists())
        except ConditionFailed:
            return False
        return True

    def update(self, workspace_id: str, connection_id: str, **attributes: Any) -> GitlabConnection | None:
        """Apply `attributes` to one connection, or `None` when it is gone."""
        values: dict[str, Any] = {
            name: value.isoformat() if isinstance(value, datetime) else value for name, value in attributes.items()
        }
        values["updated_at"] = utc_now().isoformat()
        try:
            item = self._repository.set_attributes(
                self._key(workspace_id, connection_id), values, condition=Attr("connection_id").exists()
            )
        except ConditionFailed:
            return None
        return GitlabConnection.model_validate(dict(item)) if item is not None else None

    def delete(self, workspace_id: str, connection_id: str) -> GitlabConnection | None:
        """Remove one connection, answering the row that was removed."""
        current = self.get(workspace_id, connection_id)
        if current is None:
            return None
        self._repository.delete(self._key(workspace_id, connection_id))
        return current
