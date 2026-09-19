"""Decisions a planning write needs that a schema cannot make on its own.

Whether a project is readable, whether a cycle or milestone belongs to the project
a caller named, and whether the caller may write in it each need a table read, so
they live here rather than in a pydantic validator. The rules are spelled the same
way the issues domain spells them, because a planning row is filed under a project
and inherits that project's visibility exactly.
"""

from __future__ import annotations

from fastapi import HTTPException, status

from app.common.api.dependencies.authz import IMPLIED_PROJECT_ROLE, AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.planning import Cycle, Milestone

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}


def unprocessable(message: str) -> HTTPException:
    """A 422 carrying the product's error envelope."""
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={"error_code": "VALIDATION_ERROR", "message": message},
    )


def not_found() -> HTTPException:
    """The 404 an invisible or absent planning row gets.

    Invisible and absent look identical, or a caller outside a project could probe
    for the cycles it holds by watching which ids answer differently.
    """
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)


def forbidden() -> HTTPException:
    """The 403 a reader who may not write gets.

    Only reached once the project is known to be visible, so nothing about the
    workspace's shape leaks through it.
    """
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={"error_code": "FORBIDDEN", "message": "Not allowed"},
    )


def visible_project_ids(repositories: Repositories, context: AuthzContext) -> list[str]:
    """Every project of the workspace this caller may read, in a stable order.

    The roadmap fans out over this rather than filtering rows afterwards, so a
    project the caller is outside is never queried in the first place.
    """
    projects = repositories.projects.list_for_workspace(context.workspace_id)
    return sorted(project.project_id for project in projects if context.can_see_project(project.project_id))


def project_role(repositories: Repositories, context: AuthzContext, project_id: str) -> str | None:
    """The caller's role on one project, explicit membership winning over implied.

    The authorization dependency resolves this for a project in the path, and these
    routes carry the project in the query or the body instead, so the same decision
    is made here against the project the row actually belongs to.
    """
    membership = repositories.memberships.get_project_membership(context.workspace_id, project_id, context.user_id)
    if membership is not None:
        return membership.role
    return IMPLIED_PROJECT_ROLE.get(context.role)


def require_project_reader(repositories: Repositories, context: AuthzContext, project_id: str) -> None:
    """Hold that the caller may read one project, or 404."""
    if not context.can_see_project(project_id):
        raise not_found()
    if repositories.projects.get(context.workspace_id, project_id) is None:
        raise not_found()


def require_project_member(repositories: Repositories, context: AuthzContext, project_id: str) -> None:
    """Hold that the caller may write in one project, or 404 or 403."""
    require_project_reader(repositories, context, project_id)
    if project_role(repositories, context, project_id) is None:
        raise forbidden()


def require_project_admin(repositories: Repositories, context: AuthzContext, project_id: str) -> None:
    """Hold that the caller administers one project, or 404 or 403.

    Deleting a cycle or a milestone detaches every issue pointing at it, so it is an
    administrator's call rather than any member's.
    """
    require_project_reader(repositories, context, project_id)
    if context.is_workspace_admin:
        return
    if project_role(repositories, context, project_id) != "admin":
        raise forbidden()


def load_readable_cycle(
    repositories: Repositories,
    context: AuthzContext,
    project_id: str,
    cycle_id: str,
) -> Cycle:
    """One cycle the caller may read, or a 404."""
    require_project_reader(repositories, context, project_id)
    cycle = repositories.planning.get_cycle(context.workspace_id, project_id, cycle_id)
    if cycle is None:
        raise not_found()
    return cycle


def load_readable_milestone(
    repositories: Repositories,
    context: AuthzContext,
    project_id: str,
    milestone_id: str,
) -> Milestone:
    """One milestone the caller may read, or a 404."""
    require_project_reader(repositories, context, project_id)
    milestone = repositories.planning.get_milestone(context.workspace_id, project_id, milestone_id)
    if milestone is None:
        raise not_found()
    return milestone


def check_dates(start_date: str, end_date: str) -> None:
    """Refuse a cycle whose end date precedes its start date.

    Spelled here as well as in the create schema because a patch can move either
    date on its own, and only the merged pair says whether the result is coherent.
    """
    if end_date < start_date:
        raise unprocessable("end_date must not be before start_date")
