"""Team routes: create, read, list, update and delete a team.

Reading and listing go through the authorization dependency, which is what makes
a guest see only the teams they hold a membership in. The list route filters
with `AuthzContext.can_see_team` rather than a query of its own, so the same
decision that guards a single team guards the collection.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from webbpulse.dynamodb import ConditionFailed, TransactionCanceled

from app.common.api.dependencies.authz import (
    IMPLIED_TEAM_ROLE,
    AuthzContext,
    Capability,
    require,
)
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.memberships import Membership, team_member_key
from app.common.db.dynamo.teams import Team, new_team_id
from app.domains.teams.schemas.team import (
    TeamCreate,
    TeamListRead,
    TeamRead,
    TeamUpdate,
)

router = APIRouter()

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

PREFIX_TAKEN = {"error_code": "CONFLICT", "message": "That team key prefix is in use"}


@router.get("/{workspace_id}/teams", response_model=TeamListRead)
def list_teams(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TeamListRead:
    """Every team in the workspace the caller may see.

    A guest sees only the teams they are a member of, which is the same rule
    the single team route applies, read off the context rather than repeated.
    """
    teams = repositories.teams.list_for_workspace(context.workspace_id)
    visible = [team for team in teams if context.can_see_team(team.team_id)]
    roles = _team_roles(repositories, context, [p.team_id for p in visible])
    return TeamListRead(teams=[TeamRead.from_row(p, roles.get(p.team_id)) for p in visible])


@router.post("/{workspace_id}/teams", response_model=TeamRead, status_code=status.HTTP_201_CREATED)
def create_team(
    payload: TeamCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_CREATE))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TeamRead:
    """Create a team, make the caller its admin and seed the default statuses.

    All three land as one `TransactWriteItems` across the three tables, seven items
    in total, because a team written without its statuses is unusable and cannot
    be recreated: the prefix is taken, so a retry 409s while issue creation 422s on
    the missing statuses. All or nothing means a failure leaves the prefix free.
    """
    team = Team(
        workspace_id=context.workspace_id,
        team_id=new_team_id(),
        name=payload.name,
        key_prefix=payload.key_prefix,
        estimate_scale=payload.estimate_scale,
    )
    membership = Membership(
        workspace_id=context.workspace_id,
        member_key=team_member_key(team.team_id, context.user_id),
        user_id=context.user_id,
        role="admin",
        team_id=team.team_id,
    )
    statuses = repositories.team_config.default_statuses(context.workspace_id, team.team_id)
    try:
        actions = [
            repositories.teams.create_action(team),
            repositories.memberships.put_action(membership),
            *(repositories.team_config.create_status_action(row) for row in statuses),
        ]
        repositories.teams.transact_write(actions)
    except ConditionFailed as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=PREFIX_TAKEN) from exc
    except TransactionCanceled as exc:
        if not exc.conditional_check_failed:
            raise
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=PREFIX_TAKEN) from exc
    return TeamRead.from_row(team, "admin")


@router.get("/{workspace_id}/teams/{team_id}", response_model=TeamRead)
def read_team(
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TeamRead:
    """One team the caller may read, carrying their team role."""
    team = _load(repositories, context)
    return TeamRead.from_row(team, context.team_role)


@router.patch("/{workspace_id}/teams/{team_id}", response_model=TeamRead)
def update_team(
    payload: TeamUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TeamRead:
    """Change a team's name, description or estimate scale."""
    attributes = payload.model_dump(exclude_unset=True, exclude_none=True)
    if not attributes:
        return TeamRead.from_row(_load(repositories, context), context.team_role)

    updated = repositories.teams.update(context.workspace_id, str(context.team_id), **attributes)
    if updated is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return TeamRead.from_row(updated, context.team_role)


@router.delete("/{workspace_id}/teams/{team_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_team(
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_DELETE))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Delete a team and the configuration and counters that hang off it.

    The team row goes last, so a crash leaves an empty team rather than
    orphaned statuses nothing can reach.
    """
    team_id = str(context.team_id)
    repositories.team_config.delete_for_team(context.workspace_id, team_id)
    repositories.counters.delete_for_team(context.workspace_id, team_id)
    repositories.teams.delete(context.workspace_id, team_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _load(repositories: Repositories, context: AuthzContext) -> Team:
    """The team named in the path, or a 404.

    Authorization has already run, so a missing row here means the team was
    deleted between the membership read and this one.
    """
    team = repositories.teams.get(context.workspace_id, str(context.team_id))
    if team is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return team


def _team_roles(repositories: Repositories, context: AuthzContext, team_ids: list[str]) -> dict[str, str]:
    """The caller's role on each listed team, explicit membership winning.

    A workspace owner or admin implies team admin, and a member implies team
    member, which is the mapping the contract states for the `role` field.
    """
    implied = IMPLIED_TEAM_ROLE.get(context.role)
    roles: dict[str, str] = {}
    if implied is not None:
        roles = {team_id: implied for team_id in team_ids}

    memberships = repositories.memberships.list_team_memberships_for_user(context.workspace_id, context.user_id)
    for membership in memberships:
        if membership.team_id in team_ids:
            roles[membership.team_id] = membership.role
    return roles
