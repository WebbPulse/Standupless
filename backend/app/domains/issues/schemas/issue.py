"""Request and response schemas for the issues domain.

Every list body is an object with one plural key beside `next_cursor`, matching the
M1 domains and the contract, which is what `webbpulse.http.cursor_page` builds.
Validation that needs no table read happens here, so a malformed body is a 422
naming the field; anything needing the team's estimate scale or its label set is
decided in the route, because the schema cannot read.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator
from webbpulse.http import cursor_page

from app.common.core.constants import ISSUE_BODY_MAX_BYTES
from app.common.db.dynamo.activity import Activity
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.relations import Relation

PriorityField = Literal["none", "urgent", "high", "medium", "low"]

LinkTypeField = Literal["blocks", "blocked_by", "relates_to", "duplicate_of"]

ActorKindField = Literal["user", "system", "github"]

ActivityKindField = Literal[
    "created",
    "field_changed",
    "link_added",
    "link_removed",
    "child_added",
    "child_removed",
]

SortField = Literal["updated_desc", "created_desc", "key_asc", "priority_desc", "due_asc", "manual"]

ISSUE_KEY_PATTERN = re.compile(r"^([A-Za-z][A-Za-z0-9]{1,5})-(\d+)$")

TITLE_MAX = 200

DEFAULT_LIMIT = 50

MAX_LIMIT = 100

BULK_MAX_ISSUES = 50
"""The most issues one bulk patch may name.

Every issue is validated before any is written, and each validation reads the
issue's team config, so the cap bounds one request's reads as well as its writes.
"""

SORT_ORDER_PATTERN = re.compile(r"^[0-9A-Za-z]{1,64}$")
"""A manual position: a short base 62 string, compared bytewise.

Fractional keys of this alphabet sort the same as strings in Python, in DynamoDB
and in JavaScript, which is what lets a client pick a key between two neighbours
and write one row rather than renumbering the list.
"""


def parse_issue_key(key: str) -> tuple[str, int] | None:
    """`ABC-123` as its prefix and number, or `None` when it is not a key.

    Case insensitive per the contract, and the prefix comes back uppercased so the
    lookup matches however the caller typed it.
    """
    match = ISSUE_KEY_PATTERN.match(key.strip())
    if match is None:
        return None
    return match.group(1).upper(), int(match.group(2))


def _check_body(value: Optional[str]) -> Optional[str]:
    """Hold a markdown body to the shared byte cap.

    Measured in UTF-8 bytes rather than characters, because the cap exists to keep
    the item well under DynamoDB's limit and it is the encoded length that counts.
    """
    if value is None:
        return None
    if len(value.encode("utf-8")) > ISSUE_BODY_MAX_BYTES:
        raise ValueError(f"body must be at most {ISSUE_BODY_MAX_BYTES} bytes")
    return value


def _check_date(value: Optional[str]) -> Optional[str]:
    """Hold a date field to `YYYY-MM-DD`, which is what the contract states."""
    if value is None:
        return None
    candidate = value.strip()
    if not candidate:
        return None
    try:
        date.fromisoformat(candidate)
    except ValueError as exc:
        raise ValueError("must be a YYYY-MM-DD date") from exc
    return candidate


def _check_sort_order(value: Optional[str]) -> Optional[str]:
    """Hold a manual position to the base 62 alphabet and its length cap."""
    if value is None:
        return None
    if not SORT_ORDER_PATTERN.match(value):
        raise ValueError("sort_order must be 1 to 64 characters of 0-9, A-Z and a-z")
    return value


def _check_order(start_date: Optional[str], due_date: Optional[str]) -> None:
    """Refuse a due date before the start date, when both are present."""
    if start_date and due_date and due_date < start_date:
        raise ValueError("due_date must not be before start_date")


class IssueCreate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/issues` takes.

    `team_id` is a field rather than a path segment because issues are workspace
    scoped, which is what lets a link and a "my issues" read cross teams.
    """

    team_id: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=TITLE_MAX)
    body: Optional[str] = None
    status_id: Optional[str] = None
    priority: PriorityField = "none"
    assignee_id: Optional[str] = None
    label_ids: list[str] = Field(default_factory=list)
    estimate: Optional[str] = None
    start_date: Optional[str] = None
    due_date: Optional[str] = None
    parent_id: Optional[str] = None
    cycle_id: Optional[str] = None
    project_id: Optional[str] = None
    sort_order: Optional[str] = None

    @field_validator("title")
    @classmethod
    def check_title(cls, value: str) -> str:
        """Reject a title that is only whitespace."""
        candidate = value.strip()
        if not candidate:
            raise ValueError("title must not be blank")
        return candidate

    @field_validator("body")
    @classmethod
    def check_body(cls, value: Optional[str]) -> Optional[str]:
        """Hold the body to the shared byte cap."""
        return _check_body(value)

    @field_validator("start_date", "due_date")
    @classmethod
    def check_dates(cls, value: Optional[str]) -> Optional[str]:
        """Hold both date fields to the contract's format."""
        return _check_date(value)

    @field_validator("sort_order")
    @classmethod
    def check_sort_order(cls, value: Optional[str]) -> Optional[str]:
        """Hold a manual position to the alphabet every client sorts the same way."""
        return _check_sort_order(value)

    @model_validator(mode="after")
    def check_date_order(self) -> "IssueCreate":
        """Refuse a due date before the start date."""
        _check_order(self.start_date, self.due_date)
        return self


class IssueUpdate(BaseModel):
    """The body an issue patch takes.

    `team_id` is absent by design: the contract makes it unchangeable, and an
    issue's key, counter and every index composite are derived from it.
    """

    title: Optional[str] = Field(default=None, min_length=1, max_length=TITLE_MAX)
    body: Optional[str] = None
    status_id: Optional[str] = None
    priority: Optional[PriorityField] = None
    assignee_id: Optional[str] = None
    label_ids: Optional[list[str]] = None
    estimate: Optional[str] = None
    start_date: Optional[str] = None
    due_date: Optional[str] = None
    parent_id: Optional[str] = None
    cycle_id: Optional[str] = None
    project_id: Optional[str] = None
    sort_order: Optional[str] = None

    @field_validator("title")
    @classmethod
    def check_title(cls, value: Optional[str]) -> Optional[str]:
        """Reject a title that is only whitespace."""
        if value is None:
            return None
        candidate = value.strip()
        if not candidate:
            raise ValueError("title must not be blank")
        return candidate

    @field_validator("body")
    @classmethod
    def check_body(cls, value: Optional[str]) -> Optional[str]:
        """Hold the body to the shared byte cap."""
        return _check_body(value)

    @field_validator("start_date", "due_date")
    @classmethod
    def check_dates(cls, value: Optional[str]) -> Optional[str]:
        """Hold both date fields to the contract's format."""
        return _check_date(value)

    @field_validator("sort_order")
    @classmethod
    def check_sort_order(cls, value: Optional[str]) -> Optional[str]:
        """Hold a manual position to the alphabet every client sorts the same way."""
        return _check_sort_order(value)


class ProgressRead(BaseModel):
    """An issue's direct-child rollup as the API returns it."""

    total: int = 0
    completed: int = 0


class IssueRead(BaseModel):
    """One issue as the API returns it."""

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
    cycle_id: Optional[str] = None
    project_id: Optional[str] = None
    sort_order: Optional[str] = None
    progress: ProgressRead
    blocked_by_open_count: int = 0
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
            cycle_id=issue.cycle_id,
            project_id=issue.project_id,
            sort_order=issue.sort_order,
            progress=ProgressRead(total=issue.progress.total, completed=issue.progress.completed),
            blocked_by_open_count=issue.blocked_by_open_count,
            created_by=issue.created_by,
            created_at=issue.created_at,
            updated_at=issue.updated_at,
        )


IssueListRead = cursor_page(IssueRead, "issues", model_name="IssueListRead")
"""The body every issue list route answers with, items under `issues`."""


class IssueBulkPatch(BaseModel):
    """The fields one bulk patch sets on every named issue.

    The triage fields only: a title, body or date is per issue by nature, so a bulk
    write of one would be a mistake rather than a shortcut. Labels are an add and a
    remove rather than a replacement, so tagging a selection keeps each issue's
    other labels.
    """

    status_id: Optional[str] = None
    assignee_id: Optional[str] = None
    priority: Optional[PriorityField] = None
    add_label_ids: list[str] = Field(default_factory=list)
    remove_label_ids: list[str] = Field(default_factory=list)
    project_id: Optional[str] = None
    cycle_id: Optional[str] = None
    estimate: Optional[str] = None

    @model_validator(mode="after")
    def check_labels_disjoint(self) -> "IssueBulkPatch":
        """Refuse a label both added and removed, which has no single meaning."""
        overlap = set(self.add_label_ids) & set(self.remove_label_ids)
        if overlap:
            raise ValueError("a label cannot be both added and removed")
        return self


class IssueBulkUpdate(BaseModel):
    """The body `PATCH /api/workspaces/{workspace_id}/issues` takes."""

    issue_ids: list[str] = Field(min_length=1, max_length=BULK_MAX_ISSUES)
    patch: IssueBulkPatch

    @field_validator("issue_ids")
    @classmethod
    def check_issue_ids(cls, value: list[str]) -> list[str]:
        """Drop repeats and blanks, keeping first-seen order.

        A repeat would otherwise be patched twice and record its activity twice.
        """
        kept = [issue_id for issue_id in dict.fromkeys(item.strip() for item in value) if issue_id]
        if not kept:
            raise ValueError("issue_ids must name at least one issue")
        return kept


class IssueBulkRead(BaseModel):
    """What a bulk patch answers with.

    `issues` is every named issue after the write, in request order. `skipped`
    names any issue deleted between validation and its write: validation is all
    or nothing, but the writes are separate puts, and a concurrent delete is the
    one failure that can land between them.
    """

    issues: list[IssueRead] = Field(default_factory=list)
    skipped: list[str] = Field(default_factory=list)


class LinkCreate(BaseModel):
    """The body a link create takes."""

    type: LinkTypeField
    target_issue_id: str = Field(min_length=1)


class LinkStatusRead(BaseModel):
    """The far side's status on a link, so a row can draw its glyph.

    Carried on the link because the far side may sit in another team, whose
    statuses the page showing this issue never loads.
    """

    id: str
    name: str
    category: str


class LinkRead(BaseModel):
    """One link as the API returns it, joined with the far side for display."""

    link_id: str
    issue_id: str
    type: str
    target_issue_id: str
    target_key: str
    target_title: str
    target_status: Optional[LinkStatusRead] = None
    created_by: str
    created_at: datetime

    @classmethod
    def from_row(
        cls, relation: Relation, target: Optional[Issue], status: Optional[LinkStatusRead] = None
    ) -> "LinkRead":
        """Build the response from a stored relation and the issue it points at.

        A target that has gone renders as blanks rather than dropping the link,
        because the row is the fact and a missing far side is worth seeing.
        """
        return cls(
            link_id=relation.link_id,
            issue_id=relation.issue_id,
            type=relation.relation_type,
            target_issue_id=relation.target_issue_id,
            target_key=target.key if target is not None else "",
            target_title=target.title if target is not None else "",
            target_status=status,
            created_by=relation.created_by,
            created_at=relation.created_at,
        )


class LinkListRead(BaseModel):
    """The body the links list route answers with, both directions together."""

    links: list[LinkRead]


class ActivityRead(BaseModel):
    """One activity row as the API returns it.

    `from` and `to` are the wire names the contract fixes, and `from` is a Python
    keyword, so both are aliased off the stored `from_value` and `to_value`.
    """

    activity_id: str
    issue_id: str
    actor_id: str
    actor_kind: ActorKindField
    kind: ActivityKindField
    field: Optional[str] = None
    from_: Any = Field(default=None, alias="from")
    to: Any = None
    created_at: datetime

    model_config = {"populate_by_name": True}

    @classmethod
    def from_row(cls, activity: Activity) -> "ActivityRead":
        """Build the response shape from a stored activity row."""
        return cls(
            activity_id=activity.activity_id,
            issue_id=activity.issue_id,
            actor_id=activity.actor_id,
            actor_kind=activity.actor_kind,  # pyright: ignore[reportArgumentType]
            kind=activity.kind,  # pyright: ignore[reportArgumentType]
            field=activity.field,
            **{"from": activity.from_value},
            to=activity.to_value,
            created_at=activity.created_at,
        )


ActivityListRead = cursor_page(ActivityRead, "activity", model_name="ActivityListRead")
"""The body the activity list route answers with, newest first, items under `activity`."""
