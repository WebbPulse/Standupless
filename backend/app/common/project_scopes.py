"""Who owns a project label or project status, and which of them a project is offered.

A project label or status with no team belongs to the workspace: every project is
offered it and only a workspace admin changes it. One with a team belongs to
that team: only the projects on the team are offered it, and the team's admins
change it, as do the workspace's. Linear scopes its project labels and statuses
the same way, with the workspace set always shown beside a team's own.
"""

from __future__ import annotations

from typing import Iterable, Optional, Protocol, TypeVar

from fastapi import HTTPException, status

from app.common.api.dependencies.authz import FORBIDDEN_DETAIL, AuthzContext, Capability, check_capability
from app.common.api.dependencies.repositories import Repositories
from app.common.team_refs import team_not_found


class Scoped(Protocol):
    """A row that names the team owning it, or none for the workspace."""

    team_id: Optional[str]


RowT = TypeVar("RowT", bound=Scoped)


def require_scope_admin(repositories: Repositories, context: AuthzContext, team_id: Optional[str]) -> None:
    """Refuse a caller who may not change an entry of this scope, with the route's own 403 or 404.

    A workspace entry needs a workspace admin, a credential carrying `admin`
    included; a team entry needs an admin of that team, which a workspace admin
    always is.
    """
    if team_id is None:
        if not context.acts_as_workspace_admin:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=FORBIDDEN_DETAIL)
        return
    check_capability(repositories, context, Capability.TEAM_ADMIN, team_id)


def require_listed_team(repositories: Repositories, context: AuthzContext, team_id: str) -> None:
    """Refuse a team the caller cannot find, as an absent one, when a list is narrowed to it."""
    if repositories.teams.get(context.workspace_id, team_id) is None or not context.can_find_team(team_id):
        raise team_not_found(team_id)


def findable_team_ids(repositories: Repositories, context: AuthzContext) -> list[str]:
    """The teams whose own project labels and statuses a list shows this caller.

    A workspace admin finds a private team they are outside, so the workspace
    settings can show and manage what that team keeps.
    """
    teams = repositories.teams.list_for_workspace(context.workspace_id)
    return sorted(team.team_id for team in teams if context.can_find_team(team.team_id))


def offered(rows: Iterable[RowT], team_ids: Iterable[str]) -> list[RowT]:
    """The workspace's rows together with those of the given teams, the others' left out."""
    teams = set(team_ids)
    return [row for row in rows if row.team_id is None or row.team_id in teams]


def listed(rows: Iterable[RowT], team_ids: Iterable[str], team_id: Optional[str]) -> list[RowT]:
    """The rows a list answers: the workspace's with one team's, or with every team's the caller sees."""
    return offered(rows, [team_id] if team_id is not None else team_ids)


def clashing(rows: Iterable[RowT], team_id: Optional[str]) -> list[RowT]:
    """The rows a name in this scope must not repeat.

    A workspace name must be free across the workspace and every team, since
    every project is offered it; a team name must be free among the workspace's
    and that team's own, so two teams may each keep a label of the same name.
    """
    if team_id is None:
        return list(rows)
    return [row for row in rows if row.team_id is None or row.team_id == team_id]
