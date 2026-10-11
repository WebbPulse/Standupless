"""Response bodies for the Reviews list, the pull requests waiting on the caller as a reviewer."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

ReviewGroup = Literal["needs_review", "changes_requested", "approved"]
"""Where a pull request sits for the caller: asked to review, sent back for changes, or approved."""

REVIEW_GROUPS: tuple[str, ...] = ("needs_review", "changes_requested", "approved")


class ReviewIssueRead(BaseModel):
    """One issue a listed pull request links, among those the caller can see."""

    issue_id: str
    key: str
    title: str
    team_id: str


class ReviewItemRead(BaseModel):
    """One pull request on the caller's Reviews list."""

    repository_id: str
    repository_full_name: str
    number: int
    title: str
    url: str
    author_login: str
    state: Literal["open", "draft"]
    group: ReviewGroup
    review_state: str
    ci_state: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    issues: list[ReviewIssueRead] = Field(default_factory=list)


class ReviewCountsRead(BaseModel):
    """How many pull requests sit in each group."""

    needs_review: int = 0
    changes_requested: int = 0
    approved: int = 0


class ReviewsRead(BaseModel):
    """The caller's Reviews list, grouped in the order the page draws it.

    `github_linked` is false when the caller has linked no GitHub account, which is
    the one reason the list can be empty while reviews exist on GitHub.
    """

    github_linked: bool
    counts: ReviewCountsRead
    items: list[ReviewItemRead]
