"""Decisions a planning write needs that a schema cannot make on its own.

Whether a team is readable, whether a cycle belongs to the team a caller named, and
whether the caller may write in it each need a table read, so they live here rather
than in a pydantic validator. The rules are spelled the same way the issues domain
spells them, because a cycle is filed under a team and inherits that team's
visibility exactly.

A project belongs to one or more teams, and the rule for it is spelled here too:
a caller sees a project when they can see at least one of its teams, edits its
fields when they can write in at least one of the teams they see, changes its team
list only when they can write in every team added or removed, and deletes it only
when they administer every one of its teams. Every refusal on an invisible project
is the same 404 an absent one gets.
"""

from __future__ import annotations

from fastapi import HTTPException, status

from app.common.api.dependencies.authz import IMPLIED_TEAM_ROLE, AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.planning import Cycle, Project

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}


def unprocessable(message: str) -> HTTPException:
    """A 422 carrying the product's error envelope."""
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={"error_code": "VALIDATION_ERROR", "message": message},
    )


def not_found() -> HTTPException:
    """The 404 an invisible or absent planning row gets.

    Invisible and absent look identical, or a caller outside a team could probe
    for the cycles it holds by watching which ids answer differently.
    """
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)


def forbidden() -> HTTPException:
    """The 403 a reader who may not write gets.

    Only reached once the team is known to be visible, so nothing about the
    workspace's shape leaks through it.
    """
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={"error_code": "FORBIDDEN", "message": "Not allowed"},
    )


def visible_team_ids(repositories: Repositories, context: AuthzContext) -> list[str]:
    """Every team of the workspace this caller may read, in a stable order.

    The roadmap fans out over this rather than filtering rows afterwards, so a
    team the caller is outside is never queried in the first place.
    """
    teams = repositories.teams.list_for_workspace(context.workspace_id)
    return sorted(team.team_id for team in teams if context.can_see_team(team.team_id))


def team_role(repositories: Repositories, context: AuthzContext, team_id: str) -> str | None:
    """The caller's role on one team, explicit membership winning over implied.

    The authorization dependency resolves this for a team in the path, and these
    routes carry the team in the query or the body instead, so the same decision
    is made here against the team the row actually belongs to.
    """
    membership = repositories.memberships.get_team_membership(context.workspace_id, team_id, context.user_id)
    if membership is not None:
        return membership.role
    return IMPLIED_TEAM_ROLE.get(context.role)


def require_team_reader(repositories: Repositories, context: AuthzContext, team_id: str) -> None:
    """Hold that the caller may read one team, or 404."""
    if not context.can_see_team(team_id):
        raise not_found()
    if repositories.teams.get(context.workspace_id, team_id) is None:
        raise not_found()


def require_team_member(repositories: Repositories, context: AuthzContext, team_id: str) -> None:
    """Hold that the caller may write in one team, or 404 or 403."""
    require_team_reader(repositories, context, team_id)
    if team_role(repositories, context, team_id) is None:
        raise forbidden()


def require_team_admin(repositories: Repositories, context: AuthzContext, team_id: str) -> None:
    """Hold that the caller administers one team, or 404 or 403.

    Deleting a cycle or a project detaches every issue pointing at it, so it is an
    administrator's call rather than any member's.
    """
    require_team_reader(repositories, context, team_id)
    if context.is_workspace_admin:
        return
    if team_role(repositories, context, team_id) != "admin":
        raise forbidden()


def load_readable_cycle(
    repositories: Repositories,
    context: AuthzContext,
    team_id: str,
    cycle_id: str,
) -> Cycle:
    """One cycle the caller may read, or a 404."""
    require_team_reader(repositories, context, team_id)
    cycle = repositories.planning.get_cycle(context.workspace_id, team_id, cycle_id)
    if cycle is None:
        raise not_found()
    return cycle


def visible_project_teams(project: Project, visible: list[str] | set[str]) -> list[str]:
    """The project's teams this caller can see, in the project's own order."""
    return [team_id for team_id in project.team_ids if team_id in visible]


def load_readable_project(
    repositories: Repositories,
    context: AuthzContext,
    project_id: str,
    team_id: str | None = None,
) -> tuple[Project, list[str]]:
    """One project the caller may read with the teams they see on it, or a 404.

    Seeing any one of its teams is enough to see the project. A `team_id` named
    by an older client narrows nothing but must be one of those visible teams,
    which keeps the single-team reads it used to make answering exactly as before.
    """
    project = repositories.planning.get_project(context.workspace_id, project_id)
    if project is None:
        raise not_found()
    teams = visible_project_teams(project, set(visible_team_ids(repositories, context)))
    if not teams:
        raise not_found()
    if team_id is not None and team_id not in teams:
        raise not_found()
    return project, teams


def require_project_editor(repositories: Repositories, context: AuthzContext, teams: list[str]) -> None:
    """Hold that the caller may write in at least one visible team of a project, or 403.

    Editing a project's own fields changes nothing any one team owns alone, so a
    writer on any of its teams may make it, which is how Linear treats a project
    shared between teams.
    """
    for team_id in teams:
        if team_role(repositories, context, team_id) is not None:
            return
    raise forbidden()


def require_project_admin(repositories: Repositories, context: AuthzContext, project: Project) -> None:
    """Hold that the caller administers every team of a project, or 404 or 403.

    Deleting a project detaches issues in every one of its teams, so it takes an
    administrator of each rather than of any. The project is already known to be
    visible, so a team the caller cannot see is the same 403 as one they cannot
    administer, which names nothing about it.
    """
    for team_id in project.team_ids:
        if repositories.teams.get(context.workspace_id, team_id) is None:
            continue
        if not context.can_see_team(team_id):
            raise forbidden()
        require_team_admin(repositories, context, team_id)


def require_team_changes(repositories: Repositories, context: AuthzContext, changed: list[str]) -> None:
    """Hold that the caller may write in every team being added to or removed from a project.

    Attaching a project to a team puts it on that team's planning, and detaching it
    takes it off, so each is that team's call. An absent or invisible team is a 404
    and a visible team the caller may not write in is a 403.
    """
    for team_id in changed:
        require_team_member(repositories, context, team_id)


def require_workspace_member(repositories: Repositories, context: AuthzContext, user_id: str) -> None:
    """Hold that a user named on a project, such as its lead, is in the workspace, or 422."""
    if repositories.memberships.get(context.workspace_id, user_id) is None:
        raise unprocessable(f"No such workspace member: {user_id}")


def check_project_dates(start_date: str | None, target_date: str | None) -> None:
    """Refuse a project whose target date precedes its start date, once a patch is merged."""
    if start_date and target_date and target_date < start_date:
        raise unprocessable("target_date must not be before start_date")


def check_dates(start_date: str, end_date: str) -> None:
    """Refuse a cycle whose end date precedes its start date.

    Spelled here as well as in the create schema because a patch can move either
    date on its own, and only the merged pair says whether the result is coherent.
    """
    if end_date < start_date:
        raise unprocessable("end_date must not be before start_date")
