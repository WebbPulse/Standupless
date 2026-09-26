"""Decisions an issue write needs that a schema cannot make on its own.

Estimates are validated against the team's own `estimate_scale`, labels against
the team's label set, and an assignee against team readership, so each of
these needs a table read and belongs here rather than in a pydantic validator. The
routes stay thin and every rule has one home.
"""

from __future__ import annotations

from typing import Any, Iterable

from fastapi import HTTPException, status

from app.common.api.dependencies.authz import IMPLIED_TEAM_ROLE, AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import Status

FIBONACCI_ESTIMATES: tuple[str, ...] = ("1", "2", "3", "5", "8", "13", "21")

LINEAR_ESTIMATES: tuple[str, ...] = tuple(str(value) for value in range(1, 11))

TSHIRT_ESTIMATES: tuple[str, ...] = ("XS", "S", "M", "L", "XL")

COMPLETED_CATEGORIES: frozenset[str] = frozenset({"completed", "cancelled"})
"""Which status categories count an issue as finished for the parent's rollup.

The contract counts a cancelled child as done: it is resolved, so leaving it
pending would mean a parent could never reach full progress.
"""

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}


def unprocessable(message: str) -> HTTPException:
    """A 422 carrying the product's error envelope.

    Spelled once because every validation below answers the same shape, and a bare
    `HTTPException` would otherwise return a string detail the client cannot read.
    """
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={"error_code": "VALIDATION_ERROR", "message": message},
    )


def not_found() -> HTTPException:
    """The 404 an invisible issue, team or link gets.

    Invisible and absent must look identical, or a caller could probe for issues in
    teams they are outside.
    """
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)


def allowed_estimates(scale: str) -> tuple[str, ...]:
    """Every estimate one scale accepts, empty when the scale is off."""
    if scale == "fibonacci":
        return FIBONACCI_ESTIMATES
    if scale == "linear":
        return LINEAR_ESTIMATES
    if scale == "tshirt":
        return TSHIRT_ESTIMATES
    return ()


def check_estimate(estimate: str | None, scale: str) -> str | None:
    """Hold an estimate to the team's scale, or raise a 422.

    The scale is a team setting rather than a global one, so this cannot live in
    the schema: the team has to be read before the value can be judged.
    """
    if estimate is None:
        return None
    candidate = estimate.strip()
    if not candidate:
        return None
    if scale == "off":
        raise unprocessable("This team has estimates turned off")
    permitted = allowed_estimates(scale)
    if candidate not in permitted:
        raise unprocessable(f"estimate must be one of: {', '.join(permitted)}")
    return candidate


def check_labels(repositories: Repositories, workspace_id: str, team_id: str, label_ids: Iterable[str]) -> list[str]:
    """Hold every label to the team's own set, dropping duplicates.

    A label from another team would render as a missing chip rather than an
    error, so it is refused at the write instead of tolerated on the row.
    """
    wanted = [label_id for label_id in dict.fromkeys(label_ids) if label_id]
    for label_id in wanted:
        if repositories.team_config.get_label(workspace_id, team_id, label_id) is None:
            raise unprocessable(f"No such label: {label_id}")
    return wanted


def check_status(repositories: Repositories, workspace_id: str, team_id: str, status_id: str) -> Status:
    """The named status of this team, or a 422.

    Read back rather than trusted because an issue's board partition is composed
    from the status id, and an unknown one would index the row into a column no
    query ever names.
    """
    row = repositories.team_config.get_status(workspace_id, team_id, status_id)
    if row is None:
        raise unprocessable(f"No such status: {status_id}")
    return row


def default_status(repositories: Repositories, workspace_id: str, team_id: str) -> Status:
    """The status a new issue lands in: the lowest-position `backlog` one.

    Falls back to the lowest-position status of any category, because a team
    whose backlog statuses were all deleted must still accept an issue.
    """
    rows = repositories.team_config.list_statuses(workspace_id, team_id)
    if not rows:
        raise unprocessable("This team has no statuses")
    backlog = [row for row in rows if row.category == "backlog"]
    candidates = backlog or rows
    return sorted(candidates, key=lambda row: (row.position, row.name))[0]


def check_assignee(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    assignee_id: str | None,
) -> str | None:
    """Hold an assignee to being someone who can read the team, or raise a 422.

    A guest only reads the teams they hold a membership in, so assigning one an
    issue in a team they cannot open would hide it from them entirely.
    """
    if not assignee_id:
        return None
    membership = repositories.memberships.get(workspace_id, assignee_id)
    if membership is None:
        raise unprocessable("The assignee is not a member of this workspace")
    if membership.role != "guest":
        return assignee_id
    team_membership = repositories.memberships.get_team_membership(workspace_id, team_id, assignee_id)
    if team_membership is None:
        raise unprocessable("The assignee cannot see this team")
    return assignee_id


def check_parent(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    issue_id: str | None,
    parent_id: str | None,
) -> str | None:
    """Hold a parent to the contract's three rules, or raise a 422.

    Same team, never itself, and at most one level deep: a child cannot itself
    have children, which is what keeps `progress` a count of direct children rather
    than a tree walk.
    """
    if not parent_id:
        return None
    if issue_id is not None and parent_id == issue_id:
        raise unprocessable("An issue cannot be its own parent")

    parent = repositories.issues.get(workspace_id, parent_id)
    if parent is None:
        raise unprocessable(f"No such issue: {parent_id}")
    if parent.team_id != team_id:
        raise unprocessable("A parent must be in the same team")
    if parent.parent_id:
        raise unprocessable("Sub-issues are one level deep")
    if issue_id is not None and repositories.issues.has_children(workspace_id, issue_id):
        raise unprocessable("An issue with children cannot become a sub-issue")
    return parent_id


def check_cycle(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    cycle_id: str | None,
) -> str | None:
    """Hold a cycle to being one of this team's, or raise a 422.

    A cycle from another team would count this issue into a bar its own team
    never sees, and the planning rollup has no way to notice, so the attachment is
    refused at the write rather than tolerated on the row.
    """
    if not cycle_id:
        return None
    if repositories.planning.get_cycle(workspace_id, team_id, cycle_id) is None:
        raise unprocessable(f"No such cycle: {cycle_id}")
    return cycle_id


def check_project(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    project_id: str | None,
) -> str | None:
    """Hold a project to being on this issue's team, or raise a 422.

    A project spans one or more teams, and an issue may join it only from one of
    them, so the project's own team list is what decides. A project not on this
    team reads as absent, which tells the caller nothing about other teams.
    """
    if not project_id:
        return None
    project = repositories.planning.get_project(workspace_id, project_id)
    if project is None or team_id not in project.team_ids:
        raise unprocessable(f"No such project: {project_id}")
    return project_id


def check_project_milestone(
    repositories: Repositories,
    workspace_id: str,
    project_id: str | None,
    milestone_id: str | None,
) -> str | None:
    """Hold a milestone to being one of the issue's own project's, or raise a 422.

    A milestone is a stage of one project, so an issue outside that project, or
    in no project, cannot sit in it.
    """
    if not milestone_id:
        return None
    if not project_id:
        raise unprocessable("project_milestone_id needs a project_id")
    if repositories.planning.get_milestone(workspace_id, project_id, milestone_id) is None:
        raise unprocessable(f"No such milestone: {milestone_id}")
    return milestone_id


def visible_team_ids(repositories: Repositories, context: AuthzContext) -> list[str]:
    """Every team of the workspace this caller may read, in a stable order.

    The fan-out list reads this rather than filtering rows afterwards, so an issue
    in an invisible team is never fetched in the first place.
    """
    teams = repositories.teams.list_for_workspace(context.workspace_id)
    return sorted(team.team_id for team in teams if context.can_see_team(team.team_id))


def team_role(repositories: Repositories, context: AuthzContext, team_id: str) -> str | None:
    """The caller's role on one team, explicit membership winning over implied.

    The authorization dependency resolves this for the team in the path, and the
    issue routes carry the team in the body or on the row instead, so the same
    decision is made here against the team the issue actually belongs to.
    """
    membership = repositories.memberships.get_team_membership(context.workspace_id, team_id, context.user_id)
    if membership is not None:
        return membership.role
    return IMPLIED_TEAM_ROLE.get(context.role)


def require_team_reader(repositories: Repositories, context: AuthzContext, team_id: str) -> None:
    """Hold that the caller may read one team, or 404.

    A guest outside the team gets the same answer as for an issue that never
    existed, which is what keeps the team set unenumerable.
    """
    if not context.can_see_team(team_id):
        raise not_found()
    if repositories.teams.get(context.workspace_id, team_id) is None:
        raise not_found()


def require_team_member(repositories: Repositories, context: AuthzContext, team_id: str) -> None:
    """Hold that the caller may write in one team, or 404 or 403.

    Invisibility is a 404 so nothing leaks, but a caller who can see the team and
    still may not write gets a 403: the resource is not in doubt, only the verb.
    """
    require_team_reader(repositories, context, team_id)
    role = team_role(repositories, context, team_id)
    if role is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error_code": "FORBIDDEN", "message": "Not allowed"},
        )


def require_team_admin(repositories: Repositories, context: AuthzContext, team_id: str) -> None:
    """Hold that the caller administers one team, or 404 or 403."""
    require_team_reader(repositories, context, team_id)
    if context.is_workspace_admin:
        return
    if team_role(repositories, context, team_id) != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error_code": "FORBIDDEN", "message": "Not allowed"},
        )


def load_visible_issue(repositories: Repositories, context: AuthzContext, issue_id: str) -> Issue:
    """One issue the caller may read, or a 404.

    Every issue route starts here, so an issue in a team the caller is outside is
    indistinguishable from one that was never created.
    """
    issue = repositories.issues.get(context.workspace_id, issue_id)
    if issue is None:
        raise not_found()
    if not context.can_see_team(issue.team_id):
        raise not_found()
    return issue


def status_categories(repositories: Repositories, workspace_id: str, team_id: str) -> dict[str, str]:
    """Each status id of one team mapped to its category.

    Read once per rollup rather than per child, because counting a parent's
    completed children needs the category of every child's status.
    """
    rows = repositories.team_config.list_statuses(workspace_id, team_id)
    return {row.status_id: row.category for row in rows}


def count_progress(children: list[Issue], categories: dict[str, str]) -> tuple[int, int]:
    """One parent's rollup: how many direct children, and how many are finished."""
    total = len(children)
    completed = sum(1 for child in children if categories.get(child.status_id) in COMPLETED_CATEGORIES)
    return total, completed


def changed_fields(before: Issue, after: Issue, fields: Iterable[str]) -> list[tuple[str, Any, Any]]:
    """Each named field whose value actually moved, as `(field, from, to)`.

    Compared after the write is assembled rather than from the request body, so a
    patch that sets a field to what it already held writes no activity row.
    """
    changes: list[tuple[str, Any, Any]] = []
    for field in fields:
        old = getattr(before, field)
        new = getattr(after, field)
        if old != new:
            changes.append((field, old, new))
    return changes
