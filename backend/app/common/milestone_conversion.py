"""Converting a project milestone into a project of its own, shared by the milestone route and the MCP tool.

Held in `common` because the integrations image may not import another domain's
code. The conversion follows Linear's "Convert it into a project" but copies
fields rather than suggesting any: the new project is named after the milestone
and takes its description and target date, and the source project's teams, lead
and priority. Every issue on the milestone moves into the new project with no
milestone, then the milestone is deleted, and both projects' activity feeds
record the conversion. The source project's progress recounts through the
ordinary rollup as each issue leaves it.

The new project is put on the source project's teams the caller can see and
write in, since creating a project on a team is that team's call. An issue on
the milestone in any other team stays in the source project, and the milestone
delete clears the milestone off it, as a plain delete does.
"""

from __future__ import annotations

from typing import cast

from fastapi import HTTPException, status

from app.common import project_activity
from app.common.api.dependencies.authz import AuthzContext, require_scopes_present
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.planning import ProjectCreate, ProjectPriorityField, ProjectRead
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.planning import milestone_key
from app.common.issue_conversion import project_description, project_lead, project_name
from app.common.issue_writes import apply_patch, store_patch
from app.common.planning_rules import (
    load_readable_project,
    not_found,
    require_project_editor,
    team_role,
    unprocessable,
)
from app.common.project_writes import create_project
from app.common.team_retirement import is_retired


def writable_teams(repositories: Repositories, context: AuthzContext, teams: list[str]) -> list[str]:
    """The teams of `teams` the caller may write in, retired ones left out, in the given order."""
    writable: list[str] = []
    for team_id in teams:
        team = repositories.teams.get(context.workspace_id, team_id)
        if team is None or is_retired(team):
            continue
        if team_role(repositories, context, team_id) is not None:
            writable.append(team_id)
    return writable


def milestone_issues(
    repositories: Repositories, workspace_id: str, project_id: str, milestone_id: str, teams: list[str]
) -> list[Issue]:
    """Every issue of the named teams on one milestone, archived and closed ones included, oldest first."""
    rows = [
        issue
        for team_id in teams
        for issue in repositories.issues.iter_for_project(workspace_id, team_id, project_id)
        if issue.project_milestone_id == milestone_id and issue.deleted_at is None
    ]
    return sorted(rows, key=lambda issue: (issue.created_at.isoformat(), issue.issue_id))


def convert_milestone_to_project(
    repositories: Repositories, context: AuthzContext, project_id: str, milestone_id: str
) -> tuple[ProjectRead, list[Issue]]:
    """Turn one milestone into a project, answering the new project and the issues moved into it.

    Takes the right to edit the source project, as any milestone edit does. A
    narrowed credential also needs `issues:write`, since the issues move. Each
    issue goes through the ordinary patch path, so it records its own activity,
    and one deleted or changed since it was read is skipped rather than failing
    the rest.
    """
    source, teams = load_readable_project(repositories, context, project_id)
    require_project_editor(repositories, context, teams)
    milestone = repositories.planning.get_milestone(context.workspace_id, project_id, milestone_id)
    if milestone is None:
        raise not_found()
    name = project_name(milestone.name)
    if not name:
        raise unprocessable("A milestone needs a name to become a project")
    require_scopes_present(context, ("issues:write",))
    team_ids = writable_teams(repositories, context, teams)
    issues = milestone_issues(repositories, context.workspace_id, project_id, milestone_id, team_ids)

    created = create_project(
        repositories,
        context,
        ProjectCreate(
            team_ids=team_ids,
            name=name,
            description=project_description(milestone.description),
            lead_id=project_lead(repositories, context, source.lead_id),
            target_date=milestone.target_date,
            priority=cast(ProjectPriorityField, source.priority),
        ),
    )
    moved: list[Issue] = []
    for issue in issues:
        updated = apply_patch(
            repositories, context, issue, {"project_id": created.project_id, "project_milestone_id": None}
        )
        try:
            moved.append(store_patch(repositories, context, issue, updated))
        except HTTPException as exc:
            if exc.status_code not in (status.HTTP_404_NOT_FOUND, status.HTTP_409_CONFLICT):
                raise
    repositories.planning.delete(context.workspace_id, milestone_key(project_id, milestone_id))
    project_activity.record_milestone_converted(
        repositories, context, milestone, source.name, created.project_id, created.name
    )
    return created, moved
