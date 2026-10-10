"""Response schemas for the workspace home, one aggregate read for the landing page.

Held in `common` beside the other read shapes so the route and any later tool
answer the same body.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

from app.common.api.schemas.issues import IssueRead
from app.common.api.schemas.planning import CycleRead, ProjectRead, ProjectUpdateRead
from app.common.api.schemas.views import NotificationRead

FocusReason = Literal["overdue", "due_soon", "sla_breached", "sla_at_risk", "blocked"]
"""Why an open issue assigned to the caller needs attention now."""


class HomeAttentionItem(BaseModel):
    """One assigned issue that needs attention, with every reason that applies."""

    issue: IssueRead
    reasons: list[FocusReason]


class HomeFocusRead(BaseModel):
    """The caller's open assigned work, split into what needs attention, what is started and what is next.

    Each issue appears in one group only, attention first. The counts are the
    whole group, and the lists are the first few of it.
    """

    open_count: int
    truncated: bool = False
    attention_count: int
    in_progress_count: int
    up_next_count: int
    attention: list[HomeAttentionItem] = Field(default_factory=list)
    in_progress: list[IssueRead] = Field(default_factory=list)
    up_next: list[IssueRead] = Field(default_factory=list)


class HomeShippedItem(BaseModel):
    """One issue that moved into a completed status in the window, and who is credited."""

    issue: IssueRead
    completed_at: datetime
    completed_by: Optional[str] = None


class HomeShippedRead(BaseModel):
    """Issues completed on the caller's teams in the window, newest first."""

    since: datetime
    count: int
    mine: int
    items: list[HomeShippedItem] = Field(default_factory=list)


class HomePulseItem(BaseModel):
    """The newest update of one project, named so the line reads without a lookup."""

    project_id: str
    project_name: str
    update: ProjectUpdateRead


class HomeInboxRead(BaseModel):
    """The caller's unread count, capped like the inbox badge, and the newest unread rows."""

    unread_count: int
    items: list[NotificationRead] = Field(default_factory=list)


class HomeRead(BaseModel):
    """Everything the workspace home draws, read in one request.

    `team_ids` is the scope the team sections were read over: the caller's own
    teams, or every team they can see when they belong to none.
    """

    generated_at: datetime
    today: str
    team_ids: list[str]
    focus: HomeFocusRead
    cycles: list[CycleRead] = Field(default_factory=list)
    projects: list[ProjectRead] = Field(default_factory=list)
    projects_total: int = 0
    shipped: HomeShippedRead
    pulse: list[HomePulseItem] = Field(default_factory=list)
    inbox: HomeInboxRead
