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

from app.common import issue_keys, team_purge
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
    memberships = repositories.memberships.list_all_team_memberships(context.workspace_id)
    counts: dict[str, int] = {}
    joined: set[str] = set()
    for membership in memberships:
        if membership.team_id is None:
            continue
        counts[membership.team_id] = counts.get(membership.team_id, 0) + 1
        if membership.user_id == context.user_id:
            joined.add(membership.team_id)
    roles = _team_roles(context, [p.team_id for p in visible], memberships)
    return TeamListRead(
        teams=[
            TeamRead.from_row(
                p,
                roles.get(p.team_id),
                member_count=counts.get(p.team_id, 0),
                is_member=p.team_id in joined,
            )
            for p in visible
        ]
    )


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
        description=payload.description,
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
    return TeamRead.from_row(team, "admin", member_count=1, is_member=True)


@router.get("/{workspace_id}/teams/{team_id}", response_model=TeamRead)
def read_team(
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TeamRead:
    """One team the caller may read, with its member count and retired prefixes."""
    return _read(repositories, context, _load(repositories, context))


@router.patch("/{workspace_id}/teams/{team_id}", response_model=TeamRead)
def update_team(
    payload: TeamUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TeamRead:
    """Change a team's name, key prefix, description or estimate scale.

    A new key prefix is applied first, in its own transaction, so a 409 on a
    taken prefix leaves every other field of the patch unapplied too.
    """
    attributes = payload.model_dump(exclude_unset=True, exclude_none=True)
    team_id = str(context.team_id)
    new_prefix = attributes.pop("key_prefix", None)
    if new_prefix is not None:
        try:
            moved = repositories.teams.change_key_prefix(context.workspace_id, team_id, new_prefix)
        except ConditionFailed as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=PREFIX_TAKEN) from exc
        if moved is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
        issue_keys.forget(context.workspace_id, team_id)
    if not attributes:
        return _read(repositories, context, _load(repositories, context))

    updated = repositories.teams.update(context.workspace_id, team_id, **attributes)
    if updated is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return _read(repositories, context, updated)


@router.delete("/{workspace_id}/teams/{team_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_team(
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_DELETE))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Delete a team: tombstone it, then purge the rows this domain owns.

    The tombstone hides the team from every read and frees its key prefix before
    anything else goes, so a crash part way leaves a hidden team a retry resumes,
    never a visible half-deleted one. Memberships, statuses, labels, transitions,
    the issue counter and retired prefix aliases are purged a page at a time.
    The rows other domains own (issues, comments, cycles, views, GitHub links)
    are handed to the team purge chain, whose last stage removes the tombstoned
    row. Without the chain's queues the tombstone simply stays. A repeat call on
    a team that is gone answers 204 again, and one on a team still deleting
    starts the chain again, which is how a purge parked in a dead-letter queue
    is resumed.
    """
    workspace_id = context.workspace_id
    team_id = str(context.team_id)
    if not repositories.teams.mark_deleting(workspace_id, team_id):
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    repositories.memberships.delete_team_memberships(workspace_id, team_id)
    repositories.team_config.delete_for_team(workspace_id, team_id)
    repositories.counters.delete_for_team(workspace_id, team_id)
    repositories.teams.delete_aliases(workspace_id, team_id)
    team_purge.start(workspace_id, team_id)
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


def _read(repositories: Repositories, context: AuthzContext, team: Team) -> TeamRead:
    """One team as the single team routes answer it, counts and aliases included."""
    members = repositories.memberships.list_team_members(context.workspace_id, team.team_id)
    return TeamRead.from_row(
        team,
        context.team_role,
        member_count=len(members),
        is_member=any(member.user_id == context.user_id for member in members),
        retired_key_prefixes=repositories.teams.list_aliases(context.workspace_id, team.team_id),
    )


def _team_roles(context: AuthzContext, team_ids: list[str], memberships: list[Membership]) -> dict[str, str]:
    """The caller's role on each listed team, explicit membership winning.

    A workspace owner or admin implies team admin, and a member implies team
    member, which is the mapping the contract states for the `role` field.
    """
    implied = IMPLIED_TEAM_ROLE.get(context.role)
    roles: dict[str, str] = {}
    if implied is not None:
        roles = {team_id: implied for team_id in team_ids}

    for membership in memberships:
        if membership.user_id == context.user_id and membership.team_id in team_ids:
            roles[membership.team_id] = membership.role
    return roles
