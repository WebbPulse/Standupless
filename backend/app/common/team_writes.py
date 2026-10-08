"""Team create, update and delete, and a team's cycle, auto-close, archive and SLA settings.

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
from app.common.api.schemas.teams import (
    ArchiveSettingsUpdate,
    AutoCloseSettingsUpdate,
    CycleSettingsUpdate,
    SlaSettingsUpdate,
    TeamCreate,
    TeamUpdate,
)
from app.common.db.dynamo.memberships import Membership, team_member_key
from app.common.db.dynamo.team_config import (
    STATUS_CATEGORIES,
    ArchiveSettings,
    AutoCloseSettings,
    CycleSettings,
    SlaSettings,
    Status,
    default_archive_settings,
    default_auto_close_settings,
    default_cycle_settings,
    default_sla_settings,
)
from app.common.db.dynamo.teams import Team, new_team_id
from app.common.plan_features import Feature, enforce_feature
from app.common.plan_limits import LimitedResource, enforce_limit
from app.common.planning_rules import unprocessable

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

PREFIX_TAKEN = {"error_code": "CONFLICT", "message": "That team key prefix is in use"}


def load_team(repositories: Repositories, workspace_id: str, team_id: str) -> Team:
    """One team row, or a 404 when it was deleted after authorization ran."""
    team = repositories.teams.get(workspace_id, team_id)
    if team is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return team


def starting_statuses(repositories: Repositories, workspace_id: str, team_id: str) -> list[Status]:
    """The status rows a new team's create writes, so the team starts with every category.

    A team inherits the workspace statuses live, so only the categories the
    workspace set leaves uncovered get team copies of the defaults. The first
    team of a workspace with no workspace statuses seeds the defaults as
    workspace statuses instead, so every later team inherits them. A workspace
    that already has teams but no workspace statuses keeps giving each new team
    its own copies, as before workspace statuses existed.
    """
    config = repositories.team_config
    covered = {row.category for row in config.list_workspace_statuses(workspace_id)}
    if not covered and not repositories.teams.list_team_ids(workspace_id):
        return config.default_workspace_statuses(workspace_id)
    missing = [category for category in STATUS_CATEGORIES if category not in covered]
    return config.default_statuses(workspace_id, team_id, categories=missing)


def create_team(repositories: Repositories, workspace_id: str, user_id: str, payload: TeamCreate) -> Team:
    """Create a team, make the creator its admin and seed the statuses it lacks.

    All three land as one `TransactWriteItems`, because a team written without its
    statuses is unusable and cannot be recreated under the same prefix. A taken
    prefix is a 409 and leaves nothing behind. A private team's marker rides in the
    same transaction, so it is never visible to the workspace, even for a moment.
    """
    enforce_limit(repositories, workspace_id, LimitedResource.TEAMS)
    if payload.private:
        enforce_feature(repositories, workspace_id, Feature.PRIVATE_TEAMS)
    team = Team(
        workspace_id=workspace_id,
        team_id=new_team_id(),
        name=payload.name,
        key_prefix=payload.key_prefix,
        description=payload.description,
        estimate_scale=payload.estimate_scale,
        estimate_extended=payload.estimate_extended,
        estimate_allow_zero=payload.estimate_allow_zero,
        estimate_count_unestimated=payload.estimate_count_unestimated,
    )
    membership = Membership(
        workspace_id=workspace_id,
        member_key=team_member_key(team.team_id, user_id),
        user_id=user_id,
        role="admin",
        team_id=team.team_id,
    )
    statuses = starting_statuses(repositories, workspace_id, team.team_id)
    try:
        actions = [
            repositories.teams.create_action(team),
            repositories.memberships.put_action(membership),
            *(repositories.team_config.create_status_action(row) for row in statuses),
        ]
        if payload.private:
            actions.append(repositories.memberships.private_team_action(workspace_id, team.team_id))
        repositories.teams.transact_write(actions)
    except ConditionFailed as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=PREFIX_TAKEN) from exc
    except TransactionCanceled as exc:
        if not exc.conditional_check_failed:
            raise
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=PREFIX_TAKEN) from exc
    return team


def update_team(repositories: Repositories, workspace_id: str, team_id: str, payload: TeamUpdate) -> Team:
    """Change a team's name, key prefix, description, estimate scale, label sync or privacy.

    A new key prefix is applied first, in its own transaction, so a 409 on a taken
    prefix leaves every other field of the patch unapplied too. Making a team
    private needs a plan that includes it and is checked before anything is
    written; opening a private team again is always allowed, so a downgrade never
    traps a team. A scale change pins the extended toggle as it reads now, so a row
    stored before the toggle existed keeps its value rather than reading it afresh
    from the new scale.
    """
    attributes = payload.model_dump(exclude_unset=True, exclude_none=True)
    private = attributes.pop("private", None)
    if private:
        enforce_feature(repositories, workspace_id, Feature.PRIVATE_TEAMS)
    new_prefix = attributes.pop("key_prefix", None)
    if new_prefix is not None:
        try:
            moved = repositories.teams.change_key_prefix(workspace_id, team_id, new_prefix)
        except ConditionFailed as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=PREFIX_TAKEN) from exc
        if moved is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
        issue_keys.forget(workspace_id, team_id)
    if private is not None:
        load_team(repositories, workspace_id, team_id)
        repositories.memberships.set_team_private(workspace_id, team_id, private)
    if not attributes:
        return load_team(repositories, workspace_id, team_id)
    if "estimate_scale" in attributes and "estimate_extended" not in attributes:
        attributes["estimate_extended"] = load_team(repositories, workspace_id, team_id).estimate_extended

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


def auto_close_settings(repositories: Repositories, workspace_id: str, team_id: str) -> AutoCloseSettings:
    """A team's auto-close period and status, off when none was saved."""
    stored = repositories.team_config.get_auto_close_settings(workspace_id, team_id)
    return stored or default_auto_close_settings(workspace_id, team_id)


def update_auto_close_settings(
    repositories: Repositories, workspace_id: str, team_id: str, payload: AutoCloseSettingsUpdate
) -> AutoCloseSettings:
    """Change after how many months a team's stale backlog and triage issues close, and where to.

    An explicit null period turns auto-close off and a null status falls back to
    the team's first cancelled status. A named status must be a visible cancelled
    status of the team, so the sweep never closes issues into an open column.
    """
    changes = payload.model_dump(exclude_unset=True)
    status_id = changes.get("status_id")
    if status_id is not None:
        rows = repositories.team_config.list_statuses(workspace_id, team_id, include_hidden=False)
        if not any(row.status_id == status_id and row.category == "cancelled" for row in rows):
            raise unprocessable("status_id must be a cancelled status of this team")
    current = auto_close_settings(repositories, workspace_id, team_id)
    return repositories.team_config.put_auto_close_settings(current.model_copy(update=changes))


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


def sla_settings(repositories: Repositories, workspace_id: str, team_id: str) -> SlaSettings:
    """A team's SLA rules, off with the urgent and high defaults when none were saved."""
    stored = repositories.team_config.get_sla_settings(workspace_id, team_id)
    return stored or default_sla_settings(workspace_id, team_id)


def update_sla_settings(
    repositories: Repositories, workspace_id: str, team_id: str, payload: SlaSettingsUpdate
) -> SlaSettings:
    """Turn a team's SLAs on or off and change the hours each priority gets.

    A priority's hours sent as `null` removes its rule. Issues already carrying a
    deadline keep it; new rules apply as issues are created or move. Turning SLAs
    on or setting a rule's hours needs a plan that includes SLAs; turning them off
    or removing a rule never does, so a downgrade never traps a team.
    """
    current = sla_settings(repositories, workspace_id, team_id)
    changes = payload.model_dump(exclude_unset=True)
    if changes.get("enabled") is None:
        changes.pop("enabled", None)
    if (changes.get("enabled") is True and not current.enabled) or any(
        value is not None for key, value in changes.items() if key.endswith("_hours")
    ):
        enforce_feature(repositories, workspace_id, Feature.ISSUE_SLAS)
    return repositories.team_config.put_sla_settings(current.model_copy(update=changes))


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
