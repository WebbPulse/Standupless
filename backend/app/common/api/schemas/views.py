"""Request and response schemas for saved views and the inbox, shared by the views routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and a tool that saves a view or snoozes a notification must validate exactly
what the route validates. A saved view's filter is judged against a fixed field
set, so an unknown key is a 422 naming the key rather than a view that silently
widens when a field is renamed.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Any, Literal, Mapping, Optional, Sequence, Union, get_args

from pydantic import BaseModel, Field, StrictBool, StringConstraints, field_validator
from webbpulse.http import cursor_page

from app.common.api.schemas.projects_display import ProjectsDisplay, stored_projects_display
from app.common.change_source import ChangeSource
from app.common.db.dynamo.inbox import Notification
from app.common.db.dynamo.planning import PROJECT_STATUSES
from app.common.db.dynamo.views import SavedView
from app.common.inbox_summary import notification_summary

SortField = Literal[
    "updated_desc",
    "created_desc",
    "key_asc",
    "priority_desc",
    "due_asc",
    "sla_asc",
    "manual",
    "status_asc",
    "start_asc",
    "estimate_desc",
    "customer_requests_desc",
    "customer_important_desc",
    "customer_revenue_desc",
    "completed_desc",
    "links_desc",
]

ViewKindField = Literal["list", "board"]

ViewEntityField = Literal["issues", "projects"]
"""What a view lists: issues, the default every view saved before project views reads as, or projects."""

VIEW_ENTITIES: tuple[str, ...] = get_args(ViewEntityField)

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
    "milestone",
    "links",
    "created_at",
    "updated_at",
    "time_in_status",
    "release",
    "sla",
    "customers",
    "customer_revenue",
]
"""The row properties a view may show, a fixed set so a client never meets one it cannot render."""

CompletedWindowField = Literal["all", "past_week", "past_month", "none"]
"""How many completed and cancelled issues a view shows: all, those finished in the last week or month, or none."""

COMPLETED_WINDOWS: tuple[str, ...] = get_args(CompletedWindowField)

GroupHeaderField = Literal["count", "estimate"]
"""What a view's group headers read beside each group's name: the issue count or the total estimate."""

GROUP_HEADERS: tuple[str, ...] = get_args(GroupHeaderField)


def group_header_of(value: Optional[str]) -> GroupHeaderField:
    """The group header a stored row reads as, the issue count when it predates the choice."""
    return "estimate" if value == "estimate" else "count"


PROJECT_STATUS_ID_PATTERN = re.compile(r"^[0-9A-Z]{26}$")
"""The shape of a workspace project status id a view's status filter may name beside a category."""


def completed_window_of(window: Optional[str], show_completed: Optional[bool]) -> CompletedWindowField:
    """The window a stored view shows, read from `show_completed` when it predates the window."""
    if window == "past_week":
        return "past_week"
    if window == "past_month":
        return "past_month"
    if window == "none" or (window is None and show_completed is False):
        return "none"
    return "all"


GroupByProperty = Literal[
    "status",
    "assignee",
    "priority",
    "label",
    "milestone",
    "project",
    "cycle",
    "parent",
    "team",
    "sla",
    "customer",
    "release",
]
"""The properties a view may group or sub-group its rows by."""

GROUP_BY_PROPERTIES: tuple[str, ...] = get_args(GroupByProperty)

LABEL_GROUP_GROUPING_PATTERN = r"^label_group:[0-9A-Za-z_-]{1,64}$"
"""A grouping by one label group, `label_group:` then the group label's id."""

LabelGroupGrouping = Annotated[str, StringConstraints(pattern=LABEL_GROUP_GROUPING_PATTERN)]

GroupByField = Union[GroupByProperty, LabelGroupGrouping]
"""What a view may group or sub-group its rows by: a property, or one label group."""


def grouping_pattern(*extra: str) -> str:
    """A regular expression matching every grouping, and any extra choices, for a tool schema."""
    choices = "|".join((*GROUP_BY_PROPERTIES, *extra))
    return rf"^(?:{choices}|label_group:[0-9A-Za-z_-]{{1,64}})$"


ScopeField = Literal["mine", "team", "workspace", "all"]

NotificationKindField = Literal[
    "assigned",
    "mentioned",
    "commented",
    "status_changed",
    "subscribed",
    "project_update",
    "project_update_comment",
    "project_update_due",
    "initiative_update_due",
    "due_soon",
    "overdue",
    "standup_digest",
    "sla_at_risk",
    "sla_breached",
    "reminder",
    "triage_new",
    "view_issue_added",
    "reaction",
    "issue_completed",
    "issue_cancelled",
    "priority_urgent",
    "blocking_changed",
    "document_comment",
    "team_issue_created",
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
        "is_blocked",
        "is_blocking",
        "has_relation",
        "subscriber_id_not",
        "label_id_all",
        "parent_id_not",
        "has_sub_issues",
        "content",
        "content_not",
        "completed_after",
        "completed_before",
        "customer_id",
        "customer_id_not",
        "release_id",
        "release_id_not",
        "match",
        "groups",
    }
)
"""Every key a saved view's filter may carry, which is the issue list's own set.

Fixed rather than open because a saved view is run by expanding it into the issue
list query, and a key the list does not accept would be a filter that silently
does nothing.
"""

PROJECT_FILTER_FIELDS: frozenset[str] = frozenset(
    {
        "team_id",
        "status",
        "lead_id",
        "sub_teams",
        "is_blocked",
        "is_blocking",
        "customer_id",
        "customer_id_not",
        "label_id",
    }
)
"""Every key a project view's filter may carry, the projects page's own filters.

`team_id` is the one team the page is narrowed to, `status` the project statuses
it keeps, `lead_id` the leads it keeps, `none` standing for projects with no lead,
and `sub_teams` whether a parent team's page rolls up its sub-teams. `is_blocked`
keeps projects an open blocker holds up, or with `false` the ones none does, and
`is_blocking` open projects that hold another up, or with `false` the rest.
`customer_id` and `customer_id_not` the customers whose requests it keeps or
drops, `none` standing for projects no customer asked for. `label_id` the
project labels it keeps, `none` standing for projects with no label.
"""

PROJECT_FLAG_FILTER_FIELDS: frozenset[str] = frozenset({"sub_teams", "is_blocked", "is_blocking"})
"""The project filter keys that hold `true` or `false`."""

PROJECT_SCALAR_FILTER_FIELDS: frozenset[str] = frozenset({"team_id", *PROJECT_FLAG_FILTER_FIELDS})
"""The project filter keys that hold one value rather than a list."""

VIEW_NAME_MAX = 80

VIEW_DESCRIPTION_MAX = 500

VIEW_ICON_MAX = 32

ViewColorField = Literal["gray", "red", "orange", "yellow", "green", "teal", "blue", "indigo", "purple", "pink"]
"""The colors a view's icon may take, a fixed palette so every theme can render it."""

INBOX_DEFAULT_LIMIT = 50

INBOX_MAX_LIMIT = 100

INBOX_READ_MAX_IDS = 100

INBOX_CLEAR_MAX_KINDS = 50


SCALAR_FILTER_FIELDS: frozenset[str] = frozenset(
    {
        "team_id",
        "due_before",
        "due_after",
        "created_after",
        "created_before",
        "updated_after",
        "updated_before",
        "q",
        "is_blocked",
        "is_blocking",
        "has_sub_issues",
        "content",
        "content_not",
        "completed_after",
        "completed_before",
        "match",
    }
)
"""The filter keys the issue list takes once, so a stored list for one would not run."""

BOOLEAN_FILTER_FIELDS: frozenset[str] = frozenset({"is_blocked", "is_blocking", "has_sub_issues"})
"""The scalar filter keys that hold `true` or `false`, stored as text like every other value."""

MATCH_VALUES: tuple[str, ...] = ("all", "any")
"""How a filter or one of its groups combines its conditions."""

GROUP_FORBIDDEN_FIELDS: frozenset[str] = frozenset({"team_id", "q"})
"""Filter keys a condition group may not carry: the scope and the search box belong to the whole filter."""

MAX_FILTER_GROUPS = 10
"""The most condition groups one stored filter, or one group, carries."""

MAX_GROUP_DEPTH = 2
"""How deep stored groups nest, the issue list's own bound."""


def normalize_filter(value: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """A filter with each boolean key's JSON `true` or `false` stored as the text the list takes.

    A saved view stores every value as text because it is run by expanding it into
    query parameters, but an agent naturally sends a JSON boolean, so both spellings
    are accepted and stored the same way, groups included.
    """
    if value is None:
        return None
    normalized = {key: _normalized_entry(str(key), entry) for key, entry in value.items()}
    if isinstance(normalized.get("sub_teams"), bool):
        normalized["sub_teams"] = "true" if normalized["sub_teams"] else "false"
    groups = normalized.get("groups")
    if isinstance(groups, list):
        normalized["groups"] = [normalize_filter(group) if isinstance(group, dict) else group for group in groups]
    return normalized


def _normalized_entry(key: str, entry: Any) -> Any:
    """One filter value with a boolean key's bool, or its upper cased text, turned into `true` or `false`."""
    if key not in BOOLEAN_FILTER_FIELDS:
        return entry
    if isinstance(entry, bool):
        return "true" if entry else "false"
    if isinstance(entry, str) and entry.strip().lower() in ("true", "false"):
        return entry.strip().lower()
    return entry


def malformed_filter_keys(value: Mapping[str, Any] | None) -> list[str]:
    """Every filter key whose value the issue list could not take.

    A repeatable key holds a string or a list of strings, a scalar key a string
    and a boolean key `true` or `false`, because the view is run by expanding each
    value into query parameters. `match` is `all` or `any`, and `groups` a list of
    condition objects held to the same rules, each without a scope or a search and
    nesting two levels at most; a bad key inside a group is named `groups`. Checked beside
    the unknown keys and answered the same way, as `INVALID_FILTER`.
    """
    if not value:
        return []
    bad: list[str] = []
    for key, entry in value.items():
        if str(key) == "groups":
            if entry is not None and not _groups_well_formed(entry):
                bad.append("groups")
            continue
        if not _entry_well_formed(str(key), entry):
            bad.append(str(key))
    return sorted(bad)


def _entry_well_formed(key: str, entry: Any) -> bool:
    """Whether one filter value has the shape its key takes."""
    if entry is None:
        return True
    if key in BOOLEAN_FILTER_FIELDS:
        return entry in ("true", "false")
    if key == "match":
        return entry in MATCH_VALUES
    if isinstance(entry, str):
        return True
    repeatable = key not in SCALAR_FILTER_FIELDS
    return repeatable and isinstance(entry, list) and all(isinstance(item, str) for item in entry)


def _groups_well_formed(entry: Any, depth: int = 1) -> bool:
    """Whether a stored `groups` value is a short list of well formed conditions, nested no deeper than allowed."""
    if not isinstance(entry, list) or len(entry) > MAX_FILTER_GROUPS:
        return False
    for group in entry:
        if not isinstance(group, dict):
            return False
        for key, item in group.items():
            name = str(key)
            if name == "groups":
                if item is not None and (depth >= MAX_GROUP_DEPTH or not _groups_well_formed(item, depth + 1)):
                    return False
                continue
            if name not in FILTER_FIELDS or name in GROUP_FORBIDDEN_FIELDS or not _entry_well_formed(name, item):
                return False
    return True


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


def invalid_project_filter_keys(value: Mapping[str, Any] | None) -> list[str]:
    """Every key of a project view's filter that is unknown or holds a value the projects page cannot apply.

    A status must be a category or a workspace project status id, and `sub_teams`, `is_blocked`
    and `is_blocking` `true` or `false`, so a stored view never names a filter the
    page would quietly drop.
    """
    if not value:
        return []
    bad: list[str] = []
    for key, entry in value.items():
        name = str(key)
        if name not in PROJECT_FILTER_FIELDS or not _project_entry_well_formed(name, entry):
            bad.append(name)
    return sorted(bad)


def _project_entry_well_formed(key: str, entry: Any) -> bool:
    """Whether one project filter value has the shape its key takes."""
    if entry is None:
        return True
    if key in PROJECT_FLAG_FILTER_FIELDS:
        return entry in ("true", "false")
    values = [entry] if isinstance(entry, str) else entry
    if not isinstance(values, list) or not all(isinstance(item, str) and item for item in values):
        return False
    if key in PROJECT_SCALAR_FILTER_FIELDS and not isinstance(entry, str):
        return False
    if key == "status":
        return all(item in PROJECT_STATUSES or PROJECT_STATUS_ID_PATTERN.match(item) for item in values)
    return True


VISIBLE_PROPERTIES: tuple[str, ...] = get_args(VisiblePropertyField)


SLA_HIDDEN = "-sla"
"""The stored marker of a property list that hides the SLA badge, never seen by a client.

Every list saved before `sla` became a property showed the badge, so a stored
list holding neither `sla` nor this marker reads back with `sla` on.
"""


def stored_visible_properties(value: Optional[Sequence[str]]) -> Optional[list[str]]:
    """The property list as it is stored, marking a list without `sla` as one that hides the badge."""
    if value is None:
        return None
    shown = [item for item in value if item != SLA_HIDDEN]
    return shown if "sla" in shown else [*shown, SLA_HIDDEN]


def read_visible_properties(stored: Optional[Sequence[str]]) -> Optional[list[str]]:
    """The property list a client reads from a stored one, with `sla` on for a list saved before it existed."""
    if stored is None:
        return None
    if SLA_HIDDEN in stored:
        return [item for item in stored if item != SLA_HIDDEN]
    return list(stored) if "sla" in stored else [*stored, "sla"]


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
    the view under the whole workspace. `entity` set to `projects` saves a projects
    page arrangement: its filter takes the projects page's keys and
    `projects_display` its layout, grouping, ordering and completed window, while
    the issue display fields are ignored.
    """

    name: str = Field(min_length=1, max_length=VIEW_NAME_MAX)
    entity: ViewEntityField = "issues"
    kind: ViewKindField = "list"
    filter: dict[str, Any] = Field(default_factory=dict)
    sort: SortField = "updated_desc"
    group_by: Optional[GroupByField] = None
    sub_group_by: Optional[GroupByField] = None
    ordering: Optional[SortField] = None
    ordering_reversed: StrictBool = False
    visible_properties: Optional[list[VisiblePropertyField]] = Field(default=None, max_length=len(VISIBLE_PROPERTIES))
    layout: Optional[LayoutField] = None
    show_sub_issues: StrictBool = True
    show_completed: StrictBool = True
    completed_window: Optional[CompletedWindowField] = None
    show_archived: StrictBool = False
    group_header: GroupHeaderField = "count"
    projects_display: Optional[ProjectsDisplay] = None
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

    @field_validator("filter")
    @classmethod
    def normalize_booleans(cls, value: dict[str, Any]) -> dict[str, Any]:
        """Store a boolean filter sent as JSON `true` or `false` as the text the list takes."""
        return normalize_filter(value) or {}


class ViewUpdate(BaseModel):
    """The body a saved view patch takes, every field optional.

    `kind` and `team_id` are not patchable: the team decides the sort key the
    row is filed under, so moving it would be a delete and a create wearing the name
    of an update. `shared` is the one exception, for a view without a team: it
    moves a personal view to the whole workspace or back, which refiles the row
    under the same view id. `entity` is fixed at create, and `projects_display`
    applies only to a project view.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=VIEW_NAME_MAX)
    filter: Optional[dict[str, Any]] = None
    sort: Optional[SortField] = None
    group_by: Optional[GroupByField] = None
    sub_group_by: Optional[GroupByField] = None
    ordering: Optional[SortField] = None
    ordering_reversed: Optional[StrictBool] = None
    visible_properties: Optional[list[VisiblePropertyField]] = Field(default=None, max_length=len(VISIBLE_PROPERTIES))
    layout: Optional[LayoutField] = None
    show_sub_issues: Optional[StrictBool] = None
    show_completed: Optional[StrictBool] = None
    completed_window: Optional[CompletedWindowField] = None
    show_archived: Optional[StrictBool] = None
    group_header: Optional[GroupHeaderField] = None
    projects_display: Optional[ProjectsDisplay] = None
    icon: Optional[str] = Field(default=None, min_length=1, max_length=VIEW_ICON_MAX)
    color: Optional[ViewColorField] = None
    description: Optional[str] = Field(default=None, max_length=VIEW_DESCRIPTION_MAX)
    shared: Optional[StrictBool] = None

    @field_validator("visible_properties")
    @classmethod
    def check_visible_properties(cls, value: Optional[list[str]]) -> Optional[list[str]]:
        """Drop repeats, keeping the order the caller chose to show them in."""
        return _unique(value)

    @field_validator("filter")
    @classmethod
    def normalize_booleans(cls, value: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
        """Store a boolean filter sent as JSON `true` or `false` as the text the list takes."""
        return normalize_filter(value)


DISPLAY_SWITCHES: tuple[str, ...] = (
    "ordering_reversed",
    "show_sub_issues",
    "show_completed",
    "completed_window",
    "show_archived",
    "group_header",
)
"""The view's display switches, which a patch may set but never clear to null."""


class ViewRead(BaseModel):
    """One saved view as the API returns it.

    `favorite` is the caller's own star, not a property of the view, so the same
    view reads differently to two members, and so is `subscribed`, whether the
    caller follows the view to hear about issues entering it. `subscriber_count`
    is how many members follow it. `projects_display` is the arrangement of
    a project view and null on an issue view.
    """

    view_id: str
    workspace_id: str
    name: str
    entity: ViewEntityField = "issues"
    kind: str
    scope: str
    team_id: Optional[str] = None
    filter: dict[str, Any] = Field(default_factory=dict)
    sort: str
    group_by: Optional[str] = None
    sub_group_by: Optional[str] = None
    ordering: Optional[str] = None
    ordering_reversed: bool = False
    visible_properties: Optional[list[str]] = None
    layout: str
    show_sub_issues: bool = True
    show_completed: bool = True
    completed_window: CompletedWindowField = "all"
    show_archived: bool = False
    group_header: GroupHeaderField = "count"
    projects_display: Optional[ProjectsDisplay] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    description: Optional[str] = None
    favorite: bool = False
    subscribed: bool = False
    subscriber_count: int = 0
    owner_id: str
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(
        cls, view: SavedView, *, favorite: bool = False, subscribed: bool = False, subscriber_count: int = 0
    ) -> "ViewRead":
        """Build the response shape from a stored view row."""
        return cls(
            view_id=view.view_id,
            workspace_id=view.workspace_id,
            name=view.name,
            entity="projects" if view.lists_projects else "issues",
            kind=view.kind,
            scope=view.scope,
            team_id=view.team_id,
            filter=dict(view.filter),
            sort=view.sort,
            group_by=view.group_by,
            sub_group_by=view.sub_group_by,
            ordering=view.ordering,
            ordering_reversed=view.ordering_reversed is True,
            visible_properties=read_visible_properties(view.visible_properties),
            layout=view.layout or view.kind,
            show_sub_issues=view.show_sub_issues is not False,
            show_completed=view.show_completed is not False,
            completed_window=completed_window_of(view.completed_window, view.show_completed),
            show_archived=view.show_archived is True,
            group_header=group_header_of(view.group_header),
            projects_display=stored_projects_display(view.projects_display) if view.lists_projects else None,
            icon=view.icon,
            color=view.color,
            description=view.description,
            favorite=favorite,
            subscribed=subscribed,
            subscriber_count=subscriber_count,
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


DueStateField = Literal["due", "overdue"]


def _due_state(value: Optional[str]) -> Optional[DueStateField]:
    """A stored reminder stage as the contract's literal, or `None` for any other row."""
    if value == "due":
        return "due"
    if value == "overdue":
        return "overdue"
    return None


class NotificationRead(BaseModel):
    """One inbox row as the API returns it.

    A `project_update` notification names its project and update and leaves the
    issue fields empty, and a `project_update_comment` one also names the reply in
    `comment_id`. A `standup_digest` carries the team key in `issue_key`,
    the team name in `issue_title` and the digest date in `standup_date`. A
    `review_requested` notification carries the pull request's `owner/repo#number`
    in `issue_key`, its title in `issue_title` and its GitHub address in `url`.
    An `initiative_update_due` reminder names its initiative, carries an empty
    `team_id` and says in `due_state` whether the update is due or overdue.
    `summary` is the line the row reads, naming who acted and, for a status change,
    the status it moved to, which `new_value` also carries on its own. A
    `document_comment` names its document in `document_id` and `document_title`
    and the comment in `comment_id`, with the issue fields and `team_id` empty.
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
    initiative_id: Optional[str] = None
    initiative_name: Optional[str] = None
    due_state: Optional[DueStateField] = None
    standup_date: Optional[str] = None
    url: Optional[str] = None
    new_value: Optional[str] = None
    document_id: Optional[str] = None
    document_title: Optional[str] = None
    summary: str = ""
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
            initiative_id=notification.initiative_id,
            initiative_name=notification.initiative_name,
            due_state=_due_state(notification.due_state),
            standup_date=notification.standup_date,
            url=notification.url,
            new_value=notification.new_value,
            document_id=notification.document_id,
            document_title=notification.document_title,
            summary=notification_summary(notification),
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


InboxBucket = Literal["all", "priority", "other"]
"""Which tab of the split inbox a read or bulk action covers: both, Priority or Other."""


class InboxCountRead(BaseModel):
    """The unread badge, counted from the sparse index and capped.

    `unread` counts everything. `priority_unread` and `other_unread` count each
    tab of the split inbox by the caller's own priority kinds, and `badge` is
    the number the sidebar shows: Priority alone while `priority_inbox` is on.
    """

    unread: int = 0
    priority_unread: int = 0
    other_unread: int = 0
    priority_inbox: bool = True
    badge: int = 0


class InboxReadRequest(BaseModel):
    """The body a mark-read takes: either a list of ids or the whole inbox.

    `kinds` narrows `all` to those notification kinds, matching the list's filter,
    so marking everything read under a filter leaves the hidden types alone.
    `bucket` narrows `all` to one tab of the split inbox in the same way.
    """

    notification_ids: Optional[list[str]] = Field(default=None, min_length=1, max_length=INBOX_READ_MAX_IDS)
    all: bool = False
    kinds: list[str] = Field(default_factory=list, max_length=INBOX_CLEAR_MAX_KINDS)
    bucket: InboxBucket = "all"


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


class InboxClearRequest(BaseModel):
    """The body a bulk delete takes: which of the caller's notifications to remove.

    `read_only` keeps to rows already read. Without it every row goes except those
    still snoozed, unless `include_snoozed` takes them too. `completed_only` keeps to
    rows about an issue now in a completed or cancelled status, read or not. `kinds`
    keeps to those notification kinds, matching the list's filter, and `bucket` to one
    tab of the split inbox.
    """

    read_only: bool = False
    include_snoozed: bool = False
    completed_only: bool = False
    kinds: list[str] = Field(default_factory=list, max_length=INBOX_CLEAR_MAX_KINDS)
    bucket: InboxBucket = "all"


class InboxClearResult(BaseModel):
    """How many notifications a bulk delete removed."""

    deleted: int = 0


class IssueReminderWrite(BaseModel):
    """The body setting a reminder takes: the moment the caller wants to hear about the issue again.

    `remind_at` must carry a timezone, so the moment is the one the caller picked
    on their own clock rather than one the server guessed.
    """

    remind_at: datetime

    @field_validator("remind_at")
    @classmethod
    def _aware(cls, value: datetime) -> datetime:
        """Refuse a naive moment rather than guessing its zone."""
        if value.tzinfo is None:
            raise ValueError("remind_at must include a timezone")
        return value


class IssueReminderRead(BaseModel):
    """One pending reminder of the caller's, with the issue it is about as it reads now."""

    issue_id: str
    issue_key: str
    issue_title: str
    team_id: str
    remind_at: datetime
    created_at: datetime


class IssueReminderListRead(BaseModel):
    """The caller's pending reminders, soonest first."""

    reminders: list[IssueReminderRead] = Field(default_factory=list)
