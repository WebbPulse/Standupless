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
from app.common.api.schemas.planning import ProjectCreate, ProjectRead
from app.common.db.dynamo.planning import ProjectMilestone, milestone_key, new_planning_id
from app.common.db.dynamo.team_templates import PROJECT_TEMPLATE, IssueBlueprint, IssueTemplate, ProjectBlueprint
from app.common.db.dynamo.teams import Team
from app.common.issue_rules import check_assignee, check_estimate, check_status, unprocessable
from app.common.issue_templates import find_template, kept_labels, lenient
from app.common.issue_writes import create_issue
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


def _issue_values(repositories: Repositories, workspace_id: str, team: Team, item: IssueBlueprint) -> dict[str, Any]:
    """The fields one template issue fills in the team it lands in, with anything that team refuses dropped."""
    team_id = team.team_id
    values: dict[str, Any] = {"title": item.title, "body": item.body, "priority": item.priority}
    if item.status_id and lenient(check_status, repositories, workspace_id, team_id, item.status_id) is not None:
        values["status_id"] = item.status_id
    if item.label_ids:
        values["label_ids"] = kept_labels(repositories, workspace_id, team_id, item.label_ids)
    if item.assignee_id:
        values["assignee_id"] = lenient(check_assignee, repositories, workspace_id, team_id, item.assignee_id)
    if item.estimate:
        values["estimate"] = lenient(check_estimate, item.estimate, team)
    return {name: value for name, value in values.items() if value is not None}


def issue_team(template: IssueTemplate, project: ProjectRead) -> str:
    """The team a template's issues land in: the template's own when it is on the project, else the first."""
    if template.team_id and template.team_id in project.team_ids:
        return template.team_id
    return project.team_ids[0]


def add_template_rows(
    repositories: Repositories, context: AuthzContext, project: ProjectRead, template: IssueTemplate, today: date
) -> None:
    """Add a template's milestones and then its issues to a project just created from it.

    The milestones are written directly, in the template's order, since the
    project is new and holds none. Issues are added in the template's order, so a parent always exists before
    its sub-issues. One the issue rules refuse, such as a sub-issue too deep, is
    left out rather than failing the rest.
    """
    blueprint = template.project
    if blueprint is None:
        return
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
        return
    team_id = issue_team(template, project)
    team = repositories.teams.get(workspace_id, team_id)
    if team is None:
        return
    issues: dict[str, str] = {}
    for item in blueprint.issues:
        payload = IssueCreate.model_validate(
            {
                **_issue_values(repositories, workspace_id, team, item),
                "team_id": team_id,
                "project_id": project.project_id,
                "project_milestone_id": milestones.get(item.milestone_key or ""),
                "parent_id": issues.get(item.parent_key or ""),
            }
        )
        try:
            created = create_issue(repositories, context, payload)
        except HTTPException as exc:
            if exc.status_code != status.HTTP_422_UNPROCESSABLE_ENTITY:
                raise
            continue
        issues[item.key] = created.issue_id
