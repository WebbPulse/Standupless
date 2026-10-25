"""Request and response schemas for the board, saved views, search and the inbox.

The issue shape is spelled here rather than imported from the `issues` domain
because each image imports only its own domain, which is what keeps the `views`
function free of the issue write path and its cold start proportional to what it
serves. The shape is the M2 one unchanged, and the route contract fixture is what
holds the two in step.

The saved view and inbox schemas live in `app.common.api.schemas.views`, shared
with the MCP tools, and are re-exported here so the routes keep one import path.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field
from webbpulse.http import cursor_page

from app.common.api.schemas.documents import DocumentSummaryRead
from app.common.api.schemas.views import (
    DISPLAY_SWITCHES,
    FILTER_FIELDS,
    INBOX_DEFAULT_LIMIT,
    INBOX_MAX_LIMIT,
    INBOX_READ_MAX_IDS,
    SCALAR_FILTER_FIELDS,
    VIEW_NAME_MAX,
    VISIBLE_PROPERTIES,
    GroupByField,
    InboxClearRequest,
    InboxClearResult,
    InboxCountRead,
    InboxListRead,
    InboxReadRequest,
    InboxReadResult,
    InboxSnoozeRequest,
    InboxUnreadRequest,
    IssueReminderListRead,
    IssueReminderRead,
    IssueReminderWrite,
    LayoutField,
    NotificationKindField,
    NotificationRead,
    ScopeField,
    SortField,
    ViewCreate,
    ViewEntityField,
    ViewKindField,
    ViewListRead,
    ViewRead,
    ViewUpdate,
    VisiblePropertyField,
    malformed_filter_keys,
    normalize_filter,
    unknown_filter_keys,
)
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import Status
from app.common.issue_rules import TRIAGE_STATUS_CATEGORY, TRIAGE_STATUS_NAME

__all__ = [
    "BOARD_DEFAULT_COLUMN_LIMIT",
    "BOARD_MAX_COLUMN_LIMIT",
    "BOARD_TOTAL_CAP",
    "BoardColumn",
    "BoardColumnRead",
    "BoardRead",
    "DISPLAY_SWITCHES",
    "FILTER_FIELDS",
    "GroupByField",
    "INBOX_DEFAULT_LIMIT",
    "INBOX_MAX_LIMIT",
    "INBOX_READ_MAX_IDS",
    "InboxClearRequest",
    "InboxClearResult",
    "InboxCountRead",
    "InboxListRead",
    "InboxReadRequest",
    "InboxReadResult",
    "InboxSnoozeRequest",
    "InboxUnreadRequest",
    "IssueRead",
    "IssueReminderListRead",
    "IssueReminderRead",
    "IssueReminderWrite",
    "LayoutField",
    "malformed_filter_keys",
    "normalize_filter",
    "NotificationKindField",
    "NotificationRead",
    "PriorityField",
    "ProgressRead",
    "SCALAR_FILTER_FIELDS",
    "ScopeField",
    "SEARCH_DEFAULT_LIMIT",
    "SEARCH_MAX_LIMIT",
    "SEARCH_QUERY_MAX",
    "SEARCH_QUERY_MIN",
    "SEARCH_TYPES",
    "SearchCommentRead",
    "SearchInitiativeRead",
    "SearchProjectRead",
    "SearchRead",
    "SearchResultRead",
    "SearchTypeField",
    "SimilarIssueRead",
    "SimilarListRead",
    "SortField",
    "status_sort_key",
    "unknown_filter_keys",
    "VIEW_NAME_MAX",
    "ViewCreate",
    "ViewEntityField",
    "ViewKindField",
    "ViewListRead",
    "ViewRead",
    "ViewUpdate",
    "VISIBLE_PROPERTIES",
    "VisiblePropertyField",
]

PriorityField = Literal["none", "urgent", "high", "medium", "low"]

BOARD_DEFAULT_COLUMN_LIMIT = 50

BOARD_MAX_COLUMN_LIMIT = 100

BOARD_TOTAL_CAP = 1000

SEARCH_DEFAULT_LIMIT = 20

SEARCH_MAX_LIMIT = 50

SEARCH_QUERY_MIN = 2

SEARCH_QUERY_MAX = 128

SearchTypeField = Literal["issues", "projects", "initiatives", "documents", "comments"]

SEARCH_TYPES: tuple[SearchTypeField, ...] = ("issues", "projects", "initiatives", "documents", "comments")
"""Every kind of result search answers, which is also what an absent `type` filter asks for."""


class ProgressRead(BaseModel):
    """An issue's direct-child rollup as the API returns it."""

    total: int = 0
    completed: int = 0


class IssueRead(BaseModel):
    """One issue as the board and the column route return it, the M2 shape."""

    id: str
    workspace_id: str
    team_id: str
    key: str
    number: int
    title: str
    body: Optional[str] = None
    status_id: str
    priority: PriorityField
    assignee_id: Optional[str] = None
    label_ids: list[str] = Field(default_factory=list)
    estimate: Optional[str] = None
    start_date: Optional[str] = None
    due_date: Optional[str] = None
    parent_id: Optional[str] = None
    sort_order: Optional[str] = None
    progress: ProgressRead
    created_by: str
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, issue: Issue) -> "IssueRead":
        """Build the response shape from a stored issue row."""
        return cls(
            id=issue.issue_id,
            workspace_id=issue.workspace_id,
            team_id=issue.team_id,
            key=issue.key,
            number=issue.number,
            title=issue.title,
            body=issue.body,
            status_id=issue.status_id,
            priority=issue.priority,  # pyright: ignore[reportArgumentType]
            assignee_id=issue.assignee_id,
            label_ids=list(issue.label_ids),
            estimate=issue.estimate,
            start_date=issue.start_date,
            due_date=issue.due_date,
            parent_id=issue.parent_id,
            sort_order=issue.sort_order,
            progress=ProgressRead(total=issue.progress.total, completed=issue.progress.completed),
            created_by=issue.created_by,
            created_at=issue.created_at,
            updated_at=issue.updated_at,
        )


class BoardColumn(BaseModel):
    """One board column: a status, the issues in it, and how to read more."""

    status_id: str
    name: str
    category: str
    position: int
    color: Optional[str] = None
    icon: Optional[str] = None
    issues: list[IssueRead] = Field(default_factory=list)
    total: int = 0
    next_cursor: Optional[str] = None


class BoardRead(BaseModel):
    """A whole board: one column per status of the team, in position order."""

    team_id: str
    columns: list[BoardColumn] = Field(default_factory=list)


BoardColumnRead = cursor_page(IssueRead, "issues", model_name="BoardColumnRead")
"""The body the single column route answers with, items under `issues`."""


class SearchResultRead(BaseModel):
    """One search hit: enough of an issue to render a row with its status, plus its score.

    The status fields name the issue's status as its team configures it, or the
    triage status's name and category while it waits there, so a row renders its icon
    without a read of every team's workflow.
    """

    issue_id: str
    key: str
    title: str
    team_id: str
    status_id: str
    status_name: Optional[str] = None
    status_category: Optional[str] = None
    status_color: Optional[str] = None
    status_icon: Optional[str] = None
    assignee_id: Optional[str] = None
    priority: Optional[str] = None
    updated_at: datetime
    score: int

    @classmethod
    def from_row(cls, issue: Issue, score: int, status: Optional[Status] = None) -> "SearchResultRead":
        """Build one hit from the issue it points at, its status and its matched term count."""
        if issue.in_triage:
            name, category = TRIAGE_STATUS_NAME, TRIAGE_STATUS_CATEGORY
            color = icon = None
        else:
            name = status.name if status else None
            category = status.category if status else None
            color = status.color if status else None
            icon = status.icon if status else None
        return cls(
            issue_id=issue.issue_id,
            key=issue.key,
            title=issue.title,
            team_id=issue.team_id,
            status_id=issue.status_id,
            status_name=name,
            status_category=category,
            status_color=color,
            status_icon=icon,
            assignee_id=issue.assignee_id,
            priority=issue.priority,
            updated_at=issue.updated_at,
            score=score,
        )


class SearchProjectRead(BaseModel):
    """One project whose name or description holds every term, with the teams the caller sees on it."""

    project_id: str
    name: str
    status: str
    status_id: str = Field(default="", description="The workspace project status the project sits in")
    health: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    lead_id: Optional[str] = None
    team_ids: list[str] = Field(default_factory=list)
    target_date: Optional[str] = None
    updated_at: datetime


class SearchInitiativeRead(BaseModel):
    """One initiative whose name or description holds every term."""

    initiative_id: str
    name: str
    status: str
    health: Optional[str] = None
    owner_id: Optional[str] = None
    target_date: Optional[str] = None
    updated_at: datetime


class SearchCommentRead(BaseModel):
    """One comment whose body holds every term, with its issue or document and an excerpt around the first match.

    A comment on a document carries `document_id` and `document_title`, its
    `issue_id` is the document id, and its issue key, title and team are empty.
    """

    comment_id: str
    issue_id: str
    issue_key: str
    issue_title: str
    team_id: str
    author_id: str
    snippet: str
    created_at: datetime
    document_id: Optional[str] = None
    document_title: Optional[str] = None


class SearchRead(BaseModel):
    """Every search hit, grouped by kind and ranked within each. No cursor, per the contract.

    `documents`, `projects` and `initiatives` are answered for a caller allowed to
    read projects, and only for a workspace-wide search, except that a search
    narrowed to one team still answers the projects that team is on. `comments`
    link to the comment rather than only its issue.
    """

    results: list[SearchResultRead] = Field(default_factory=list)
    documents: list[DocumentSummaryRead] = Field(default_factory=list)
    projects: list[SearchProjectRead] = Field(default_factory=list)
    initiatives: list[SearchInitiativeRead] = Field(default_factory=list)
    comments: list[SearchCommentRead] = Field(default_factory=list)


class SimilarIssueRead(BaseModel):
    """One possible duplicate of a draft title: enough to render a row and open it."""

    issue_id: str
    key: str
    title: str
    team_id: str
    status_id: str
    status_name: Optional[str] = None
    status_category: Optional[str] = None
    status_color: Optional[str] = None
    status_icon: Optional[str] = None
    score: int


class SimilarListRead(BaseModel):
    """The possible duplicates of a draft title, best match first, capped rather than paged."""

    results: list[SimilarIssueRead] = Field(default_factory=list)


def status_sort_key(row: Status) -> tuple[int, str]:
    """The order statuses render in: position first, the id breaking a tie.

    The same order `TeamConfigRepository.list_statuses` already applies, spelled
    here so the board route and the column route cannot drift from it: a tie broken
    differently would reorder a board between two reads.
    """
    return (row.position, row.status_id)
