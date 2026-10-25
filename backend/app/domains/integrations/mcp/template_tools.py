"""MCP tools for issue, project and document templates: a team's, its parent team's and the workspace's.

A template is named by its id or its name, and a tool given `team_id` works on
that team's templates while one without it works on the workspace's. The tools
run the same `app.common.issue_templates` functions as the routes, so a team's
templates are held to team membership and the workspace's to workspace admin,
and a narrowed credential needs the `admin` scope for a workspace template
exactly as the route's scope table asks. `kind` picks issue, project or document
templates; the write tools find a template of any kind by its id or name.
"""

from __future__ import annotations

from typing import Any, Optional, get_args

from app.common import issue_templates
from app.common.api.dependencies.authz import Capability, check_capability, missing_scopes
from app.common.api.schemas.planning import ProjectIconField, ProjectPriorityField, ProjectStatusField
from app.common.api.schemas.templates import (
    FORM_FIELDS_MAX,
    FORM_OPTIONS_MAX,
    OFFSET_MAX_DAYS,
    POSITION_MAX,
    ROW_KINDS,
    TEMPLATE_ISSUES_MAX,
    TEMPLATE_MILESTONES_MAX,
    TEMPLATE_SUB_ISSUES_MAX,
    FormFieldType,
    TemplateCreate,
    TemplateRead,
    TemplateUpdate,
)
from app.common.db.dynamo.team_templates import DOCUMENT_TEMPLATE, ISSUE_TEMPLATE, PROJECT_TEMPLATE, IssueTemplate
from app.domains.integrations.mcp.toolkit import (
    NOT_VISIBLE,
    PRIORITIES,
    Tool,
    ToolCall,
    enum,
    nullable,
    object_schema,
    resolve_user,
    string,
    string_list,
)
from app.domains.integrations.mcp.transport import ToolError

TEMPLATE_TEAM_ARGUMENT = "Team: id, key such as ENG, or name; omit for a workspace template"

TEMPLATE_ARGUMENT = "The template: its id or its name"

KIND_ARGUMENT = (
    "issue for an issue template, the default, project for a project template, or document for a document "
    "template that starts new documents and project or initiative updates"
)

KINDS: tuple[str, ...] = tuple(ROW_KINDS)

_FIELDS = (
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
    "position",
    "form_fields",
    "sub_issues",
)


def _one(rows: list[IssueTemplate], reference: str) -> IssueTemplate:
    """The template whose id or name matches, refusing an ambiguous name and an unknown one."""
    for row in rows:
        if row.template_id == reference:
            return row
    folded = reference.casefold()
    named = [row for row in rows if row.name.casefold() == folded]
    if len(named) > 1:
        raise ToolError(f"More than one template is named {reference}; pass its id")
    if not named:
        raise ToolError(NOT_VISIBLE)
    return named[0]


def template_ref(call: ToolCall, team_id: str, value: Any) -> IssueTemplate:
    """One template a team offers the caller, its own, its parent's or the workspace's."""
    rows = issue_templates.team_templates(call.repositories, call.context, team_id)
    return _one(rows, str(value).strip())


def project_template_ref(call: ToolCall, team_ids: list[str], value: Any) -> IssueTemplate:
    """One project template any of a project's teams offers the caller, by id or name."""
    rows: dict[str, IssueTemplate] = {}
    for team_id in team_ids:
        if call.context.can_see_team(team_id):
            for row in issue_templates.team_templates(call.repositories, call.context, team_id, PROJECT_TEMPLATE):
                rows.setdefault(row.template_id, row)
    return _one(list(rows.values()), str(value).strip())


def _own_ref(call: ToolCall, team_id: Optional[str], value: Any) -> IssueTemplate:
    """One template of any kind of the team itself, or of the workspace with no team, for the write tools."""
    rows: list[IssueTemplate] = []
    for kind in (ISSUE_TEMPLATE, PROJECT_TEMPLATE, DOCUMENT_TEMPLATE):
        if team_id:
            found = issue_templates.team_templates(call.repositories, call.context, team_id, kind)
            rows += [row for row in found if row.team_id == team_id]
        else:
            rows += issue_templates.list_workspace_templates(call.repositories, call.context, kind)
    return _one(rows, str(value).strip())


def _workspace_admin(call: ToolCall) -> None:
    """Hold a workspace template write to workspace admin and to a credential carrying `admin`."""
    if missing_scopes(call.context.scopes, ("admin",)):
        raise ToolError("Missing scope: admin")
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)


def _fields(call: ToolCall, *, patch: bool) -> dict[str, Any]:
    """The template fields the caller sent, `me` resolved to the caller.

    A create reads only the values given, while a patch keeps an explicit null so
    it clears that field.
    """
    names = ("name", *_FIELDS)
    if patch:
        fields = {name: call.arguments[name] for name in names if call.present(name)}
    else:
        fields = {name: call.arguments[name] for name in names if call.optional(name) is not None}
        if call.optional("kind") is not None:
            fields["kind"] = call.arguments["kind"]
    if fields.get("assignee_id") is not None:
        fields["assignee_id"] = resolve_user(call, fields["assignee_id"])
    if call.optional("project") is not None:
        fields["project"] = _project(call, call.arguments["project"])
    if isinstance(fields.get("sub_issues"), list):
        fields["sub_issues"] = _items(call, fields["sub_issues"])
    return fields


def _project(call: ToolCall, value: Any) -> Any:
    """A project template's fields with every `me` and email resolved to a user id."""
    if not isinstance(value, dict):
        raise ToolError("project must be an object")
    project: dict[str, Any] = dict(value)
    if project.get("lead_id"):
        project["lead_id"] = resolve_user(call, project["lead_id"])
    if isinstance(project.get("member_ids"), list):
        project["member_ids"] = [resolve_user(call, member) for member in project["member_ids"]]
    if isinstance(project.get("issues"), list):
        project["issues"] = _items(call, project["issues"])
    return project


def _items(call: ToolCall, items: list[Any]) -> list[Any]:
    """Template issues with each assignee's `me` or email resolved to a user id."""
    resolved: list[Any] = []
    for item in items:
        if isinstance(item, dict) and item.get("assignee_id"):
            item = {**item, "assignee_id": resolve_user(call, item["assignee_id"])}
        resolved.append(item)
    return resolved


def _json(row: IssueTemplate, team_id: Optional[str]) -> dict[str, Any]:
    """One template as the tools answer it, in the route's response shape."""
    return TemplateRead.from_row(row, team_id).model_dump(mode="json")


def _list_templates(call: ToolCall) -> Any:
    """Every template of one kind a team offers and its default, or every workspace template of that kind."""
    team_id = call.optional("team_id")
    kind = ROW_KINDS.get(str(call.optional("kind", "issue")))
    if kind is None:
        raise ToolError("kind must be issue, project or document")
    if team_id:
        rows, default = issue_templates.list_team_templates(call.repositories, call.context, team_id, kind)
        return {"templates": [_json(row, team_id) for row in rows], "default_template_id": default}
    check_capability(call.repositories, call.context, Capability.WORKSPACE_READ)
    rows = issue_templates.list_workspace_templates(call.repositories, call.context, kind)
    return {"templates": [_json(row, None) for row in rows], "default_template_id": None}


def _create_template(call: ToolCall) -> Any:
    """Add a template to a team, or to the workspace when no team is named."""
    team_id = call.optional("team_id")
    payload = TemplateCreate.model_validate(_fields(call, patch=False))
    if team_id:
        return _json(issue_templates.create_team_template(call.repositories, call.context, team_id, payload), team_id)
    _workspace_admin(call)
    return _json(issue_templates.create_workspace_template(call.repositories, call.context, payload), None)


def _update_template(call: ToolCall) -> Any:
    """Change, clear or move one of a team's own templates, or a workspace template."""
    team_id = call.optional("team_id")
    if not team_id:
        _workspace_admin(call)
    found = _own_ref(call, team_id, call.require("template"))
    payload = TemplateUpdate.model_validate(_fields(call, patch=True))
    if team_id:
        updated = issue_templates.update_team_template(
            call.repositories, call.context, team_id, found.template_id, payload
        )
    else:
        updated = issue_templates.update_workspace_template(call.repositories, call.context, found.template_id, payload)
    return _json(updated, team_id)


def _delete_template(call: ToolCall) -> Any:
    """Delete one of a team's own templates, or a workspace template."""
    team_id = call.optional("team_id")
    if not team_id:
        _workspace_admin(call)
    found = _own_ref(call, team_id, call.require("template"))
    if team_id:
        issue_templates.delete_team_template(call.repositories, call.context, team_id, found.template_id)
    else:
        issue_templates.delete_workspace_template(call.repositories, call.context, found.template_id)
    return {"deleted": True, "template_id": found.template_id, "name": found.name}


def _field_properties(*, patch: bool) -> dict[str, Any]:
    """The template field arguments, nullable on a patch so a null clears one."""
    value = nullable if patch else string
    return {
        "title": value("The default issue title, or a document template's document title"),
        "body": value("The default issue body, or a document template's body, in Markdown"),
        "status_id": value("A status of the team, or a workspace status for a workspace template"),
        "priority": enum(PRIORITIES, "The default priority"),
        "assignee_id": value("The default assignee; 'me' is the caller"),
        "label_ids": string_list("The default labels, by id"),
        "estimate": value("The default estimate, in the team's scale; not kept on a workspace template"),
        "project_id": value("A project the team is on"),
        "project_milestone_id": value("A milestone of that project"),
        "cycle_id": value("A cycle of the team; refused on a workspace template"),
        "position": {
            "type": "integer",
            "minimum": 0,
            "maximum": POSITION_MAX,
            "description": "Zero-based place in the picker; defaults to the end",
        },
    }


def _offset(description: str) -> dict[str, Any]:
    """A day offset from the day a project is created."""
    return {"type": "integer", "minimum": 0, "maximum": OFFSET_MAX_DAYS, "description": description}


PROJECT_TEMPLATE_PROPERTY: dict[str, Any] = {
    "type": "object",
    "description": (
        "For kind project: the project fields it fills, dates as days from the creation day, and the "
        "milestones and issues the project starts with. On update it replaces the whole set."
    ),
    "additionalProperties": False,
    "properties": {
        "description": string("The project description, in Markdown"),
        "lead_id": string("The lead: user id, email or 'me'"),
        "member_ids": string_list("The members by user id, email or 'me'"),
        "status": enum(get_args(ProjectStatusField), "The project status"),
        "priority": enum(get_args(ProjectPriorityField), "The project priority"),
        "icon": enum(get_args(ProjectIconField), "The project icon"),
        "color": string("The project colour as #rrggbb"),
        "start_offset_days": _offset("Days from creation to the start date"),
        "target_offset_days": _offset("Days from creation to the target date"),
        "milestones": {
            "type": "array",
            "maxItems": TEMPLATE_MILESTONES_MAX,
            "description": "The milestones, in order",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["name"],
                "properties": {
                    "key": string("A short key issues name it by; defaults to m1, m2 and on"),
                    "name": string("The milestone name"),
                    "description": string("The milestone description"),
                    "target_offset_days": _offset("Days from creation to the milestone's target date"),
                },
            },
        },
        "issues": {
            "type": "array",
            "maxItems": TEMPLATE_ISSUES_MAX,
            "description": "The issues, in order; a sub-issue follows its parent",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["title"],
                "properties": {
                    "key": string("A short key sub-issues name it by; defaults to i1, i2 and on"),
                    "title": string("The issue title"),
                    "body": string("The issue body, in Markdown"),
                    "status_id": string("A status of the template's team"),
                    "priority": enum(PRIORITIES, "The issue priority"),
                    "assignee_id": string("The assignee: user id, email or 'me'"),
                    "label_ids": string_list("Labels by id"),
                    "estimate": string("An estimate in the team's scale"),
                    "milestone_key": string("The key of the template milestone it belongs to"),
                    "parent_key": string("The key of an earlier template issue it is a sub-issue of"),
                },
            },
        },
    },
}

FORM_FIELDS_PROPERTY: dict[str, Any] = {
    "type": ["array", "null"],
    "maxItems": FORM_FIELDS_MAX,
    "description": (
        "For an issue template: the questions that make it a form. An issue filed from a form answers them in "
        "create_issue's form_answers, the answers land in its body, and it goes to the team's triage. On update "
        "it replaces the whole set, and null or an empty list turns the form off."
    ),
    "items": {
        "type": "object",
        "additionalProperties": False,
        "required": ["label"],
        "properties": {
            "key": string("A short key form_answers names it by; defaults to f1, f2 and on"),
            "label": string("The question"),
            "type": enum(get_args(FormFieldType), "The answer type; defaults to short_text"),
            "required": {"type": "boolean", "description": "Whether an issue cannot be filed without an answer"},
            "description": string("Help text shown under the question"),
            "options": {
                "type": "array",
                "maxItems": FORM_OPTIONS_MAX,
                "description": "For a select field, the choices, in order",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["value"],
                    "properties": {
                        "value": string("The choice as shown and answered"),
                        "label_id": string("A label choosing it puts on the issue"),
                        "priority": enum(PRIORITIES, "A priority choosing it sets on the issue"),
                    },
                },
            },
        },
    },
}

SUB_ISSUES_PROPERTY: dict[str, Any] = {
    "type": ["array", "null"],
    "maxItems": TEMPLATE_SUB_ISSUES_MAX,
    "description": (
        "For an issue template: the sub-issues created under every issue made from it, in order. create_issue's "
        "template_sub_issue_keys keeps only some. On update it replaces the whole set, and null or an empty list "
        "removes them."
    ),
    "items": {
        "type": "object",
        "additionalProperties": False,
        "required": ["title"],
        "properties": {
            "key": string("A short key create_issue names it by; defaults to s1, s2 and on"),
            "title": string("The sub-issue title"),
            "body": string("The sub-issue body, in Markdown"),
            "status_id": string("A status of the template's team"),
            "priority": enum(PRIORITIES, "The sub-issue priority"),
            "assignee_id": string("The assignee: user id, email or 'me'"),
            "label_ids": string_list("Labels by id"),
            "estimate": string("An estimate in the team's scale"),
        },
    },
}

TEMPLATE_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_templates",
        description=(
            "The issue, project or document templates a team offers, its own, its parent team's and the "
            "workspace's, each tagged with its scope, and the default its create dialog opens with. Without "
            "team_id, the workspace templates. kind picks issue templates, the default, project or document "
            "templates."
        ),
        scopes=("teams:read",),
        schema=object_schema({"team_id": string(TEMPLATE_TEAM_ARGUMENT), "kind": enum(KINDS, KIND_ARGUMENT)}),
        handler=_list_templates,
    ),
    Tool(
        name="create_template",
        description=(
            "Save an issue template that prefills new issues: a name and any default fields. With kind project "
            "it is a project template instead, whose project argument holds the project fields and the "
            "milestones and issues a new project starts with. With kind document it holds only a title and a "
            "Markdown body that new documents and updates start from. With team_id it belongs to that team and its "
            "sub-teams and needs team membership; without it every team offers it and it needs workspace admin. "
            "Pass its id or name as template_id to create_issue, to create_project for a project template, or to "
            "create_document, create_project_update or create_initiative_update for a document template. "
            "form_fields turns an issue template into a form whose answers create_issue takes as form_answers, "
            "and sub_issues lists the sub-issues create_issue adds under each issue made from it."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {
                "team_id": string(TEMPLATE_TEAM_ARGUMENT),
                "kind": enum(KINDS, KIND_ARGUMENT),
                "name": string("The template name shown in the picker"),
                **_field_properties(patch=False),
                "project": PROJECT_TEMPLATE_PROPERTY,
                "form_fields": FORM_FIELDS_PROPERTY,
                "sub_issues": SUB_ISSUES_PROPERTY,
            },
            required=("name",),
        ),
        handler=_create_template,
    ),
    Tool(
        name="update_template",
        description=(
            "Change, clear or move one issue, project or document template; only the fields named are written and null "
            "clears one. With team_id it edits that team's own template, without it a workspace template "
            "(workspace admin)."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {
                "team_id": string(TEMPLATE_TEAM_ARGUMENT),
                "template": string(TEMPLATE_ARGUMENT),
                "name": string("A new name"),
                **_field_properties(patch=True),
                "project": PROJECT_TEMPLATE_PROPERTY,
                "form_fields": FORM_FIELDS_PROPERTY,
                "sub_issues": SUB_ISSUES_PROPERTY,
            },
            required=("template",),
        ),
        handler=_update_template,
        idempotent=True,
    ),
    Tool(
        name="delete_template",
        description=(
            "Permanently delete one issue, project or document template. What was created from it keeps its "
            "fields. With team_id it deletes that team's own template, without it a workspace template "
            "(workspace admin)."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {"team_id": string(TEMPLATE_TEAM_ARGUMENT), "template": string(TEMPLATE_ARGUMENT)},
            required=("template",),
        ),
        handler=_delete_template,
        destructive=True,
    ),
)
