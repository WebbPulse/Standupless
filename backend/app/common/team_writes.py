"""Team create, update and delete, a team's parent, and its cycle, auto-close, archive and SLA settings.

Shared by the team routes and the MCP tools, because the integrations image may
not import another domain's code and a team an agent creates, edits or deletes
must be the same rows a person's is. The caller has already been held to the
route's capability, `TEAM_CREATE`, `TEAM_ADMIN` or `TEAM_DELETE`, before any of
these run.
"""

from __future__ import annotations

from typing import Callable

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed, TransactionCanceled

from app.common import cycle_schedule, issue_keys, plan_usage, team_join, team_purge, team_workflow
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
    TEAM_SCOPE,
    ArchiveSettings,
    AutoCloseSettings,
    CycleSettings,
    SlaSettings,
    Status,
    cycle_settings_key,
    default_archive_settings,
    default_auto_close_settings,
    default_cycle_settings,
    default_sla_settings,
)
from app.common.db.dynamo.teams import Team, new_team_id
from app.common.plan_features import Feature, enforce_feature
from app.common.plan_limits import LimitedResource
from app.common.planning_rules import unprocessable
from app.common.sub_teams import check_parent, sub_team_ids

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

PREFIX_TAKEN = {"error_code": "CONFLICT", "message": "That team key prefix is in use"}

ESTIMATE_FIELDS: tuple[str, ...] = (
    "estimate_scale",
    "estimate_extended",
    "estimate_allow_zero",
    "estimate_count_unestimated",
)
"""The team fields a sub-team takes from its parent, as it takes the parent's cycle settings."""

INHERITED_SETTINGS = {
    "error_code": "CONFLICT",
    "message": "This sub-team takes its {what} from its parent team. Change them in the parent team's settings.",
}

HAS_SUB_TEAMS = {
    "error_code": "CONFLICT",
    "message": "This team has sub-teams. Move them to another team or make them top-level teams first.",
}


def load_team(repositories: Repositories, workspace_id: str, team_id: str) -> Team:
    """One team row, or a 404 when it was deleted after authorization ran."""
    team = repositories.teams.get(workspace_id, team_id)
    if team is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return team


def starting_statuses(
    repositories: Repositories, workspace_id: str, team_id: str, parent_team_id: str | None = None
) -> list[Status]:
    """The status rows a new team's create writes, so the team starts with every category.

    A team inherits the workspace statuses live, so only the categories the
    workspace set leaves uncovered get team copies of the defaults. The first
    team of a workspace with no workspace statuses seeds the defaults as
    workspace statuses instead, so every later team inherits them. A workspace
    that already has teams but no workspace statuses keeps giving each new team
    its own copies, as before workspace statuses existed. A sub-team inherits its
    parent's whole workflow, so it gets copies only of what the parent's visible
    set leaves uncovered.
    """
    config = repositories.team_config
    if parent_team_id is not None:
        held = {row.category for row in config.list_statuses(workspace_id, parent_team_id, include_hidden=False)}
        return config.default_statuses(
            workspace_id, team_id, categories=[category for category in STATUS_CATEGORIES if category not in held]
        )
    covered = {row.category for row in config.list_workspace_statuses(workspace_id)}
    if not covered and not repositories.teams.list_team_ids(workspace_id):
        return config.default_workspace_statuses(workspace_id)
    missing = [category for category in STATUS_CATEGORIES if category not in covered]
    return config.default_statuses(workspace_id, team_id, categories=missing)


def create_team(
    repositories: Repositories,
    workspace_id: str,
    user_id: str,
    payload: TeamCreate,
    *,
    can_see: Callable[[str], bool] | None = None,
) -> Team:
    """Create a team, make the creator its admin and seed the statuses it lacks.

    All three land as one `TransactWriteItems`, because a team written without its
    statuses is unusable and cannot be recreated under the same prefix. A taken
    prefix is a 409 and leaves nothing behind. A private team's marker rides in the
    same transaction, so it is never visible to the workspace, even for a moment.
    The team takes its plan slot in that transaction too, so racing creates at the
    last slot land one team and refuse the rest. A sub-team's parent pointer rides
    in it as well; `can_see` holds the parent to the teams the caller may read.
    A sub-team then takes its parent's estimate and cycle settings.
    """
    if payload.private:
        enforce_feature(repositories, workspace_id, Feature.PRIVATE_TEAMS)
    if payload.parent_team_id is not None:
        check_parent(repositories, workspace_id, None, payload.parent_team_id, can_see=can_see)
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
        parent_team_id=payload.parent_team_id,
    )
    membership = Membership(
        workspace_id=workspace_id,
        member_key=team_member_key(team.team_id, user_id),
        user_id=user_id,
        role="admin",
        team_id=team.team_id,
    )
    statuses = starting_statuses(repositories, workspace_id, team.team_id, payload.parent_team_id)
    try:
        actions = [
            repositories.teams.create_action(team),
            repositories.memberships.put_action(membership),
            *(repositories.team_config.create_status_action(row) for row in statuses),
        ]
        if payload.parent_team_id is not None:
            actions.append(repositories.team_config.parent_action(workspace_id, team.team_id, payload.parent_team_id))
        if payload.private:
            actions.append(repositories.memberships.private_team_action(workspace_id, team.team_id))
        plan_usage.commit(repositories, workspace_id, actions, [plan_usage.Delta(LimitedResource.TEAMS, 1)])
    except ConditionFailed as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=PREFIX_TAKEN) from exc
    except TransactionCanceled as exc:
        if not exc.conditional_check_failed:
            raise
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=PREFIX_TAKEN) from exc
    if payload.parent_team_id is not None:
        inherit_settings(repositories, workspace_id, team.team_id, payload.parent_team_id)
        return load_team(repositories, workspace_id, team.team_id)
    return team


def update_team(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    payload: TeamUpdate,
    *,
    actor_id: str = "",
    source: str | None = None,
    can_see: Callable[[str], bool] | None = None,
) -> Team:
    """Change a team's name, key prefix, description, estimate scale, label sync, privacy or parent.

    A new key prefix is applied first, in its own transaction, so a 409 on a taken
    prefix leaves every other field of the patch unapplied too. Making a team
    private needs a plan that includes it and is checked before anything is
    written; opening a private team again is always allowed, so a downgrade never
    traps a team. A scale change pins the extended toggle as it reads now, so a row
    stored before the toggle existed keeps its value rather than reading it afresh
    from the new scale. A new parent is checked before the prefix moves and
    applied through `set_parent` after it. A sub-team's estimate settings are its
    parent's, so a patch changing them is a 409, and a parent's change reaches
    its sub-teams.
    """
    attributes = payload.model_dump(exclude_unset=True, exclude_none=True)
    attributes.pop("parent_team_id", None)
    reparent = "parent_team_id" in payload.model_fields_set
    estimates = {name: attributes[name] for name in ESTIMATE_FIELDS if name in attributes}
    if estimates:
        team = load_team(repositories, workspace_id, team_id)
        parent_id = payload.parent_team_id if reparent else team.parent_team_id
        if parent_id is not None and any(getattr(team, name) != value for name, value in estimates.items()):
            raise _inherited("estimate settings")
        if parent_id is not None:
            for name in estimates:
                attributes.pop(name)
            estimates = {}
    if reparent and payload.parent_team_id is not None:
        team = load_team(repositories, workspace_id, team_id)
        if payload.parent_team_id != team.parent_team_id:
            check_parent(repositories, workspace_id, team, payload.parent_team_id, can_see=can_see)
            team_join.plan_label_merges(repositories, workspace_id, team_id, payload.parent_team_id)
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
    if reparent:
        set_parent(
            repositories,
            workspace_id,
            team_id,
            payload.parent_team_id,
            actor_id=actor_id,
            source=source,
            can_see=can_see,
        )
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
    if estimates:
        for sub_team_id in sub_team_ids(repositories, workspace_id, team_id):
            _inherit_estimates(repositories, workspace_id, sub_team_id, updated)
    return updated


def _inherited(what: str) -> HTTPException:
    """The 409 for a sub-team changing a setting it takes from its parent."""
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={**INHERITED_SETTINGS, "message": INHERITED_SETTINGS["message"].format(what=what)},
    )


def _inherit_estimates(repositories: Repositories, workspace_id: str, team_id: str, parent: Team) -> None:
    """Give one sub-team its parent's estimate settings."""
    repositories.teams.update(workspace_id, team_id, **{name: getattr(parent, name) for name in ESTIMATE_FIELDS})


def _inherit_cycles(repositories: Repositories, workspace_id: str, team_id: str, parent_team_id: str) -> None:
    """Give one sub-team its parent's cycle settings, stocking its cycles when they are on."""
    source = cycle_settings(repositories, workspace_id, parent_team_id)
    saved = repositories.team_config.put_cycle_settings(
        source.model_copy(update={"team_id": team_id, "config_key": cycle_settings_key(team_id)})
    )
    if saved.enabled:
        cycle_schedule.ensure_cycles(repositories.planning, saved)


def inherit_settings(repositories: Repositories, workspace_id: str, team_id: str, parent_team_id: str) -> None:
    """Give a team that just joined a parent the parent's estimate and cycle settings."""
    _inherit_estimates(repositories, workspace_id, team_id, load_team(repositories, workspace_id, parent_team_id))
    _inherit_cycles(repositories, workspace_id, team_id, parent_team_id)


def set_parent(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    parent_team_id: str | None,
    *,
    actor_id: str = "",
    source: str | None = None,
    can_see: Callable[[str], bool] | None = None,
) -> Team:
    """Put a team under `parent_team_id`, or make it a top-level team again with `None`.

    The team row and the `team_config` pointer change in one transaction. A team
    leaving a parent loses that parent's statuses and labels: it first gets its
    own copies of any status category it would no longer cover, then its issues in
    the parent's statuses move to its first visible status of the same category,
    recorded as status changes, and the parent's labels come off its issues as a
    deleted label does. Its overrides of the parent's rows go too. A team joining
    a parent folds its duplicates of the parent's statuses and labels into them,
    as `team_join` describes, and a label clash it cannot fold refuses the join
    before anything is written.
    """
    team = load_team(repositories, workspace_id, team_id)
    if parent_team_id == team.parent_team_id:
        return team
    merges: list[team_join.LabelMerge] = []
    if parent_team_id is not None:
        check_parent(repositories, workspace_id, team, parent_team_id, can_see=can_see)
        merges = team_join.plan_label_merges(repositories, workspace_id, team_id, parent_team_id)
    previous = team.parent_team_id
    config = repositories.team_config
    leaving_statuses = config.list_statuses(workspace_id, previous) if previous else []
    leaving_labels = config.list_labels(workspace_id, previous) if previous else []
    try:
        repositories.teams.transact_write(
            [
                repositories.teams.parent_action(workspace_id, team_id, parent_team_id),
                config.parent_action(workspace_id, team_id, parent_team_id),
            ]
        )
    except TransactionCanceled as exc:
        if not exc.conditional_check_failed:
            raise
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND) from exc
    if previous:
        _leave_parent(
            repositories,
            workspace_id,
            team_id,
            [row for row in leaving_statuses if row.scope == TEAM_SCOPE],
            [row.label_id for row in leaving_labels if row.scope == TEAM_SCOPE],
            actor_id=actor_id,
            source=source,
        )
    if parent_team_id is not None:
        inherit_settings(repositories, workspace_id, team_id, parent_team_id)
        team_join.merge_labels(repositories, workspace_id, team_id, merges)
        team_join.merge_statuses(repositories, workspace_id, team_id, parent_team_id, actor_id=actor_id, source=source)
    return load_team(repositories, workspace_id, team_id)


def _leave_parent(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    statuses: list[Status],
    label_ids: list[str],
    *,
    actor_id: str,
    source: str | None,
) -> None:
    """Carry a team's issues off the statuses and labels of the parent it just left."""
    config = repositories.team_config
    visible = config.list_statuses(workspace_id, team_id, include_hidden=False)
    covered = {row.category for row in visible}
    missing = [category for category in STATUS_CATEGORIES if category not in covered]
    for row in config.default_statuses(workspace_id, team_id, categories=missing):
        config.create_status(row)
    if missing:
        visible = config.list_statuses(workspace_id, team_id, include_hidden=False)
    first = {}
    for row in sorted(visible, key=lambda row: (row.position, row.status_id)):
        first.setdefault(row.category, row.status_id)
    for row in statuses:
        issues = repositories.issues.iter_for_status(workspace_id, team_id, row.status_id, include_archived=True)
        if issues and row.category in first:
            team_workflow.move_issues(repositories, issues, first[row.category], actor_id, source)
        config.delete_override(workspace_id, team_id, "status", row.status_id)
    for label_id in label_ids:
        team_workflow.strip_label(repositories, workspace_id, team_id, label_id)
        config.delete_override(workspace_id, team_id, "label", label_id)


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
    keeps every cycle already created. A sub-team takes its parent's settings, so
    changing its own is a 409, and a parent's change reaches its sub-teams.
    """
    if load_team(repositories, workspace_id, team_id).parent_team_id is not None:
        raise _inherited("cycle settings")
    current = cycle_settings(repositories, workspace_id, team_id)
    changes = payload.model_dump(exclude_unset=True, exclude_none=True)
    saved = repositories.team_config.put_cycle_settings(current.model_copy(update=changes))
    if saved.enabled:
        cycle_schedule.ensure_cycles(repositories.planning, saved)
    for sub_team_id in sub_team_ids(repositories, workspace_id, team_id):
        _inherit_cycles(repositories, workspace_id, sub_team_id, team_id)
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
    this call tombstoned the team, `False` when it was already gone. The tombstone
    frees the team's plan slot in the same transaction, once, so a retry resuming an
    earlier delete frees nothing more. A team with sub-teams is a 409, so no
    sub-team is ever left pointing at a deleted parent.
    """
    if sub_team_ids(repositories, workspace_id, team_id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=HAS_SUB_TEAMS)
    try:
        plan_usage.commit(
            repositories,
            workspace_id,
            [repositories.teams.tombstone_action(workspace_id, team_id)],
            [plan_usage.Delta(LimitedResource.TEAMS, -1)],
        )
    except TransactionCanceled:
        if not repositories.teams.mark_deleting(workspace_id, team_id):
            return False
    repositories.memberships.delete_team_memberships(workspace_id, team_id)
    repositories.team_config.delete_for_team(workspace_id, team_id)
    repositories.counters.delete_for_team(workspace_id, team_id)
    repositories.teams.delete_aliases(workspace_id, team_id)
    team_purge.start(workspace_id, team_id)
    return True
