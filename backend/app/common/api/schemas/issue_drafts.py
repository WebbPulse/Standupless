"""Request and response schemas for new issue drafts, shared by the drafts routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code. A draft holds every field of the create dialog, bounded generously enough
that whatever was typed is kept, including a title still over the issue cap, so
saving never loses text. Filing the issue is what holds the fields to an
issue's own rules.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal, Optional, Union

from pydantic import BaseModel, Field, StrictBool, StrictStr, field_validator, model_validator

from app.common.core.constants import ISSUE_BODY_MAX_BYTES
from app.common.db.dynamo.views import IssueDraft

DRAFT_ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
"""What a draft id may be, so a client can name a new draft before its first save."""

DRAFT_TEXT_MAX = 1000
"""The longest title, template title or sub-issue title a draft keeps."""

DRAFT_LIST_MAX = 100
"""The most labels, answers or sub-issues a draft keeps."""

ANSWER_MAX = 10000
"""The longest single form answer a draft keeps."""

DraftPriority = Literal["none", "urgent", "high", "medium", "low"]

Identifier = Optional[str]


def _check_bytes(value: str, name: str) -> str:
    """Hold Markdown to the issue body byte cap."""
    if len(value.encode("utf-8")) > ISSUE_BODY_MAX_BYTES:
        raise ValueError(f"{name} must be at most {ISSUE_BODY_MAX_BYTES} bytes")
    return value


class IssueDraftWrite(BaseModel):
    """Everything a draft save takes, which replaces whatever the draft held.

    A draft with no title, description, sub-issue or answer is refused, since
    discarding is the delete route's job.
    """

    team_id: str = Field(min_length=1, max_length=64)
    title: str = Field(default="", max_length=DRAFT_TEXT_MAX)
    body: str = ""
    template_id: Identifier = Field(default=None, max_length=64)
    template_title: str = Field(default="", max_length=DRAFT_TEXT_MAX)
    template_body: str = ""
    answers: dict[str, Union[StrictBool, StrictStr]] = Field(default_factory=dict, max_length=DRAFT_LIST_MAX)
    status_id: Identifier = Field(default=None, max_length=64)
    priority: DraftPriority = "none"
    assignee_id: Identifier = Field(default=None, max_length=64)
    label_ids: list[str] = Field(default_factory=list, max_length=DRAFT_LIST_MAX)
    estimate: Optional[str] = Field(default=None, max_length=16)
    project_id: Identifier = Field(default=None, max_length=64)
    project_milestone_id: Identifier = Field(default=None, max_length=64)
    cycle_id: Identifier = Field(default=None, max_length=64)
    start_date: Optional[date] = None
    due_date: Optional[date] = None
    parent_id: Identifier = Field(default=None, max_length=64)
    parent_key: Optional[str] = Field(default=None, max_length=64)
    parent_title: Optional[str] = Field(default=None, max_length=DRAFT_TEXT_MAX)
    sub_issues: list[str] = Field(default_factory=list, max_length=DRAFT_LIST_MAX)

    @field_validator("body")
    @classmethod
    def check_body(cls, value: str) -> str:
        """Hold the description to the issue body byte cap."""
        return _check_bytes(value, "body")

    @field_validator("template_body")
    @classmethod
    def check_template_body(cls, value: str) -> str:
        """Hold the template's description to the issue body byte cap."""
        return _check_bytes(value, "template_body")

    @field_validator("answers")
    @classmethod
    def check_answers(cls, value: dict[str, Union[bool, str]]) -> dict[str, Union[bool, str]]:
        """Bound each answer's question id and text."""
        for key, answer in value.items():
            if not key or len(key) > 64:
                raise ValueError("each answer must be keyed by a question id of at most 64 characters")
            if isinstance(answer, str) and len(answer) > ANSWER_MAX:
                raise ValueError(f"each answer must be at most {ANSWER_MAX} characters")
        return value

    @field_validator("label_ids")
    @classmethod
    def check_label_ids(cls, value: list[str]) -> list[str]:
        """Bound each label id, keeping the order they were picked in."""
        if any(not label or len(label) > 64 for label in value):
            raise ValueError("each label id must be 1 to 64 characters")
        return list(dict.fromkeys(value))

    @field_validator("sub_issues")
    @classmethod
    def check_sub_issues(cls, value: list[str]) -> list[str]:
        """Bound each sub-issue title and drop the blank rows."""
        if any(len(row) > DRAFT_TEXT_MAX for row in value):
            raise ValueError(f"each sub-issue must be at most {DRAFT_TEXT_MAX} characters")
        return [row for row in value if row.strip()]

    @model_validator(mode="after")
    def check_content(self) -> IssueDraftWrite:
        """Refuse a draft that holds nothing typed."""
        typed = (
            self.title.strip()
            or self.body.strip()
            or self.sub_issues
            or any(answer is True or (isinstance(answer, str) and answer.strip()) for answer in self.answers.values())
        )
        if not typed:
            raise ValueError("a draft needs a title, a description, a sub-issue or an answer")
        return self


class IssueDraftRead(BaseModel):
    """One of the caller's new issue drafts, with every field the create dialog held."""

    draft_id: str
    team_id: str
    title: str
    body: str
    template_id: Optional[str] = None
    template_title: str = ""
    template_body: str = ""
    answers: dict[str, Union[StrictBool, StrictStr]] = Field(default_factory=dict)
    status_id: Optional[str] = None
    priority: str = "none"
    assignee_id: Optional[str] = None
    label_ids: list[str] = Field(default_factory=list)
    estimate: Optional[str] = None
    project_id: Optional[str] = None
    project_milestone_id: Optional[str] = None
    cycle_id: Optional[str] = None
    start_date: Optional[date] = None
    due_date: Optional[date] = None
    parent_id: Optional[str] = None
    parent_key: Optional[str] = None
    parent_title: Optional[str] = None
    sub_issues: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row: IssueDraft) -> IssueDraftRead:
        """The response shape of one stored draft."""
        return cls(
            draft_id=row.draft_id,
            team_id=row.team_id,
            title=row.title,
            body=row.body,
            template_id=row.template_id,
            template_title=row.template_title,
            template_body=row.template_body,
            answers=dict(row.answers),
            status_id=row.status_id,
            priority=row.priority,
            assignee_id=row.assignee_id,
            label_ids=list(row.label_ids),
            estimate=row.estimate,
            project_id=row.project_id,
            project_milestone_id=row.project_milestone_id,
            cycle_id=row.cycle_id,
            start_date=date.fromisoformat(row.start_date) if row.start_date else None,
            due_date=date.fromisoformat(row.due_date) if row.due_date else None,
            parent_id=row.parent_id,
            parent_key=row.parent_key,
            parent_title=row.parent_title,
            sub_issues=list(row.sub_issues),
            created_at=row.created_at,
            updated_at=row.updated_at,
        )


class IssueDraftListRead(BaseModel):
    """The caller's new issue drafts, newest saved first, with the most they may keep."""

    drafts: list[IssueDraftRead]
    limit: int
