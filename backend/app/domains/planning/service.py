"""Decisions a planning write needs that a schema cannot make on its own.

Whether a team is readable, whether a cycle or project belongs to the team
a caller named, and whether the caller may write in it each need a table read, so
they live here rather than in a pydantic validator. The rules are spelled the same
way the issues domain spells them, because a planning row is filed under a team
and inherits that team's visibility exactly.
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


def load_readable_project(
    repositories: Repositories,
    context: AuthzContext,
    team_id: str,
    project_id: str,
) -> Project:
    """One project the caller may read, or a 404."""
    require_team_reader(repositories, context, team_id)
    project = repositories.planning.get_project(context.workspace_id, team_id, project_id)
    if project is None:
        raise not_found()
    return project


def check_dates(start_date: str, end_date: str) -> None:
    """Refuse a cycle whose end date precedes its start date.

    Spelled here as well as in the create schema because a patch can move either
    date on its own, and only the merged pair says whether the result is coherent.
    """
    if end_date < start_date:
        raise unprocessable("end_date must not be before start_date")
