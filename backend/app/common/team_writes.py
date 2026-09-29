"""Team create, update and delete, and a team's cycle and archive settings.

Shared by the team routes and the MCP tools, because the integrations image may
not import another domain's code and a team an agent creates, edits or deletes
must be the same rows a person's is. The caller has already been held to the
route's capability, `TEAM_CREATE`, `TEAM_ADMIN` or `TEAM_DELETE`, before any of
these run.
"""

from __future__ import annotations

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed, TransactionCanceled

from app.common import cycle_schedule, issue_keys, team_purge
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.teams import ArchiveSettingsUpdate, CycleSettingsUpdate, TeamCreate, TeamUpdate
from app.common.db.dynamo.memberships import Membership, team_member_key
from app.common.db.dynamo.team_config import (
    ArchiveSettings,
    CycleSettings,
    default_archive_settings,
    default_cycle_settings,
)
from app.common.db.dynamo.teams import Team, new_team_id
from app.common.plan_limits import LimitedResource, enforce_limit

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

PREFIX_TAKEN = {"error_code": "CONFLICT", "message": "That team key prefix is in use"}


def load_team(repositories: Repositories, workspace_id: str, team_id: str) -> Team:
    """One team row, or a 404 when it was deleted after authorization ran."""
    team = repositories.teams.get(workspace_id, team_id)
    if team is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return team


def create_team(repositories: Repositories, workspace_id: str, user_id: str, payload: TeamCreate) -> Team:
    """Create a team, make the creator its admin and seed the default statuses.

    All three land as one `TransactWriteItems`, because a team written without its
    statuses is unusable and cannot be recreated under the same prefix. A taken
    prefix is a 409 and leaves nothing behind.
    """
    enforce_limit(repositories, workspace_id, LimitedResource.TEAMS)
    team = Team(
        workspace_id=workspace_id,
        team_id=new_team_id(),
        name=payload.name,
        key_prefix=payload.key_prefix,
        description=payload.description,
        estimate_scale=payload.estimate_scale,
    )
    membership = Membership(
        workspace_id=workspace_id,
        member_key=team_member_key(team.team_id, user_id),
        user_id=user_id,
        role="admin",
        team_id=team.team_id,
    )
    statuses = repositories.team_config.default_statuses(workspace_id, team.team_id)
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
    return team


def update_team(repositories: Repositories, workspace_id: str, team_id: str, payload: TeamUpdate) -> Team:
    """Change a team's name, key prefix, description or estimate scale.

    A new key prefix is applied first, in its own transaction, so a 409 on a taken
    prefix leaves every other field of the patch unapplied too.
    """
    attributes = payload.model_dump(exclude_unset=True, exclude_none=True)
    new_prefix = attributes.pop("key_prefix", None)
    if new_prefix is not None:
        try:
            moved = repositories.teams.change_key_prefix(workspace_id, team_id, new_prefix)
        except ConditionFailed as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=PREFIX_TAKEN) from exc
        if moved is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
        issue_keys.forget(workspace_id, team_id)
    if not attributes:
        return load_team(repositories, workspace_id, team_id)

    updated = repositories.teams.update(workspace_id, team_id, **attributes)
    if updated is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return updated


def cycle_settings(repositories: Repositories, workspace_id: str, team_id: str) -> CycleSettings:
    """A team's automatic cycle settings, the defaults when none were saved."""
    stored = repositories.team_config.get_cycle_settings(workspace_id, team_id)
    return stored or default_cycle_settings(workspace_id, team_id)


def update_cycle_settings(
    repositories: Repositories, workspace_id: str, team_id: str, payload: CycleSettingsUpdate
) -> CycleSettings:
    """Change a team's automatic cycle settings.

    When cycles are on after the change, the missing current and upcoming cycles
    are created at once rather than on the next hourly run. Turning cycles off
    keeps every cycle already created.
    """
    current = cycle_settings(repositories, workspace_id, team_id)
    changes = payload.model_dump(exclude_unset=True, exclude_none=True)
    saved = repositories.team_config.put_cycle_settings(current.model_copy(update=changes))
    if saved.enabled:
        cycle_schedule.ensure_cycles(repositories.planning, saved)
    return saved


def archive_settings(repositories: Repositories, workspace_id: str, team_id: str) -> ArchiveSettings:
    """A team's auto-archive period, the six month default when none was saved."""
    stored = repositories.team_config.get_archive_settings(workspace_id, team_id)
    return stored or default_archive_settings(workspace_id, team_id)


def update_archive_settings(
    repositories: Repositories, workspace_id: str, team_id: str, payload: ArchiveSettingsUpdate
) -> ArchiveSettings:
    """Change after how many months a team's completed and cancelled issues are archived."""
    current = archive_settings(repositories, workspace_id, team_id)
    changes = payload.model_dump(exclude_unset=True, exclude_none=True)
    return repositories.team_config.put_archive_settings(current.model_copy(update=changes))


def delete_team(repositories: Repositories, workspace_id: str, team_id: str) -> bool:
    """Tombstone a team, purge the rows the teams domain owns, and start the purge chain.

    The tombstone hides the team from every read and frees its key prefix before
    anything else goes, so a crash part way leaves a hidden team a retry resumes,
    never a visible half-deleted one. The rows other domains own are handed to the
    team purge chain, whose last stage removes the tombstoned row. Answers whether
    this call tombstoned the team, `False` when it was already gone.
    """
    if not repositories.teams.mark_deleting(workspace_id, team_id):
        return False
    repositories.memberships.delete_team_memberships(workspace_id, team_id)
    repositories.team_config.delete_for_team(workspace_id, team_id)
    repositories.counters.delete_for_team(workspace_id, team_id)
    repositories.teams.delete_aliases(workspace_id, team_id)
    team_purge.start(workspace_id, team_id)
    return True
