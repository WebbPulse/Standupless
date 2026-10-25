"""Project templates applied: filling a new project and adding the milestones and issues it starts with.

Held in `common` because the project routes live in the planning domain while
the MCP tools in the integrations image create projects too. A template is
applied leniently, as an issue template is: a person, status or label removed
since it was saved is dropped rather than failing the create. Its dates are
offsets, resolved from the day the project is created.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Optional

from fastapi import HTTPException, status

from app.common.api.dependencies.authz import AuthzContext, require_scopes_present
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.issues import IssueCreate
from app.common.api.schemas.planning import ProjectCreate, SkippedTemplateIssueRead
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.planning import Project, ProjectMilestone, milestone_key, new_planning_id
from app.common.db.dynamo.team_templates import PROJECT_TEMPLATE, IssueTemplate, ProjectBlueprint
from app.common.issue_rules import unprocessable
from app.common.issue_templates import blueprint_values, find_template
from app.common.issue_writes import FreshRows, create_issue
from app.common.milestone_writes import sort_order_after

PROJECT_FIELDS: tuple[str, ...] = ("description", "lead_id", "member_ids", "status", "priority", "icon", "color")
"""The project fields a template fills as they are stored."""


def offset_date(today: date, days: Optional[int]) -> Optional[str]:
    """The ISO date `days` after `today`, or `None` when the template sets none."""
    return None if days is None else (today + timedelta(days=days)).isoformat()


def find_project_template(
    repositories: Repositories, context: AuthzContext, team_ids: list[str], template_id: str
) -> IssueTemplate:
    """The project template one of the project's teams offers the caller, or a 422 naming it."""
    for team_id in team_ids:
        if not context.can_see_team(team_id):
            continue
        row = find_template(repositories, context, team_id, template_id, PROJECT_TEMPLATE)
        if row is not None:
            return row
    raise unprocessable(f"No such project template: {template_id}")


def fill_project(
    repositories: Repositories, context: AuthzContext, payload: ProjectCreate, template: IssueTemplate, today: date
) -> ProjectCreate:
    """The create with the template's fields filled wherever it left one unset.

    A lead or member who has left the workspace is dropped, and a filled date
    that would fall on the wrong side of a typed one is left out.
    """
    blueprint = template.project or ProjectBlueprint()
    workspace_id = context.workspace_id

    def present(user_id: str) -> bool:
        """Whether one person the template names is still in the workspace."""
        return repositories.memberships.get(workspace_id, user_id) is not None

    values: dict[str, Any] = {name: getattr(blueprint, name) for name in PROJECT_FIELDS}
    values["lead_id"] = blueprint.lead_id if blueprint.lead_id and present(blueprint.lead_id) else None
    values["member_ids"] = [user_id for user_id in blueprint.member_ids if present(user_id)]
    values["start_date"] = offset_date(today, blueprint.start_offset_days)
    values["target_date"] = offset_date(today, blueprint.target_offset_days)
    given = payload.model_fields_set
    filled = {name: value for name, value in values.items() if name not in given and value not in (None, [])}
    merged = payload.model_copy(update=filled)
    if merged.start_date and merged.target_date and merged.target_date < merged.start_date:
        merged = merged.model_copy(update={name: None for name in ("start_date", "target_date") if name in filled})
    return merged


def issue_team(template: IssueTemplate, project: Project) -> str:
    """The team a template's issues land in: the template's own when it is on the project, else the first."""
    if template.team_id and template.team_id in project.team_ids:
        return template.team_id
    return project.team_ids[0]


def skip_reason(exc: HTTPException) -> str:
    """The message a refused template issue's 422 carried, as the create response reports it."""
    detail: Any = exc.detail
    message = detail.get("message") if isinstance(detail, dict) else None
    return message if isinstance(message, str) else str(detail)


def add_template_rows(
    repositories: Repositories, context: AuthzContext, project: Project, template: IssueTemplate, today: date
) -> list[SkippedTemplateIssueRead]:
    """Add a template's milestones and then its issues to a project just created from it, answering any left out.

    The milestones are written directly, in the template's order, since the
    project is new and holds none. Issues are added in the template's order, so
    a parent always exists before its sub-issues. The project, milestones and
    parents were written moments ago, so each issue is checked against them as
    written rather than through reads that can lag the writes. One the issue
    rules still refuse, such as a sub-issue too deep, is left out rather than
    failing the rest, and named in the answer.
    """
    blueprint = template.project
    if blueprint is None:
        return []
    if blueprint.issues:
        require_scopes_present(context, ("issues:write",))
    workspace_id = context.workspace_id
    milestones: dict[str, str] = {}
    sort_order: Optional[str] = None
    for milestone in blueprint.milestones:
        milestone_id = new_planning_id()
        sort_order = sort_order_after(sort_order)
        repositories.planning.create_milestone(
            ProjectMilestone(
                workspace_id=workspace_id,
                planning_key=milestone_key(project.project_id, milestone_id),
                milestone_id=milestone_id,
                project_id=project.project_id,
                name=milestone.name,
                description=milestone.description,
                target_date=offset_date(today, milestone.target_offset_days),
                sort_order=sort_order,
                created_by=context.user_id,
            )
        )
        milestones[milestone.key] = milestone_id
    if not blueprint.issues:
        return []
    team_id = issue_team(template, project)
    team = repositories.teams.get(workspace_id, team_id)
    if team is None:
        return [
            SkippedTemplateIssueRead(key=item.key, title=item.title, reason=f"No such team: {team_id}")
            for item in blueprint.issues
        ]
    issues: dict[str, Issue] = {}
    skipped: list[SkippedTemplateIssueRead] = []
    for item in blueprint.issues:
        parent = issues.get(item.parent_key or "")
        payload = IssueCreate.model_validate(
            {
                **blueprint_values(repositories, workspace_id, team, item),
                "team_id": team_id,
                "project_id": project.project_id,
                "project_milestone_id": milestones.get(item.milestone_key or ""),
                "parent_id": parent.issue_id if parent is not None else None,
            }
        )
        fresh = FreshRows(
            project=project,
            milestones={project.project_id: frozenset(milestones.values())},
            issues={row.issue_id: row for row in issues.values()},
        )
        try:
            created = create_issue(repositories, context, payload, fresh=fresh, inherit=False)
        except HTTPException as exc:
            if exc.status_code != status.HTTP_422_UNPROCESSABLE_ENTITY:
                raise
            skipped.append(SkippedTemplateIssueRead(key=item.key, title=item.title, reason=skip_reason(exc)))
            continue
        issues[item.key] = created
    return skipped
