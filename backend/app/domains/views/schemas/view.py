"""Request and response schemas for the board, saved views, search and the inbox.

The issue shape is spelled here rather than imported from the `issues` domain
because each image imports only its own domain, which is what keeps the `views`
function free of the issue write path and its cold start proportional to what it
serves. The shape is the M2 one unchanged, and the route contract fixture is what
holds the two in step.

Validation that needs no table read happens here. A saved view's filter is judged
against a fixed field set, so an unknown key is a 422 naming the key rather than a
view that silently widens when a field is renamed.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Mapping, Optional, get_args

from pydantic import BaseModel, Field, field_validator
from webbpulse.http import cursor_page

from app.common.db.dynamo.inbox import Notification
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import Status
from app.common.db.dynamo.views import SavedView

PriorityField = Literal["none", "urgent", "high", "medium", "low"]

SortField = Literal["updated_desc", "created_desc", "key_asc", "priority_desc", "due_asc", "manual"]

ViewKindField = Literal["list", "board"]

LayoutField = Literal["list", "board"]

VisiblePropertyField = Literal[
    "id",
    "status",
    "priority",
    "assignee",
    "labels",
    "estimate",
    "start_date",
    "due_date",
    "project",
    "cycle",
    "parent",
    "sub_issues",
    "created_at",
    "updated_at",
]
"""The row properties a view may show, a fixed set so a client never meets one it cannot render."""

GroupByField = Literal["status", "assignee", "priority", "label"]

ScopeField = Literal["mine", "team", "all"]

NotificationKindField = Literal["assigned", "mentioned", "commented", "status_changed"]

FILTER_FIELDS: frozenset[str] = frozenset(
    {
        "team_id",
        "status_id",
        "status_category",
        "assignee_id",
        "label_id",
        "priority",
        "parent_id",
        "cycle_id",
        "project_id",
        "due_before",
        "due_after",
        "q",
        "status_id_not",
        "status_category_not",
        "assignee_id_not",
        "label_id_not",
        "priority_not",
        "cycle_id_not",
        "project_id_not",
    }
)
"""Every key a saved view's filter may carry, which is the issue list's own set.

Fixed rather than open because a saved view is run by expanding it into the issue
list query, and a key the list does not accept would be a filter that silently
does nothing.
"""

VIEW_NAME_MAX = 80

BOARD_DEFAULT_COLUMN_LIMIT = 50

BOARD_MAX_COLUMN_LIMIT = 100

BOARD_TOTAL_CAP = 1000

INBOX_DEFAULT_LIMIT = 50

INBOX_MAX_LIMIT = 100

INBOX_READ_MAX_IDS = 100

SEARCH_DEFAULT_LIMIT = 20

SEARCH_MAX_LIMIT = 50

SEARCH_QUERY_MIN = 2

SEARCH_QUERY_MAX = 128


SCALAR_FILTER_FIELDS: frozenset[str] = frozenset({"team_id", "due_before", "due_after", "q"})
"""The filter keys the issue list takes once, so a stored list for one would not run."""


def malformed_filter_keys(value: Mapping[str, Any] | None) -> list[str]:
    """Every filter key whose value the issue list could not take.

    A repeatable key holds a string or a list of strings, and a scalar key a
    string, because the view is run by expanding each value into query parameters.
    Checked beside the unknown keys and answered the same way, as `INVALID_FILTER`.
    """
    if not value:
        return []
    bad: list[str] = []
    for key, entry in value.items():
        if entry is None or isinstance(entry, str):
            continue
        repeatable = str(key) not in SCALAR_FILTER_FIELDS
        if repeatable and isinstance(entry, list) and all(isinstance(item, str) for item in entry):
            continue
        bad.append(str(key))
    return sorted(bad)


def unknown_filter_keys(value: Mapping[str, Any] | None) -> list[str]:
    """Every key of a saved view's filter that falls outside the accepted set.

    Answered rather than raised, and checked in the route rather than in a pydantic
    validator, because the contract fixes this failure as a 422 carrying
    `INVALID_FILTER`. A validator would make it one of pydantic's own validation
    errors instead, which renders a different body and would lose the code.
    """
    if not value:
        return []
    return sorted(str(key) for key in value if str(key) not in FILTER_FIELDS)


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


VISIBLE_PROPERTIES: tuple[str, ...] = get_args(VisiblePropertyField)


def _unique(value: Optional[list[str]]) -> Optional[list[str]]:
    """A list with repeats dropped and first-seen order kept."""
    if value is None:
        return None
    return list(dict.fromkeys(value))


class ViewCreate(BaseModel):
    """The body a saved view create takes.

    `owner_id` and `scope` are absent on purpose: the owner comes from the
    authorization context and the scope is derived from `team_id`, so neither is
    something a caller can assert.
    """

    name: str = Field(min_length=1, max_length=VIEW_NAME_MAX)
    kind: ViewKindField = "list"
    filter: dict[str, Any] = Field(default_factory=dict)
    sort: SortField = "updated_desc"
    group_by: Optional[GroupByField] = None
    sub_group_by: Optional[GroupByField] = None
    ordering: Optional[SortField] = None
    visible_properties: Optional[list[VisiblePropertyField]] = Field(default=None, max_length=len(VISIBLE_PROPERTIES))
    layout: Optional[LayoutField] = None
    team_id: Optional[str] = None

    @field_validator("visible_properties")
    @classmethod
    def check_visible_properties(cls, value: Optional[list[str]]) -> Optional[list[str]]:
        """Drop repeats, keeping the order the caller chose to show them in."""
        return _unique(value)


class ViewUpdate(BaseModel):
    """The body a saved view patch takes, every field optional.

    `kind` and `team_id` are not patchable: the team decides the sort key the
    row is filed under, so moving it would be a delete and a create wearing the name
    of an update.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=VIEW_NAME_MAX)
    filter: Optional[dict[str, Any]] = None
    sort: Optional[SortField] = None
    group_by: Optional[GroupByField] = None
    sub_group_by: Optional[GroupByField] = None
    ordering: Optional[SortField] = None
    visible_properties: Optional[list[VisiblePropertyField]] = Field(default=None, max_length=len(VISIBLE_PROPERTIES))
    layout: Optional[LayoutField] = None

    @field_validator("visible_properties")
    @classmethod
    def check_visible_properties(cls, value: Optional[list[str]]) -> Optional[list[str]]:
        """Drop repeats, keeping the order the caller chose to show them in."""
        return _unique(value)


class ViewRead(BaseModel):
    """One saved view as the API returns it."""

    view_id: str
    workspace_id: str
    name: str
    kind: str
    scope: str
    team_id: Optional[str] = None
    filter: dict[str, Any] = Field(default_factory=dict)
    sort: str
    group_by: Optional[str] = None
    sub_group_by: Optional[str] = None
    ordering: Optional[str] = None
    visible_properties: Optional[list[str]] = None
    layout: str
    owner_id: str
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, view: SavedView) -> "ViewRead":
        """Build the response shape from a stored view row."""
        return cls(
            view_id=view.view_id,
            workspace_id=view.workspace_id,
            name=view.name,
            kind=view.kind,
            scope=view.scope,
            team_id=view.team_id,
            filter=dict(view.filter),
            sort=view.sort,
            group_by=view.group_by,
            sub_group_by=view.sub_group_by,
            ordering=view.ordering,
            visible_properties=list(view.visible_properties) if view.visible_properties is not None else None,
            layout=view.layout or view.kind,
            owner_id=view.owner_id,
            created_at=view.created_at,
            updated_at=view.updated_at,
        )


class ViewListRead(BaseModel):
    """Every saved view a listing answers with.

    No cursor: a member's own views and a team's views are both small by nature,
    and a cursor would be a page boundary over two merged partitions.
    """

    views: list[ViewRead] = Field(default_factory=list)


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


class NotificationRead(BaseModel):
    """One inbox row as the API returns it."""

    notification_id: str
    workspace_id: str
    kind: str
    issue_id: str
    issue_key: str
    issue_title: str
    team_id: str
    comment_id: Optional[str] = None
    actor_id: str
    actor_name: str
    unread: bool
    created_at: datetime
    expires_at: int

    @classmethod
    def from_row(cls, notification: Notification) -> "NotificationRead":
        """Build the response shape from a stored notification row."""
        return cls(
            notification_id=notification.notification_id,
            workspace_id=notification.workspace_id,
            kind=notification.kind,
            issue_id=notification.issue_id,
            issue_key=notification.issue_key,
            issue_title=notification.issue_title,
            team_id=notification.team_id,
            comment_id=notification.comment_id,
            actor_id=notification.actor_id,
            actor_name=notification.actor_name,
            unread=notification.unread,
            created_at=notification.created_at,
            expires_at=notification.expires_at,
        )


InboxListRead = cursor_page(NotificationRead, "notifications", model_name="InboxListRead")
"""The body the inbox list answers with, items under `notifications`."""


class InboxCountRead(BaseModel):
    """The unread badge, counted from the sparse index and capped."""

    unread: int = 0


class InboxReadRequest(BaseModel):
    """The body a mark-read takes: either a list of ids or the whole inbox."""

    notification_ids: Optional[list[str]] = Field(default=None, min_length=1, max_length=INBOX_READ_MAX_IDS)
    all: bool = False


class InboxReadResult(BaseModel):
    """How many notifications a mark-read actually moved."""

    updated: int = 0


def status_sort_key(row: Status) -> tuple[int, str]:
    """The order statuses render in: position first, the id breaking a tie.

    The same order `TeamConfigRepository.list_statuses` already applies, spelled
    here so the board route and the column route cannot drift from it: a tie broken
    differently would reorder a board between two reads.
    """
    return (row.position, row.status_id)
