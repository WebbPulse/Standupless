"""Decisions the views, board, search and inbox routes need before they read.

Every surface here is workspace scoped with the team in a query parameter or on
the row rather than in the path, so the authorization dependency cannot resolve it
and each route makes the same decision against the team the data actually
belongs to. Spelled once, so widening any of it is a one-line diff.
"""

from __future__ import annotations

from fastapi import HTTPException, status

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.issue_rules import require_team_reader, team_role, visible_team_ids

FORBIDDEN = {"error_code": "FORBIDDEN", "message": "Not allowed"}

ME = "me"
"""What a caller writes instead of their own id in an assignee filter.

Accepted so a saved board filter is portable between members rather than carrying
one member's id, and resolved from the authorization context so it can never name
anyone else.
"""


def forbidden() -> HTTPException:
    """The 403 a caller who can see a resource but may not change it gets."""
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=FORBIDDEN)


def query_too_short() -> HTTPException:
    """The contract's `QUERY_TOO_SHORT` 422, when no term survives tokenizing."""
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={
            "error_code": "QUERY_TOO_SHORT",
            "message": "Search terms must be at least four characters",
        },
    )


def is_team_admin(repositories: Repositories, context: AuthzContext, team_id: str) -> bool:
    """Whether the caller administers one team."""
    if context.is_workspace_admin:
        return True
    return team_role(repositories, context, team_id) == "admin"


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


def readable_teams(repositories: Repositories, context: AuthzContext, team_id: str | None) -> list[str]:
    """The teams one fan-out covers: the named one, or every visible one.

    A named team the caller cannot see is a 404 rather than an empty answer, so
    a guest cannot use an empty result to learn that a team exists.
    """
    if team_id:
        require_team_reader(repositories, context, team_id)
        return [team_id]
    return visible_team_ids(repositories, context)


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
