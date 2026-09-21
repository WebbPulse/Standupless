"""Request and response schemas for share links and the anonymous read.

Two families live here and the split between them is the security boundary this
project rests on.

`ShareLinkRead` and `ShareLinkCreated` are what a member sees in settings. They
carry ids, because the caller is inside the workspace and already holds them.

`SharedTarget`, `SharedIssue` and `SharedIssueSummary` are what an anonymous
reader sees. They carry no workspace id, no team id, no issue id, no user id
and no email: a person holding a token learns the contents of one row and nothing
that would let them ask for a second. The shapes are declared separately rather
than derived from the member ones with fields excluded, so adding a field to an
internal model can never widen a public response.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field

from app.common.db.dynamo.share_links import ShareLinkView

TargetTypeField = Literal["issue", "view"]

PriorityField = Literal["none", "urgent", "high", "medium", "low"]

MAX_LINKS_PER_WORKSPACE = 200

MIN_EXPIRY_DAYS = 1

MAX_EXPIRY_DAYS = 365


class ShareLinkCreate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/share-links` takes."""

    target_type: TargetTypeField
    target_id: str = Field(min_length=1)
    expires_in_days: Optional[int] = Field(default=None, ge=MIN_EXPIRY_DAYS, le=MAX_EXPIRY_DAYS)


class ShareLinkRead(BaseModel):
    """One share link as the settings list renders it. Carries no live token.

    `url` here is the path with no token on it. A list that carried live tokens
    would make the list itself a credential, so the token appears only on the
    create response.
    """

    token_hash: str
    target_type: TargetTypeField
    target_id: str
    team_id: str
    title: str
    created_by: str
    created_at: datetime
    expires_at: Optional[datetime] = None
    revoked_at: Optional[datetime] = None
    url: str

    @classmethod
    def from_row(cls, row: ShareLinkView, *, url: str) -> "ShareLinkRead":
        """Team a stored row onto the response, with the composed URL.

        The URL is composed on the server so the settings page does not have to
        know the frontend origin, which differs between staging and production and
        would otherwise be a second place that mapping lives.
        """
        return cls(
            token_hash=row.token_hash,
            target_type="view" if row.target_type == "view" else "issue",
            target_id=row.target_id,
            team_id=row.team_id,
            title=row.title,
            created_by=row.created_by,
            created_at=row.created_at,
            expires_at=_as_datetime(row.expires_at),
            revoked_at=row.revoked_at,
            url=url,
        )


class ShareLinkCreated(ShareLinkRead):
    """The one response that carries the plaintext token.

    `url` on this response carries the token, because it is the thing a person
    copies. Every other response carries the tokenless path.
    """

    token: str


class ShareLinkListRead(BaseModel):
    """The list envelope, one plural key, per the contract's list shape."""

    share_links: list[ShareLinkRead]


class SharedTarget(BaseModel):
    """What the first anonymous read answers: enough to render a heading.

    No ids at all. The reader's client learns which of the two follow-up reads to
    make and what to put in the page title, and nothing that is useful anywhere
    else in the API.
    """

    target_type: TargetTypeField
    title: str
    workspace_name: str
    team_name: str
    shared_at: datetime


class SharedStatus(BaseModel):
    """A status as a public reader sees it: its display, never its id."""

    name: str
    category: str
    color: str


class SharedLabel(BaseModel):
    """A label as a public reader sees it: its display, never its id."""

    name: str
    color: str


class SharedComment(BaseModel):
    """One comment on a shared issue.

    `author_name` is a display name and never a user id or an email, so a share
    cannot be used to harvest the membership of the workspace it came from.
    """

    author_name: str
    body: str
    created_at: datetime


class SharedIssue(BaseModel):
    """One shared issue, in full, bounded by the one row the token resolved.

    No sub-issues, no linked issues, no activity and no attachment URLs. Each of
    those would reach a second row, and the token grants exactly one.
    """

    issue_key: str
    title: str
    body: str
    status: Optional[SharedStatus] = None
    priority: PriorityField
    labels: list[SharedLabel] = Field(default_factory=list)
    estimate: Optional[float] = None
    start_date: Optional[date] = None
    due_date: Optional[date] = None
    assignee_name: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    comments: list[SharedComment] = Field(default_factory=list)


class SharedIssueSummary(BaseModel):
    """One row of a shared view's listing. The summary fields and nothing else."""

    issue_key: str
    title: str
    status: Optional[SharedStatus] = None
    priority: PriorityField
    assignee_name: Optional[str] = None
    updated_at: datetime


class SharedViewPage(BaseModel):
    """A page of a shared view's issues, with the cursor for the next one."""

    issues: list[SharedIssueSummary]
    next_cursor: Optional[str] = None


def _as_datetime(stamp: int) -> Optional[datetime]:
    """A TTL stamp as an instant, or `None` for a link that does not expire."""
    if not stamp:
        return None
    return datetime.fromtimestamp(stamp, tz=timezone.utc)
