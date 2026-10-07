"""Team routes: create, read, list, update and delete a team, and set its icon.

Reading and listing go through the authorization dependency, which is what makes
a guest see only the teams they hold a membership in, and a private team seen
only by its members. The list route filters with `AuthzContext.can_find_team`
rather than a query of its own, so the same decision that guards a single team
guards the collection. A workspace owner or admin also finds the private teams
they are outside, flagged `private` with `is_member` false, so they can
administer them without reading their issues.

The list answers in the caller's own sidebar order, saved on their workspace
membership, so the order follows the person to every device they sign in on.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status

from app.common import team_writes
from app.common.api.dependencies.authz import (
    IMPLIED_TEAM_ROLE,
    AuthzContext,
    Capability,
    require,
)
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.teams import (
    ArchiveSettingsRead,
    ArchiveSettingsUpdate,
    CycleSettingsRead,
    CycleSettingsUpdate,
    TeamCreate,
    TeamListRead,
    TeamOrderUpdate,
    TeamRead,
    TeamUpdate,
)
from app.common.db.dynamo.memberships import Membership
from app.common.db.dynamo.teams import Team
from app.common.icons import (
    IconCommit,
    IconUploadCreate,
    IconUploadRead,
    delete_icon_objects,
    presign_icon,
    team_owner,
    verify_upload,
)
from app.common.team_writes import NOT_FOUND

router = APIRouter()

NO_TEAM_ORDER = "Only a workspace member can keep a team order"
"""The detail a caller with no membership row of their own is refused with."""


@router.get("/{workspace_id}/teams", response_model=TeamListRead)
def list_teams(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TeamListRead:
    """Every team in the workspace the caller may see, in the caller's saved order.

    A guest sees only the teams they are a member of, which is the same rule
    the single team route applies, read off the context rather than repeated.
    Teams the saved order does not name follow it, oldest first.
    """
    membership = repositories.memberships.get(context.workspace_id, context.user_id)
    return _team_list(repositories, context, membership.team_order if membership is not None else [])


@router.put("/{workspace_id}/teams/order", response_model=TeamListRead)
def set_team_order(
    payload: TeamOrderUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TeamListRead:
    """Save the caller's sidebar team order and answer the list in it.

    Only ids of teams the caller can see now are kept, once each, so a stale
    client naming a deleted team or a guest naming a hidden one stores nothing
    about it. A caller with no membership row of their own, such as a
    workspace key, has no order to keep and is refused.
    """
    visible = {team.team_id for team in _visible_teams(repositories, context)}
    order = [team_id for team_id in dict.fromkeys(payload.team_ids) if team_id in visible]
    saved = repositories.memberships.set_team_order(context.workspace_id, context.user_id, order)
    if saved is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=NO_TEAM_ORDER)
    return _team_list(repositories, context, saved.team_order)


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
    team = team_writes.create_team(repositories, context.workspace_id, context.user_id, payload)
    return TeamRead.from_row(team, "admin", member_count=1, is_member=True, private=payload.private)


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
    team = team_writes.update_team(repositories, context.workspace_id, str(context.team_id), payload)
    return _read(repositories, context, team)


@router.post(
    "/{workspace_id}/teams/{team_id}/icon/uploads",
    response_model=IconUploadRead,
    status_code=status.HTTP_201_CREATED,
)
def create_team_icon_upload(
    payload: IconUploadCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IconUploadRead:
    """Sign a PUT for a new team icon, which the commit call then makes current."""
    team = _load(repositories, context)
    return presign_icon(team_owner(context.workspace_id, team.team_id), payload)


@router.put("/{workspace_id}/teams/{team_id}/icon", response_model=TeamRead)
def set_team_icon(
    payload: IconCommit,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TeamRead:
    """Make an uploaded image the team icon and delete the one it replaces."""
    team_id = str(context.team_id)
    owner = team_owner(context.workspace_id, team_id)
    key = verify_upload(owner, payload.upload_id)
    team = repositories.teams.set_icon(context.workspace_id, team_id, key)
    if team is None:
        delete_icon_objects(owner.prefix)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    delete_icon_objects(owner.prefix, keep=key)
    return _read(repositories, context, team)


@router.delete("/{workspace_id}/teams/{team_id}/icon", response_model=TeamRead)
def clear_team_icon(
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TeamRead:
    """Remove the team icon, falling back to its initials, and delete the image."""
    team_id = str(context.team_id)
    team = repositories.teams.set_icon(context.workspace_id, team_id, None)
    if team is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    delete_icon_objects(team_owner(context.workspace_id, team_id).prefix)
    return _read(repositories, context, team)


@router.get("/{workspace_id}/teams/{team_id}/cycle-settings", response_model=CycleSettingsRead)
def read_cycle_settings(
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> CycleSettingsRead:
    """A team's automatic cycle settings, the defaults when none were saved."""
    team = _load(repositories, context)
    return CycleSettingsRead.from_row(team_writes.cycle_settings(repositories, context.workspace_id, team.team_id))


@router.patch("/{workspace_id}/teams/{team_id}/cycle-settings", response_model=CycleSettingsRead)
def update_cycle_settings(
    payload: CycleSettingsUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> CycleSettingsRead:
    """Change a team's automatic cycle settings.

    When cycles are on after the change, the team's missing current and upcoming
    cycles are created before the response, so the cycles page shows them at
    once rather than after the next hourly run. Turning cycles off keeps every
    cycle already created.
    """
    team = _load(repositories, context)
    saved = team_writes.update_cycle_settings(repositories, context.workspace_id, team.team_id, payload)
    return CycleSettingsRead.from_row(saved)


@router.get("/{workspace_id}/teams/{team_id}/archive-settings", response_model=ArchiveSettingsRead)
def read_archive_settings(
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ArchiveSettingsRead:
    """A team's auto-archive period, the six month default when none was saved."""
    team = _load(repositories, context)
    return ArchiveSettingsRead.from_row(team_writes.archive_settings(repositories, context.workspace_id, team.team_id))


@router.patch("/{workspace_id}/teams/{team_id}/archive-settings", response_model=ArchiveSettingsRead)
def update_archive_settings(
    payload: ArchiveSettingsUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ArchiveSettingsRead:
    """Change after how many months a team's completed and cancelled issues are archived.

    The hourly sweep reads the new period on its next run, so a shorter period
    archives the newly due issues within the hour rather than at once.
    """
    team = _load(repositories, context)
    saved = team_writes.update_archive_settings(repositories, context.workspace_id, team.team_id, payload)
    return ArchiveSettingsRead.from_row(saved)


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
    team_writes.delete_team(repositories, context.workspace_id, str(context.team_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _load(repositories: Repositories, context: AuthzContext) -> Team:
    """The team named in the path, or a 404.

    Authorization has already run, so a missing row here means the team was
    deleted between the membership read and this one.
    """
    return team_writes.load_team(repositories, context.workspace_id, str(context.team_id))


def _read(repositories: Repositories, context: AuthzContext, team: Team) -> TeamRead:
    """One team as the single team routes answer it, counts and aliases included."""
    members = repositories.memberships.list_team_members(context.workspace_id, team.team_id)
    return TeamRead.from_row(
        team,
        context.team_role,
        member_count=len(members),
        is_member=any(member.user_id == context.user_id for member in members),
        retired_key_prefixes=repositories.teams.list_aliases(context.workspace_id, team.team_id),
        private=repositories.memberships.is_private_team(context.workspace_id, team.team_id),
    )


def _visible_teams(repositories: Repositories, context: AuthzContext) -> list[Team]:
    """Every live team of the workspace the caller may find, oldest first."""
    teams = repositories.teams.list_for_workspace(context.workspace_id)
    return [team for team in teams if context.can_find_team(team.team_id)]


def _team_list(repositories: Repositories, context: AuthzContext, order: list[str]) -> TeamListRead:
    """The visible teams with counts and roles, sorted by a saved order.

    The sort is stable, so the teams the order does not name keep their oldest
    first order after the ones it does, and a name for a team that is gone is
    simply never matched.
    """
    rank = {team_id: index for index, team_id in enumerate(order)}
    visible = sorted(_visible_teams(repositories, context), key=lambda team: rank.get(team.team_id, len(rank)))
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
                private=context.is_private_team(p.team_id),
            )
            for p in visible
        ]
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
