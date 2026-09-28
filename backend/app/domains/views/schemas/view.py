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
    InboxCountRead,
    InboxListRead,
    InboxReadRequest,
    InboxReadResult,
    InboxSnoozeRequest,
    InboxUnreadRequest,
    LayoutField,
    NotificationKindField,
    NotificationRead,
    ScopeField,
    SortField,
    ViewCreate,
    ViewKindField,
    ViewListRead,
    ViewRead,
    ViewUpdate,
    VisiblePropertyField,
    malformed_filter_keys,
    unknown_filter_keys,
)
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import Status

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
    "InboxCountRead",
    "InboxListRead",
    "InboxReadRequest",
    "InboxReadResult",
    "InboxSnoozeRequest",
    "InboxUnreadRequest",
    "IssueRead",
    "LayoutField",
    "malformed_filter_keys",
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
    "SearchRead",
    "SearchResultRead",
    "SortField",
    "status_sort_key",
    "unknown_filter_keys",
    "VIEW_NAME_MAX",
    "ViewCreate",
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
    """One search hit: enough of an issue to render a row, plus its score."""

    issue_id: str
    key: str
    title: str
    team_id: str
    status_id: str
    assignee_id: Optional[str] = None
    updated_at: datetime
    score: int

    @classmethod
    def from_row(cls, issue: Issue, score: int) -> "SearchResultRead":
        """Build one hit from the issue it points at and its matched term count."""
        return cls(
            issue_id=issue.issue_id,
            key=issue.key,
            title=issue.title,
            team_id=issue.team_id,
            status_id=issue.status_id,
            assignee_id=issue.assignee_id,
            updated_at=issue.updated_at,
            score=score,
        )


class SearchRead(BaseModel):
    """Every search hit, ranked. No cursor, per the contract."""

    results: list[SearchResultRead] = Field(default_factory=list)


def status_sort_key(row: Status) -> tuple[int, str]:
    """The order statuses render in: position first, the id breaking a tie.

    The same order `TeamConfigRepository.list_statuses` already applies, spelled
    here so the board route and the column route cannot drift from it: a tie broken
    differently would reorder a board between two reads.
    """
    return (row.position, row.status_id)
