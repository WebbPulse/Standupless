"""Response schemas for the member page: one person's profile and recent activity.

Held in `common` so the views route and any later tool answer the same body. The
profile never carries an email address, because the page is readable by every
member of the workspace.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field
from webbpulse.http import cursor_page

from app.common.api.schemas.issues import ActivityRead
from app.common.api.schemas.member_status import UserStatusRead
from app.common.api.schemas.workspaces import WorkspaceRoleField

MemberActivityType = Literal["issue_change", "comment"]
"""Whether one entry of a member's feed is a change to an issue or a comment on one."""


class MemberProfileRead(BaseModel):
    """One workspace member as their page shows them.

    `team_ids` are the teams they belong to that the caller can see, so a private
    team stays hidden from anyone outside it. `user_status` is their away status
    while it is in force, hidden from a guest who shares no team with them.
    `timezone` is the IANA zone they set in their preferences, so a hover card
    can show their local time; it follows the same rule as `user_status`, and is
    null when they set none. No other preference is exposed.
    """

    user_id: str
    display_name: str
    full_name: str = ""
    avatar_url: Optional[str] = None
    role: WorkspaceRoleField
    joined_at: datetime
    team_ids: list[str] = Field(default_factory=list)
    user_status: Optional[UserStatusRead] = None
    timezone: Optional[str] = None


class MemberCommentRead(BaseModel):
    """The comment one feed entry is, cut to an excerpt."""

    comment_id: str
    body: str
    parent_comment_id: Optional[str] = None


class MemberActivityRead(BaseModel):
    """One entry of a member's feed: a change they made or a comment they wrote.

    Exactly one of `activity` and `comment` is set, as `type` says. The issue it
    belongs to is named so the feed renders without a read per row.
    """

    type: MemberActivityType
    id: str
    created_at: datetime
    issue_id: str
    issue_key: str
    issue_title: str
    team_id: str
    activity: Optional[ActivityRead] = None
    comment: Optional[MemberCommentRead] = None


MemberActivityListRead = cursor_page(MemberActivityRead, "activity", model_name="MemberActivityListRead")
"""The body the member activity route answers with, newest first, items under `activity`."""
