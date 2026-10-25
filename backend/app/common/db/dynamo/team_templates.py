"""Issue, project and document template rows of the `team_config` table.

A row's `kind` says which it is: an issue template fills a new issue, a
project template a new project with its milestones and issues, and a document
template the title and body of a new document or project update. A team's
templates are rows at `team#<pid>#template#<id>` and the workspace's,
which every team offers, at `workspace#template#<id>` with no `team_id`. A team's
default template is one settings row at `team#<pid>#templates`, which the
`team#<pid>#template#` prefix does not match, so a list never reads it as a
template. Each set is small and read as one prefix query, which is why templates
share the table with the statuses and labels they name rather than taking one of
their own. The kinds share the keys and the prefix, so a read filters on
`kind`.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository

from app.common.db.dynamo.base import as_item, utc_now

ISSUE_TEMPLATE = "issue_template"
"""The `kind` an issue template row carries."""

PROJECT_TEMPLATE = "project_template"
"""The `kind` a project template row carries."""

DOCUMENT_TEMPLATE = "document_template"
"""The `kind` a document template row carries: a title and a Markdown body."""

TEMPLATE_SETTINGS = "template_settings"
"""The `kind` of a team's template settings row."""

WORKSPACE_TEMPLATE_PREFIX = "workspace#template#"
"""The sort key prefix every workspace template shares."""

TEMPLATE_FIELDS: tuple[str, ...] = (
    "title",
    "body",
    "status_id",
    "priority",
    "assignee_id",
    "label_ids",
    "estimate",
    "project_id",
    "project_milestone_id",
    "cycle_id",
)
"""The issue fields a template carries, every one optional."""


def team_template_prefix(team_id: str) -> str:
    """The sort key prefix every template of one team shares."""
    return f"team#{team_id}#template#"


def template_key(team_id: Optional[str], template_id: str) -> str:
    """The sort key of one template, a team's or, with no team, the workspace's."""
    if team_id:
        return f"{team_template_prefix(team_id)}{template_id}"
    return f"{WORKSPACE_TEMPLATE_PREFIX}{template_id}"


def template_settings_key(team_id: str) -> str:
    """The sort key of one team's template settings row."""
    return f"team#{team_id}#templates"


class MilestoneBlueprint(BaseModel):
    """One milestone a project template adds, its target date as days after the creation date."""

    key: str
    name: str
    description: Optional[str] = None
    target_offset_days: Optional[int] = None


class IssueBlueprint(BaseModel):
    """One issue a project template adds, or one sub-issue an issue template adds under the new issue.

    `key` names it inside the template, so `parent_key` can make it a sub-issue
    of an issue listed before it and `milestone_key` can tie it to a milestone.
    An issue template's sub-issues sit directly under the issue, so they carry
    neither.
    """

    key: str
    title: str
    body: Optional[str] = None
    status_id: Optional[str] = None
    priority: Optional[str] = None
    assignee_id: Optional[str] = None
    label_ids: list[str] = Field(default_factory=list)
    estimate: Optional[str] = None
    milestone_key: Optional[str] = None
    parent_key: Optional[str] = None


class FormOptionBlueprint(BaseModel):
    """One choice of a form's select field, and the label and priority choosing it puts on the issue."""

    value: str
    label_id: Optional[str] = None
    priority: Optional[str] = None


class FormFieldBlueprint(BaseModel):
    """One question a form template asks: short or long text, a select of options, or a checkbox.

    `key` names the field in the answers a create sends, so a label can be
    renamed without breaking a client that files through the form.
    """

    key: str
    label: str
    type: str
    required: bool = False
    description: Optional[str] = None
    options: list[FormOptionBlueprint] = Field(default_factory=list)


class ProjectBlueprint(BaseModel):
    """What a project template fills: the project's fields, its milestones and its issues.

    Dates are offsets in days from the day the project is created, so a template
    never goes stale.
    """

    description: Optional[str] = None
    lead_id: Optional[str] = None
    member_ids: list[str] = Field(default_factory=list)
    status: Optional[str] = None
    priority: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    start_offset_days: Optional[int] = None
    target_offset_days: Optional[int] = None
    milestones: list[MilestoneBlueprint] = Field(default_factory=list)
    issues: list[IssueBlueprint] = Field(default_factory=list)


class IssueTemplate(BaseModel):
    """A reusable starting point for a new issue, or with `kind` a project or a document, and the fields it fills.

    `team_id` is `None` for a workspace template. `position` orders a scope's
    templates in the picker and the settings page. A project template carries
    `project` and leaves the issue fields unset, and a document template sets
    only `title` and `body`. An issue template with `form_fields` is a form: an
    issue filed from it answers each field and lands in the team's triage.
    `sub_issues` are the issues an issue template creates under each issue
    made from it, in order.
    """

    workspace_id: str
    config_key: str
    template_id: str
    team_id: Optional[str] = None
    kind: str = ISSUE_TEMPLATE
    name: str
    title: Optional[str] = None
    body: Optional[str] = None
    status_id: Optional[str] = None
    priority: Optional[str] = None
    assignee_id: Optional[str] = None
    label_ids: list[str] = Field(default_factory=list)
    estimate: Optional[str] = None
    project_id: Optional[str] = None
    project_milestone_id: Optional[str] = None
    cycle_id: Optional[str] = None
    project: Optional[ProjectBlueprint] = None
    form_fields: list[FormFieldBlueprint] = Field(default_factory=list)
    sub_issues: list[IssueBlueprint] = Field(default_factory=list)
    position: int = 0
    created_by: Optional[str] = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class TemplateSettings(BaseModel):
    """A team's template settings: the templates its issue, project, document and update composers open with."""

    workspace_id: str
    config_key: str
    team_id: str
    kind: str = TEMPLATE_SETTINGS
    default_template_id: Optional[str] = None
    default_project_template_id: Optional[str] = None
    default_document_template_id: Optional[str] = None
    default_update_template_id: Optional[str] = None
    updated_at: Optional[datetime] = None


def template_order(row: IssueTemplate) -> tuple[int, str, str]:
    """The order one scope's templates list in: position, then name, then id."""
    return (row.position, row.name.casefold(), row.template_id)


class TemplateRows:
    """The template reads and writes of `TeamConfigRepository`, kept in one place."""

    _repository: Repository

    def get_template(
        self, workspace_id: str, team_id: Optional[str], template_id: str, kind: Optional[str] = ISSUE_TEMPLATE
    ) -> IssueTemplate | None:
        """One template of a team, or of the workspace when `team_id` is `None`, of one kind or with `None` of any."""
        if not workspace_id or not template_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "config_key": template_key(team_id, template_id)})
        if item is None:
            return None
        row = IssueTemplate.model_validate(dict(item))
        return row if kind is None or row.kind == kind else None

    def _items(self, workspace_id: str, prefix: str, limit: int) -> list[dict[str, Any]]:
        """Every template row under one prefix, of any kind."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("config_key").begins_with(prefix),
            max_items=limit,
        )
        return [dict(item) for item in items]

    def _templates(self, workspace_id: str, prefix: str, limit: int, kind: str) -> list[IssueTemplate]:
        """Every template of one kind under one prefix, in list order."""
        rows = (IssueTemplate.model_validate(item) for item in self._items(workspace_id, prefix, limit))
        return sorted((row for row in rows if row.kind == kind), key=template_order)

    def list_team_templates(
        self, workspace_id: str, team_id: str, *, limit: int = 200, kind: str = ISSUE_TEMPLATE
    ) -> list[IssueTemplate]:
        """Every template of one kind of one team itself, inherited ones aside."""
        if not team_id:
            return []
        return self._templates(workspace_id, team_template_prefix(team_id), limit, kind)

    def list_workspace_templates(
        self, workspace_id: str, *, limit: int = 200, kind: str = ISSUE_TEMPLATE
    ) -> list[IssueTemplate]:
        """Every workspace template of one kind, which every team offers."""
        return self._templates(workspace_id, WORKSPACE_TEMPLATE_PREFIX, limit, kind)

    def create_template(self, template: IssueTemplate) -> IssueTemplate:
        """Store one new template, raising `ConditionFailed` on a key collision."""
        self._repository.put(as_item(template), condition=Attr("config_key").not_exists())
        return template

    def replace_template(self, template: IssueTemplate) -> IssueTemplate | None:
        """Store an edited template whole, or `None` when it was deleted meanwhile."""
        stored = template.model_copy(update={"updated_at": utc_now()})
        try:
            self._repository.put(as_item(stored), condition=Attr("config_key").exists())
        except ConditionFailed:
            return None
        return stored

    def delete_template(
        self, workspace_id: str, team_id: Optional[str], template_id: str, kind: Optional[str] = ISSUE_TEMPLATE
    ) -> bool:
        """Remove one template, of one kind or with `None` of any, reporting whether one was there."""
        if self.get_template(workspace_id, team_id, template_id, kind) is None:
            return False
        key = {"workspace_id": workspace_id, "config_key": template_key(team_id, template_id)}
        self._repository.delete(key)
        return True

    def get_template_settings(self, workspace_id: str, team_id: str) -> TemplateSettings | None:
        """One team's stored template settings, or `None` when it never saved any."""
        if not workspace_id or not team_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "config_key": template_settings_key(team_id)})
        return TemplateSettings.model_validate(dict(item)) if item is not None else None

    def put_template_settings(self, settings: TemplateSettings) -> TemplateSettings:
        """Store one team's template settings whole, stamped with the time of the write."""
        stored = settings.model_copy(update={"updated_at": utc_now()})
        self._repository.put(as_item(stored))
        return stored

    def delete_team_templates(self, workspace_id: str, team_id: str, *, batch: int = 100) -> int:
        """Remove every template of any kind and the template settings of one team, for the team purge."""
        removed = 0
        settings_key = {"workspace_id": workspace_id, "config_key": template_settings_key(team_id)}
        if self._repository.get(settings_key) is not None:
            self._repository.delete(settings_key)
            removed += 1
        while True:
            items = self._items(workspace_id, team_template_prefix(team_id), batch)
            if not items:
                return removed
            removed += self._repository.delete_many(
                [{"workspace_id": workspace_id, "config_key": item["config_key"]} for item in items]
            )
