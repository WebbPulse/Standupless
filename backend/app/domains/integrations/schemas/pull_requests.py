"""Response bodies for pull request search, which the editor's `#` reference picker and its chips read."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

PULL_REQUEST_SEARCH_DEFAULT_LIMIT = 5

PULL_REQUEST_SEARCH_MAX_LIMIT = 20

PULL_REQUEST_QUERY_MIN = 1

PULL_REQUEST_QUERY_MAX = 128


class PullRequestHitRead(BaseModel):
    """One linked pull request matching a search, with the keys of the visible issues it links."""

    repository_full_name: str
    number: int
    title: str
    url: str
    state: Literal["open", "draft", "merged", "closed"]
    author_login: str
    issue_keys: list[str] = Field(default_factory=list)
    updated_at: datetime


class PullRequestSearchRead(BaseModel):
    """The linked pull requests matching a search, exact references first and then newest first, capped."""

    pull_requests: list[PullRequestHitRead] = Field(default_factory=list)
