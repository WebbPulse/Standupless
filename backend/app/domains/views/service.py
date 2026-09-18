"""Decisions the views, board, search and inbox routes need before they read.

Every surface here is workspace scoped with the project in a query parameter or on
the row rather than in the path, so the authorization dependency cannot resolve it
and each route makes the same decision against the project the data actually
belongs to. Spelled once, so widening any of it is a one-line diff.
"""

from __future__ import annotations

from typing import Iterable, Sequence

from fastapi import HTTPException, status

from app.common.api.dependencies.authz import IMPLIED_PROJECT_ROLE, AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.views import SavedView, personal_view_key

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

FORBIDDEN = {"error_code": "FORBIDDEN", "message": "Not allowed"}

ME = "me"
"""What a caller writes instead of their own id in an assignee filter.

Accepted so a saved board filter is portable between members rather than carrying
one member's id, and resolved from the authorization context so it can never name
anyone else.
"""


def not_found() -> HTTPException:
    """The 404 an invisible or absent resource both get.

    One helper because the two must be indistinguishable: a 403 on an invisible
    project would confirm it exists and let the project set be enumerated.
    """
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)


def forbidden() -> HTTPException:
    """The 403 a caller who can see a resource but may not change it gets."""
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=FORBIDDEN)


def invalid_filter(unknown: Sequence[str]) -> HTTPException:
    """The contract's `INVALID_FILTER` 422, for a filter key outside the set.

    Names the offending keys, because a saved view's filter is expanded into the
    issue list query and a key that quietly did nothing would look like a filter
    that matched everything.
    """
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={
            "error_code": "INVALID_FILTER",
            "message": f"filter carries unknown keys: {', '.join(unknown)}",
        },
    )


def query_too_short() -> HTTPException:
    """The contract's `QUERY_TOO_SHORT` 422, when no term survives tokenizing."""
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={
            "error_code": "QUERY_TOO_SHORT",
            "message": "Search terms must be at least four characters",
        },
    )


def unprocessable(message: str) -> HTTPException:
    """A 422 carrying the product's ordinary validation envelope."""
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={"error_code": "VALIDATION_ERROR", "message": message},
    )


def visible_project_ids(repositories: Repositories, context: AuthzContext) -> list[str]:
    """Every project of this workspace the caller may read, in a stable order.

    The board and the search fan-outs read this rather than filtering rows
    afterwards, so an issue in an invisible project is never fetched at all and
    cannot influence a result set the caller then sees a count of.
    """
    projects = repositories.projects.list_for_workspace(context.workspace_id)
    return sorted(project.project_id for project in projects if context.can_see_project(project.project_id))


def project_role(repositories: Repositories, context: AuthzContext, project_id: str) -> str | None:
    """The caller's role on one project, explicit membership winning over implied."""
    membership = repositories.memberships.get_project_membership(context.workspace_id, project_id, context.user_id)
    if membership is not None:
        return membership.role
    return IMPLIED_PROJECT_ROLE.get(context.role)


def require_project_reader(repositories: Repositories, context: AuthzContext, project_id: str) -> None:
    """Hold that the caller may read one project, or 404.

    A guest outside the project gets the same answer as for a project that never
    existed, which is what the contract means by a board being 404 rather than
    empty.
    """
    if not context.can_see_project(project_id):
        raise not_found()
    if repositories.projects.get(context.workspace_id, project_id) is None:
        raise not_found()


def require_project_member(repositories: Repositories, context: AuthzContext, project_id: str) -> None:
    """Hold that the caller may write in one project, or 404 or 403."""
    require_project_reader(repositories, context, project_id)
    if project_role(repositories, context, project_id) is None:
        raise forbidden()


def is_project_admin(repositories: Repositories, context: AuthzContext, project_id: str) -> bool:
    """Whether the caller administers one project."""
    if context.is_workspace_admin:
        return True
    return project_role(repositories, context, project_id) == "admin"


def resolve_assignee(context: AuthzContext, assignee_id: str | None) -> str | None:
    """An assignee filter with `me` resolved to the caller's own id.

    Resolved from the context rather than the query, so `me` can only ever mean the
    caller and a saved filter carrying it stays correct for whoever runs it.
    """
    if not assignee_id:
        return None
    if assignee_id == ME:
        return context.user_id
    return assignee_id


def load_visible_view(repositories: Repositories, context: AuthzContext, view_id: str) -> SavedView:
    """One saved view the caller may read, or a 404.

    Looked for only under the keys this caller could hold: their own personal key
    and the project keys of the projects they can see. A view they may not read is
    therefore never found rather than found and then refused, so the two cases are
    indistinguishable without a second decision.
    """
    view = repositories.views.find(
        context.workspace_id,
        view_id,
        context.user_id,
        visible_project_ids(repositories, context),
    )
    if view is None:
        raise not_found()
    return view


def require_view_writer(repositories: Repositories, context: AuthzContext, view: SavedView) -> None:
    """Hold that the caller may change one saved view, or 403.

    A personal view is its owner's alone, and a project view is the owner's or a
    project admin's. Reaching here means the view was already found, so the
    resource is not in doubt and only the verb is, which is what makes this a 403
    rather than another 404.
    """
    if view.owner_id == context.user_id:
        return
    if view.project_id and is_project_admin(repositories, context, view.project_id):
        return
    raise forbidden()


def owned_personal_key(context: AuthzContext, view_id: str) -> str:
    """The sort key one member's own view of this id would take."""
    return personal_view_key(context.user_id, view_id)


def readable_projects(repositories: Repositories, context: AuthzContext, project_id: str | None) -> list[str]:
    """The projects one fan-out covers: the named one, or every visible one.

    A named project the caller cannot see is a 404 rather than an empty answer, so
    a guest cannot use an empty result to learn that a project exists.
    """
    if project_id:
        require_project_reader(repositories, context, project_id)
        return [project_id]
    return visible_project_ids(repositories, context)


def matches_filters(
    issue: object,
    *,
    assignee_id: str | None,
    label_id: str | None,
    priority: str | None,
) -> bool:
    """Whether one issue passes the board's post-read filters.

    The status index is what the column is read by, so these three are applied
    after the read rather than in the key condition. They narrow a column the
    caller is already entitled to see, so applying them late costs correctness
    nothing.
    """
    if assignee_id and getattr(issue, "assignee_id", None) != assignee_id:
        return False
    if label_id and label_id not in (getattr(issue, "label_ids", None) or ()):
        return False
    if priority and getattr(issue, "priority", None) != priority:
        return False
    return True


def visible_issue_ids(
    repositories: Repositories,
    context: AuthzContext,
    issue_ids: Iterable[str],
) -> list[str]:
    """Only those issue ids whose project this caller may read, order kept."""
    kept: list[str] = []
    for issue_id in issue_ids:
        issue = repositories.issues.get(context.workspace_id, issue_id)
        if issue is None:
            continue
        if not context.can_see_project(issue.project_id):
            continue
        kept.append(issue_id)
    return kept
