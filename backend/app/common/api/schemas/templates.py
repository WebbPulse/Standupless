"""Request and response schemas for issue, project and document templates.

A template is a name and the issue fields it fills, every one optional, because
a template that only sets the labels is as useful as one that fills everything.
A project template, `kind` "project", instead carries `project`: the project
fields it fills, with dates as offsets from the creation day, and the milestones
and issues a project made from it starts with. A document template, `kind`
"document", carries only a title and a Markdown body, which a new document or a
project or initiative update starts from.
Fields that need a table read to judge, such as a status of the team, are held
by the write path in `app.common.issue_templates`.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from app.common.api.schemas.issues import TITLE_MAX, PriorityField
from app.common.api.schemas.planning import (
    DESCRIPTION_MAX_BYTES,
    MEMBERS_MAX,
    NAME_MAX,
    ProjectIconField,
    ProjectPriorityField,
    ProjectStatusField,
)
from app.common.api.schemas.teams import COLOR_PATTERN, ConfigScope
from app.common.core.constants import ISSUE_BODY_MAX_BYTES
from app.common.db.dynamo.team_templates import (
    DOCUMENT_TEMPLATE,
    ISSUE_TEMPLATE,
    PROJECT_TEMPLATE,
    IssueTemplate,
    ProjectBlueprint,
    TemplateSettings,
)

TemplateKindField = Literal["issue", "project", "document"]
"""What a template fills: a new issue, a new project with its milestones and issues, or a new document or update."""

ROW_KINDS: dict[str, str] = {"issue": ISSUE_TEMPLATE, "project": PROJECT_TEMPLATE, "document": DOCUMENT_TEMPLATE}
"""The stored `kind` each API kind is kept as."""

API_KINDS: dict[str, str] = {row: api for api, row in ROW_KINDS.items()}
"""The API kind each stored `kind` reads as."""

TEMPLATE_NAME_MAX = 80

ESTIMATE_MAX = 16

POSITION_MAX = 10000

TEMPLATE_MILESTONES_MAX = 25
"""How many milestones one project template adds."""

TEMPLATE_ISSUES_MAX = 50
"""How many issues one project template adds, so the template stays one table item."""

TEMPLATE_ISSUE_BODY_MAX_BYTES = 4096
"""The byte cap on one template issue's body, smaller than an issue's so fifty fit in one item."""

MILESTONE_DESCRIPTION_MAX_BYTES = 2048
"""The byte cap on one template milestone's description."""

OFFSET_MAX_DAYS = 3650
"""The furthest a template date may sit from the creation day."""

KEY_MAX = 40
"""The longest key a template milestone or issue may carry."""


def _check_name(value: Optional[str]) -> Optional[str]:
    """Reject a name that is only whitespace, answering it stripped."""
    if value is None:
        return None
    candidate = value.strip()
    if not candidate:
        raise ValueError("name must not be blank")
    return candidate


def _check_title(value: Optional[str]) -> Optional[str]:
    """Read a blank default title as no title, keeping a trailing space so a prefix such as "Bug: " survives."""
    if value is None:
        return None
    return value.lstrip() or None


def _check_body(value: Optional[str]) -> Optional[str]:
    """Hold a default body to the issue body's byte cap, so any issue it fills can hold it."""
    if value is not None and len(value.encode("utf-8")) > ISSUE_BODY_MAX_BYTES:
        raise ValueError(f"body must be at most {ISSUE_BODY_MAX_BYTES} bytes")
    return value


def _distinct(values: Optional[list[str]]) -> Optional[list[str]]:
    """Hold a list of ids to distinct, non-blank values in their given order."""
    if values is None:
        return None
    return [value for value in dict.fromkeys(item.strip() for item in values) if value]


def _check_bytes(value: Optional[str], cap: int, name: str) -> Optional[str]:
    """Hold a markdown field to a UTF-8 byte cap."""
    if value is not None and len(value.encode("utf-8")) > cap:
        raise ValueError(f"{name} must be at most {cap} bytes")
    return value


def _check_key(value: Optional[str]) -> Optional[str]:
    """Read a blank key as none, answering it stripped."""
    if value is None:
        return None
    return value.strip() or None


class MilestoneTemplate(BaseModel):
    """One milestone a project template adds; `target_offset_days` counts from the creation day."""

    key: Optional[str] = Field(default=None, max_length=KEY_MAX)
    name: str = Field(min_length=1, max_length=NAME_MAX)
    description: Optional[str] = None
    target_offset_days: Optional[int] = Field(default=None, ge=0, le=OFFSET_MAX_DAYS)

    @field_validator("key")
    @classmethod
    def check_key(cls, value: Optional[str]) -> Optional[str]:
        """Read a blank key as none."""
        return _check_key(value)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        """Reject a name that is only whitespace."""
        return _check_name(value) or ""

    @field_validator("description")
    @classmethod
    def check_description(cls, value: Optional[str]) -> Optional[str]:
        """Hold the description to its byte cap."""
        return _check_bytes(value, MILESTONE_DESCRIPTION_MAX_BYTES, "description")


class IssueTemplateItem(BaseModel):
    """One issue a project template adds.

    `parent_key` makes it a sub-issue of an issue listed before it, and
    `milestone_key` ties it to one of the template's milestones.
    """

    key: Optional[str] = Field(default=None, max_length=KEY_MAX)
    title: str = Field(min_length=1, max_length=TITLE_MAX)
    body: Optional[str] = None
    status_id: Optional[str] = None
    priority: Optional[PriorityField] = None
    assignee_id: Optional[str] = None
    label_ids: list[str] = Field(default_factory=list)
    estimate: Optional[str] = Field(default=None, max_length=ESTIMATE_MAX)
    milestone_key: Optional[str] = None
    parent_key: Optional[str] = None

    @field_validator("key", "milestone_key", "parent_key")
    @classmethod
    def check_keys(cls, value: Optional[str]) -> Optional[str]:
        """Read a blank key as none."""
        return _check_key(value)

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
        """Hold the body to the template issue's byte cap."""
        return _check_bytes(value, TEMPLATE_ISSUE_BODY_MAX_BYTES, "body")

    @field_validator("label_ids")
    @classmethod
    def check_label_ids(cls, value: list[str]) -> list[str]:
        """Hold the labels to distinct ids."""
        return _distinct(value) or []


class ProjectTemplateFields(BaseModel):
    """What a project template fills, every field optional.

    The two offsets are days from the creation day to the start and target dates.
    Milestones and issues without a key are given one, `m1` and `i1` onwards,
    so the keys stay unique and every reference names a row of the template.
    """

    description: Optional[str] = None
    lead_id: Optional[str] = None
    member_ids: list[str] = Field(default_factory=list, max_length=MEMBERS_MAX)
    status: Optional[ProjectStatusField] = None
    priority: Optional[ProjectPriorityField] = None
    icon: Optional[ProjectIconField] = None
    color: Optional[str] = None
    start_offset_days: Optional[int] = Field(default=None, ge=0, le=OFFSET_MAX_DAYS)
    target_offset_days: Optional[int] = Field(default=None, ge=0, le=OFFSET_MAX_DAYS)
    milestones: list[MilestoneTemplate] = Field(default_factory=list, max_length=TEMPLATE_MILESTONES_MAX)
    issues: list[IssueTemplateItem] = Field(default_factory=list, max_length=TEMPLATE_ISSUES_MAX)

    @field_validator("description")
    @classmethod
    def check_description(cls, value: Optional[str]) -> Optional[str]:
        """Hold the description to the project description's byte cap."""
        return _check_bytes(value, DESCRIPTION_MAX_BYTES, "description")

    @field_validator("lead_id")
    @classmethod
    def check_lead(cls, value: Optional[str]) -> Optional[str]:
        """Read a blank lead as none."""
        return _check_key(value)

    @field_validator("member_ids")
    @classmethod
    def check_member_ids(cls, value: list[str]) -> list[str]:
        """Hold the members to distinct ids."""
        return _distinct(value) or []

    @field_validator("color")
    @classmethod
    def check_color(cls, value: Optional[str]) -> Optional[str]:
        """Hold the colour to `#rrggbb`, lowercased."""
        if value is None:
            return None
        candidate = value.strip().lower()
        if not COLOR_PATTERN.match(candidate):
            raise ValueError("color must be #rrggbb")
        return candidate

    @model_validator(mode="after")
    def check_references(self) -> "ProjectTemplateFields":
        """Hold the dates in order, give every row a unique key and every reference a target."""
        if (
            self.start_offset_days is not None
            and self.target_offset_days is not None
            and self.start_offset_days > self.target_offset_days
        ):
            raise ValueError("start_offset_days must not be after target_offset_days")
        milestone_keys = _settle_keys(self.milestones, "m", "milestone")
        _settle_keys(self.issues, "i", "issue")
        issue_keys: set[str] = set()
        for item in self.issues:
            if item.milestone_key is not None and item.milestone_key not in milestone_keys:
                raise ValueError(f"No such milestone key: {item.milestone_key}")
            if item.parent_key is not None and item.parent_key not in issue_keys:
                raise ValueError(f"parent_key {item.parent_key} must name an issue listed before it")
            issue_keys.add(item.key or "")
        return self


def _settle_keys(rows: Sequence[MilestoneTemplate | IssueTemplateItem], prefix: str, noun: str) -> set[str]:
    """Give each row without a key the next free one, raising on a key used twice."""
    taken = {item.key for item in rows if item.key}
    seen: set[str] = set()
    number = 0
    for item in rows:
        if item.key is None:
            number += 1
            while f"{prefix}{number}" in taken:
                number += 1
            item.key = f"{prefix}{number}"
        if item.key in seen:
            raise ValueError(f"{noun} key {item.key} is used twice")
        seen.add(item.key)
    return seen


class TemplateFields(BaseModel):
    """The issue fields a template fills, shared by its create and update shapes."""

    title: Optional[str] = Field(default=None, max_length=TITLE_MAX)
    body: Optional[str] = None
    status_id: Optional[str] = None
    priority: Optional[PriorityField] = None
    assignee_id: Optional[str] = None
    estimate: Optional[str] = Field(default=None, max_length=ESTIMATE_MAX)
    project_id: Optional[str] = None
    project_milestone_id: Optional[str] = None
    cycle_id: Optional[str] = None
    position: Optional[int] = Field(default=None, ge=0, le=POSITION_MAX)

    @field_validator("title")
    @classmethod
    def check_title(cls, value: Optional[str]) -> Optional[str]:
        """Drop leading whitespace from the default title, keeping a prefix's trailing space."""
        return _check_title(value)

    @field_validator("body")
    @classmethod
    def check_body(cls, value: Optional[str]) -> Optional[str]:
        """Hold the body to the shared byte cap."""
        return _check_body(value)


class TemplateCreate(TemplateFields):
    """The body a template create takes: a name and any of the issue fields.

    `kind` "project" makes a project template, which fills `project` and leaves
    the issue fields unset. `kind` "document" makes a document template, which
    takes only `title` and `body`.
    """

    kind: TemplateKindField = "issue"
    name: str = Field(min_length=1, max_length=TEMPLATE_NAME_MAX)
    label_ids: list[str] = Field(default_factory=list)
    project: Optional[ProjectTemplateFields] = None

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        """Reject a name that is only whitespace."""
        return _check_name(value) or ""

    @field_validator("label_ids")
    @classmethod
    def check_label_ids(cls, value: list[str]) -> list[str]:
        """Hold the labels to distinct ids."""
        return _distinct(value) or []


class TemplateUpdate(TemplateFields):
    """The body a template patch takes: only the fields sent change, and null clears one."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=TEMPLATE_NAME_MAX)
    label_ids: Optional[list[str]] = None
    project: Optional[ProjectTemplateFields] = None

    @field_validator("name")
    @classmethod
    def check_name(cls, value: Optional[str]) -> Optional[str]:
        """Reject a name that is only whitespace."""
        return _check_name(value)

    @field_validator("label_ids")
    @classmethod
    def check_label_ids(cls, value: Optional[list[str]]) -> Optional[list[str]]:
        """Hold the labels to distinct ids."""
        return _distinct(value)


class TemplateRead(BaseModel):
    """One template as the API returns it.

    `scope` says where it comes from as the team in the path sees it: the team's
    own, its parent team's, or the workspace's. `team_id` is `None` for a
    workspace template. `project` is set on a project template only, and a
    document template sets only `title` and `body`.
    """

    id: str
    kind: TemplateKindField = "issue"
    name: str
    team_id: Optional[str] = None
    scope: ConfigScope = "team"
    title: Optional[str] = None
    body: Optional[str] = None
    status_id: Optional[str] = None
    priority: Optional[PriorityField] = None
    assignee_id: Optional[str] = None
    label_ids: list[str] = Field(default_factory=list)
    estimate: Optional[str] = None
    project_id: Optional[str] = None
    project_milestone_id: Optional[str] = None
    cycle_id: Optional[str] = None
    project: Optional[ProjectBlueprint] = None
    position: int = 0
    created_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row: IssueTemplate, team_id: Optional[str] = None) -> "TemplateRead":
        """Build the response shape from a stored row, scoped as `team_id` sees it."""
        if row.team_id is None:
            scope = "workspace"
        elif team_id is None or row.team_id == team_id:
            scope = "team"
        else:
            scope = "parent"
        return cls(
            id=row.template_id,
            kind=API_KINDS.get(row.kind, "issue"),  # pyright: ignore[reportArgumentType]
            name=row.name,
            team_id=row.team_id,
            scope=scope,  # pyright: ignore[reportArgumentType]
            title=row.title,
            body=row.body,
            status_id=row.status_id,
            priority=row.priority,  # pyright: ignore[reportArgumentType]
            assignee_id=row.assignee_id,
            label_ids=list(row.label_ids),
            estimate=row.estimate,
            project_id=row.project_id,
            project_milestone_id=row.project_milestone_id,
            cycle_id=row.cycle_id,
            project=row.project,
            position=row.position,
            created_by=row.created_by,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )


class TemplateListRead(BaseModel):
    """The body a template list answers with, and the template a new issue starts from.

    `default_template_id` is the team's own default, else its parent's, and is
    always one of `templates`; a workspace list carries none.
    """

    templates: list[TemplateRead]
    default_template_id: Optional[str] = None


class DocumentTemplateListRead(BaseModel):
    """The document templates a project or initiative offers, and the ones its composers open with.

    `default_document_template_id` is what a new document starts from and
    `default_update_template_id` what the update composer opens with, each the
    first of the project's teams to set one and always one of `templates`. An
    initiative belongs to no team, so it carries neither.
    """

    templates: list[TemplateRead]
    default_document_template_id: Optional[str] = None
    default_update_template_id: Optional[str] = None


class TemplateSettingsRead(BaseModel):
    """A team's template settings as the API returns them.

    `default_template_id` is what the team saved and `effective_default_template_id`
    what its issue create dialog opens with, which falls back to the parent team's.
    The project fields are the same for the new project dialog, the document
    fields for a new document of a project the team is on, and the update fields
    for the project update composer.
    """

    team_id: str
    default_template_id: Optional[str] = None
    effective_default_template_id: Optional[str] = None
    default_project_template_id: Optional[str] = None
    effective_default_project_template_id: Optional[str] = None
    default_document_template_id: Optional[str] = None
    effective_default_document_template_id: Optional[str] = None
    default_update_template_id: Optional[str] = None
    effective_default_update_template_id: Optional[str] = None

    @classmethod
    def from_row(cls, row: TemplateSettings, effective: dict[str, Optional[str]]) -> "TemplateSettingsRead":
        """Build the response shape from a stored settings row and the resolved default of each settings field."""
        return cls(
            team_id=row.team_id,
            default_template_id=row.default_template_id,
            effective_default_template_id=effective.get("default_template_id"),
            default_project_template_id=row.default_project_template_id,
            effective_default_project_template_id=effective.get("default_project_template_id"),
            default_document_template_id=row.default_document_template_id,
            effective_default_document_template_id=effective.get("default_document_template_id"),
            default_update_template_id=row.default_update_template_id,
            effective_default_update_template_id=effective.get("default_update_template_id"),
        )


class TemplateSettingsUpdate(BaseModel):
    """The body a team's template settings patch takes: only the defaults sent change, and null clears one.

    The document and update defaults both name a document template.
    """

    default_template_id: Optional[str] = None
    default_project_template_id: Optional[str] = None
    default_document_template_id: Optional[str] = None
    default_update_template_id: Optional[str] = None
