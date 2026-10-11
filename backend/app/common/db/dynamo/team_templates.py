"""Issue template rows of the `team_config` table.

A team's templates are rows at `team#<pid>#template#<id>` and the workspace's,
which every team offers, at `workspace#template#<id>` with no `team_id`. A team's
default template is one settings row at `team#<pid>#templates`, which the
`team#<pid>#template#` prefix does not match, so a list never reads it as a
template. Each set is small and read as one prefix query, which is why templates
share the table with the statuses and labels they name rather than taking one of
their own.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository

from app.common.db.dynamo.base import as_item, utc_now

ISSUE_TEMPLATE = "issue_template"
"""The `kind` an issue template row carries."""

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


class IssueTemplate(BaseModel):
    """A reusable starting point for a new issue: a name and the fields it fills.

    `team_id` is `None` for a workspace template. `position` orders a scope's
    templates in the picker and the settings page.
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
    position: int = 0
    created_by: Optional[str] = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class TemplateSettings(BaseModel):
    """A team's template settings: the template its create dialog opens with."""

    workspace_id: str
    config_key: str
    team_id: str
    kind: str = TEMPLATE_SETTINGS
    default_template_id: Optional[str] = None
    updated_at: Optional[datetime] = None


def template_order(row: IssueTemplate) -> tuple[int, str, str]:
    """The order one scope's templates list in: position, then name, then id."""
    return (row.position, row.name.casefold(), row.template_id)


class TemplateRows:
    """The template reads and writes of `TeamConfigRepository`, kept in one place."""

    _repository: Repository

    def get_template(self, workspace_id: str, team_id: Optional[str], template_id: str) -> IssueTemplate | None:
        """One template of a team, or of the workspace when `team_id` is `None`."""
        if not workspace_id or not template_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "config_key": template_key(team_id, template_id)})
        return IssueTemplate.model_validate(dict(item)) if item is not None else None

    def _templates(self, workspace_id: str, prefix: str, limit: int) -> list[IssueTemplate]:
        """Every template under one prefix, in list order."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("config_key").begins_with(prefix),
            max_items=limit,
        )
        return sorted((IssueTemplate.model_validate(dict(item)) for item in items), key=template_order)

    def list_team_templates(self, workspace_id: str, team_id: str, *, limit: int = 200) -> list[IssueTemplate]:
        """Every template of one team itself, inherited ones aside."""
        if not team_id:
            return []
        return self._templates(workspace_id, team_template_prefix(team_id), limit)

    def list_workspace_templates(self, workspace_id: str, *, limit: int = 200) -> list[IssueTemplate]:
        """Every workspace template, which every team offers."""
        return self._templates(workspace_id, WORKSPACE_TEMPLATE_PREFIX, limit)

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

    def delete_template(self, workspace_id: str, team_id: Optional[str], template_id: str) -> bool:
        """Remove one template, reporting whether one was there."""
        key = {"workspace_id": workspace_id, "config_key": template_key(team_id, template_id)}
        if self._repository.get(key) is None:
            return False
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
        """Remove every template and the template settings of one team, for the team purge."""
        removed = 0
        settings_key = {"workspace_id": workspace_id, "config_key": template_settings_key(team_id)}
        if self._repository.get(settings_key) is not None:
            self._repository.delete(settings_key)
            removed += 1
        while True:
            rows = self.list_team_templates(workspace_id, team_id, limit=batch)
            if not rows:
                return removed
            removed += self._repository.delete_many(
                [{"workspace_id": workspace_id, "config_key": row.config_key} for row in rows]
            )
