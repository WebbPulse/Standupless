"""Request and response schemas for saved views and the inbox, shared by the views routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and a tool that saves a view or snoozes a notification must validate exactly
what the route validates. A saved view's filter is judged against a fixed field
set, so an unknown key is a 422 naming the key rather than a view that silently
widens when a field is renamed.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Mapping, Optional, get_args

from pydantic import BaseModel, Field, StrictBool, field_validator
from webbpulse.http import cursor_page

from app.common.change_source import ChangeSource
from app.common.db.dynamo.inbox import Notification
from app.common.db.dynamo.views import SavedView

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
    "pull_requests",
    "created_at",
    "updated_at",
]
"""The row properties a view may show, a fixed set so a client never meets one it cannot render."""

GroupByField = Literal["status", "assignee", "priority", "label", "milestone"]

ScopeField = Literal["mine", "team", "workspace", "all"]

NotificationKindField = Literal[
    "assigned",
    "mentioned",
    "commented",
    "status_changed",
    "project_update",
    "project_update_due",
    "due_soon",
    "overdue",
    "standup_digest",
    "sla_at_risk",
    "sla_breached",
]

FILTER_FIELDS: frozenset[str] = frozenset(
    {
        "team_id",
        "team_id_in",
        "team_id_not",
        "created_after",
        "created_before",
        "updated_after",
        "updated_before",
        "status_id",
        "status_category",
        "assignee_id",
        "creator_id",
        "subscriber_id",
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
        "creator_id_not",
        "label_id_not",
        "priority_not",
        "cycle_id_not",
        "project_id_not",
        "project_milestone_id",
        "project_milestone_id_not",
        "estimate",
        "estimate_not",
        "sla_status",
    }
)
"""Every key a saved view's filter may carry, which is the issue list's own set.

Fixed rather than open because a saved view is run by expanding it into the issue
list query, and a key the list does not accept would be a filter that silently
does nothing.
"""

VIEW_NAME_MAX = 80

VIEW_DESCRIPTION_MAX = 500

VIEW_ICON_MAX = 32

ViewColorField = Literal["gray", "red", "orange", "yellow", "green", "teal", "blue", "indigo", "purple", "pink"]
"""The colors a view's icon may take, a fixed palette so every theme can render it."""

INBOX_DEFAULT_LIMIT = 50

INBOX_MAX_LIMIT = 100

INBOX_READ_MAX_IDS = 100


SCALAR_FILTER_FIELDS: frozenset[str] = frozenset(
    {
        "team_id",
        "subscriber_id",
        "due_before",
        "due_after",
        "created_after",
        "created_before",
        "updated_after",
        "updated_before",
        "q",
    }
)
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


VISIBLE_PROPERTIES: tuple[str, ...] = get_args(VisiblePropertyField)


def _unique(value: Optional[list[str]]) -> Optional[list[str]]:
    """A list with repeats dropped and first-seen order kept."""
    if value is None:
        return None
    return list(dict.fromkeys(value))


class ViewCreate(BaseModel):
    """The body a saved view create takes.

    `owner_id` and `scope` are absent on purpose: the owner comes from the
    authorization context and the scope is derived from `team_id` and `shared`,
    so neither is something a caller can assert. `shared` without a team files
    the view under the whole workspace.
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
    show_sub_issues: StrictBool = True
    show_completed: StrictBool = True
    show_archived: StrictBool = False
    icon: Optional[str] = Field(default=None, min_length=1, max_length=VIEW_ICON_MAX)
    color: Optional[ViewColorField] = None
    description: Optional[str] = Field(default=None, max_length=VIEW_DESCRIPTION_MAX)
    team_id: Optional[str] = None
    shared: StrictBool = False

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
    show_sub_issues: Optional[StrictBool] = None
    show_completed: Optional[StrictBool] = None
    show_archived: Optional[StrictBool] = None
    icon: Optional[str] = Field(default=None, min_length=1, max_length=VIEW_ICON_MAX)
    color: Optional[ViewColorField] = None
    description: Optional[str] = Field(default=None, max_length=VIEW_DESCRIPTION_MAX)

    @field_validator("visible_properties")
    @classmethod
    def check_visible_properties(cls, value: Optional[list[str]]) -> Optional[list[str]]:
        """Drop repeats, keeping the order the caller chose to show them in."""
        return _unique(value)


DISPLAY_SWITCHES: tuple[str, ...] = ("show_sub_issues", "show_completed", "show_archived")
"""The view's boolean display switches, which a patch may set but never clear to null."""


class ViewRead(BaseModel):
    """One saved view as the API returns it.

    `favorite` is the caller's own star, not a property of the view, so the same
    view reads differently to two members.
    """

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
    show_sub_issues: bool = True
    show_completed: bool = True
    show_archived: bool = False
    icon: Optional[str] = None
    color: Optional[str] = None
    description: Optional[str] = None
    favorite: bool = False
    owner_id: str
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, view: SavedView, *, favorite: bool = False) -> "ViewRead":
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
            show_sub_issues=view.show_sub_issues is not False,
            show_completed=view.show_completed is not False,
            show_archived=view.show_archived is True,
            icon=view.icon,
            color=view.color,
            description=view.description,
            favorite=favorite,
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


class NotificationRead(BaseModel):
    """One inbox row as the API returns it.

    A `project_update` notification names its project and update and leaves the
    issue fields empty. A `standup_digest` carries the team key in `issue_key`,
    the team name in `issue_title` and the digest date in `standup_date`.
    """

    notification_id: str
    workspace_id: str
    kind: str
    issue_id: str
    issue_key: str
    issue_title: str
    team_id: str
    comment_id: Optional[str] = None
    project_id: Optional[str] = None
    project_name: Optional[str] = None
    project_update_id: Optional[str] = None
    standup_date: Optional[str] = None
    actor_id: str
    actor_name: str
    source: Optional[ChangeSource] = None
    unread: bool
    snoozed_until: Optional[datetime] = None
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
            project_id=notification.project_id,
            project_name=notification.project_name,
            project_update_id=notification.project_update_id,
            standup_date=notification.standup_date,
            actor_id=notification.actor_id,
            actor_name=notification.actor_name,
            source=notification.source,  # pyright: ignore[reportArgumentType]
            unread=notification.unread,
            snoozed_until=(
                datetime.fromisoformat(notification.snoozed_until)
                if notification.snoozed() and notification.snoozed_until
                else None
            ),
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


class InboxUnreadRequest(BaseModel):
    """The body a mark-unread takes: the ids to bring back as unread."""

    notification_ids: list[str] = Field(min_length=1, max_length=INBOX_READ_MAX_IDS)


class InboxSnoozeRequest(BaseModel):
    """The body a snooze takes: the ids to hide and the moment they come back.

    `until` must carry a timezone, so the moment a notification returns does not
    depend on where the server happens to run.
    """

    notification_ids: list[str] = Field(min_length=1, max_length=INBOX_READ_MAX_IDS)
    until: datetime

    @field_validator("until")
    @classmethod
    def _aware(cls, value: datetime) -> datetime:
        """Refuse a naive moment rather than guessing its zone."""
        if value.tzinfo is None:
            raise ValueError("until must include a timezone")
        return value


class InboxReadResult(BaseModel):
    """How many notifications a mark-read actually moved."""

    updated: int = 0
