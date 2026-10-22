"""Duplicating an issue and converting an issue into a project, shared by the issue routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and both actions are built from the ordinary create and patch paths, so a
duplicate or a conversion leaves exactly the keys, validation, activity and
subscriptions those paths leave.

The copying rules follow Linear. A duplicate is a fresh issue in the same team
carrying what describes the work, its title with a copy suffix, description,
labels, priority, estimate, parent, project and milestone, and nothing that
describes progress on it: it starts in the team's default status, unassigned,
outside any cycle and with no dates, relations or comments. A conversion creates a
project on the issue's team named after it, with its description, priority,
assignee as lead and dates as the plan, moves its sub-issues out from under it and
into the project, then points the issue at the project and closes it.
"""

from __future__ import annotations

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.issues import TITLE_MAX, IssueCreate
from app.common.api.schemas.planning import DESCRIPTION_MAX_BYTES, NAME_MAX, ProjectCreate, ProjectRead
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import Status
from app.common.issue_rules import require_team_member, unprocessable
from app.common.issue_writes import apply_patch, create_issue, store_patch
from app.common.project_writes import create_project

COPY_SUFFIX = " (copy)"
"""What a duplicate's title ends with, so the two issues can be told apart in a list."""

PROJECT_STATUS_BY_CATEGORY: dict[str, str] = {"started": "in_progress", "unstarted": "planned"}
"""The project status a converted issue's status category maps to; any other category starts in backlog."""

CLOSING_CATEGORIES: tuple[str, ...] = ("completed", "cancelled")
"""The status categories a converted issue may close into, in order of preference."""


def duplicate_title(title: str) -> str:
    """The title a duplicate takes: the original with the copy suffix, held to the title cap."""
    return title[: TITLE_MAX - len(COPY_SUFFIX)].rstrip() + COPY_SUFFIX


def duplicate_issue(repositories: Repositories, context: AuthzContext, issue: Issue) -> Issue:
    """Create a copy of one visible issue in its own team through the ordinary create path.

    The caller must be able to write in the team, as for any new issue. The copy
    never asks for triage, though a caller the team would send there still lands
    there, as their own new issue would.
    """
    payload = IssueCreate(
        team_id=issue.team_id,
        title=duplicate_title(issue.title),
        body=issue.body,
        priority=issue.priority,
        label_ids=list(issue.label_ids),
        estimate=issue.estimate,
        parent_id=issue.parent_id,
        project_id=issue.project_id,
        project_milestone_id=issue.project_milestone_id,
    )
    return create_issue(repositories, context, payload)


def project_name(title: str) -> str:
    """A project name from an issue title, held to the project name cap."""
    return title.strip()[:NAME_MAX].rstrip()


def project_description(body: str | None) -> str | None:
    """A project description from an issue body, cut to the project byte cap on a character boundary."""
    if not body:
        return None
    encoded = body.encode("utf-8")
    if len(encoded) <= DESCRIPTION_MAX_BYTES:
        return body
    return encoded[:DESCRIPTION_MAX_BYTES].decode("utf-8", errors="ignore")


def project_lead(repositories: Repositories, context: AuthzContext, assignee_id: str | None) -> str | None:
    """The assignee as the project's lead while they are still in the workspace, else no lead.

    An assignee who has since left would otherwise refuse the whole conversion.
    """
    if assignee_id is None or repositories.memberships.get(context.workspace_id, assignee_id) is None:
        return None
    return assignee_id


def closing_status(repositories: Repositories, workspace_id: str, team_id: str) -> Status:
    """The status a converted issue closes into: the team's first completed one, else its first cancelled one.

    Completed comes first because the issue's work lives on in the project rather
    than being abandoned. A team with neither cannot close the issue, so the
    conversion is refused before anything is written.
    """
    rows = repositories.team_config.list_statuses(workspace_id, team_id, include_hidden=False)
    for category in CLOSING_CATEGORIES:
        matching = [row for row in rows if row.category == category]
        if matching:
            return sorted(matching, key=lambda row: (row.position, row.name))[0]
    raise unprocessable("This team has no completed or cancelled status to close the issue into")


def convert_to_project(
    repositories: Repositories, context: AuthzContext, issue: Issue
) -> tuple[ProjectRead, Issue, list[Issue]]:
    """Turn one visible issue into a project, answering the project, the closed issue and the moved sub-issues.

    What can refuse is checked before the project is written: the caller writing
    in the team, a status to close into and a usable name. The project is on the
    issue's own team, which every sub-issue shares, so each one accepts it. The
    sub-issues and the issue are then written through the ordinary patch path, so
    each change records its own activity.
    """
    require_team_member(repositories, context, issue.team_id)
    closing = closing_status(repositories, context.workspace_id, issue.team_id)
    category = next(
        (
            row.category
            for row in repositories.team_config.list_statuses(context.workspace_id, issue.team_id)
            if row.status_id == issue.status_id
        ),
        None,
    )
    name = project_name(issue.title)
    if not name:
        raise unprocessable("An issue needs a title to become a project")
    start_date = issue.start_date
    target_date = issue.due_date if not start_date or not issue.due_date or issue.due_date >= start_date else None
    created = ProjectCreate(
        team_ids=[issue.team_id],
        name=name,
        description=project_description(issue.body),
        lead_id=project_lead(repositories, context, issue.assignee_id),
        start_date=start_date,
        target_date=target_date,
        status=PROJECT_STATUS_BY_CATEGORY.get(category or "", "backlog"),
        priority=issue.priority,
    )
    children = repositories.issues.iter_children(context.workspace_id, issue.issue_id)

    project = create_project(repositories, context, created)
    moved: list[Issue] = []
    for child in children:
        updated = apply_patch(repositories, context, child, {"parent_id": None, "project_id": project.project_id})
        moved.append(store_patch(repositories, context, child, updated))
    closed = apply_patch(
        repositories,
        context,
        issue,
        {"project_id": project.project_id, "status_id": closing.status_id},
    )
    return project, store_patch(repositories, context, issue, closed), moved
