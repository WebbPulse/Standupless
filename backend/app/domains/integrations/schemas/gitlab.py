"""Request and response bodies for a workspace's GitLab connections.

No response carries the access token or the webhook secret's digest. The token is
named only by its last four characters, and the webhook secret appears once, in
the answer to the request that made it, because only its digest is kept.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class GitlabConnectionWrite(BaseModel):
    """What a workspace admin enters to connect one GitLab group or project.

    `instance_url` is empty for gitlab.com and the https address of a self-managed
    instance otherwise. `access_token` needs only the `read_api` scope.
    """

    instance_url: str = Field(default="", max_length=512)
    scope_kind: Literal["group", "project"]
    scope_path: str = Field(min_length=1, max_length=255)
    access_token: str = Field(min_length=1, max_length=512, repr=False)


class GitlabConnectionRead(BaseModel):
    """One GitLab group or project this workspace receives merge request events from.

    `webhook_url` is the address to add as a merge request webhook in GitLab.
    """

    connection_id: str
    instance_url: str
    scope_kind: Literal["group", "project"]
    scope_id: str
    scope_path: str
    scope_name: str
    web_url: str
    token_hint: str
    webhook_url: str
    connected_by: str
    connected_at: datetime
    secret_rotated_at: datetime | None = None


class GitlabConnectionCreated(GitlabConnectionRead):
    """A connection just made or whose webhook secret was just replaced, with that secret shown once."""

    webhook_secret: str


class GitlabConnectionsRead(BaseModel):
    """Whether GitLab can be connected in this environment, and this workspace's connections."""

    configured: bool
    connections: list[GitlabConnectionRead]
