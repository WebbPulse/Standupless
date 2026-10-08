"""Moving an issue to another team, and finding an issue by a key it used to hold.

Shared by the issue routes and the MCP tools, because the integrations image may
not import another domain's code and a move made by an agent must leave exactly
the rows a person's move leaves.

The issue keeps its id, so its comments, links, subscribers, attachments and
history, all partitioned by that id, come along untouched. What changes is the
team and so the key: the target team allocates the next number, and the old
number is recorded in the source team's counter partition as now naming this
issue, which is what keeps the old key resolving. Values the target team cannot
hold are dropped the way Linear drops them: the status maps to the same one or to
the target's first of the same category, labels the target cannot see go, the
cycle is cleared, and the project stays, with the target team added to it when
it was not on it already.

Sub-issues are one level deep and share their parent's team here, so a parent
takes its sub-issues with it, each getting its own new key, and a sub-issue moved
on its own leaves its parent behind and becomes a top-level issue.
"""

from __future__ import annotations

from fastapi import HTTPException
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.activity import Activity, build_activity
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue, IssueWriteConflict, issue_key
from app.common.db.dynamo.team_config import Status
from app.common.db.dynamo.teams import Team
from app.common.issue_rules import (
    changed_fields,
    check_assignee,
    check_estimate,
    default_status,
    issue_changed,
    not_found,
    require_team_member,
    subscribe_touched,
)
from app.common.issue_writes import PATCHABLE_FIELDS, jsonable
from app.common.relation_effects import child_activity
from app.common.sla import apply_sla

MOVED_FIELD = "team_id"
"""The activity field a move is recorded under, beside the fields it changed."""


def find_issue_by_number(repositories: Repositories, workspace_id: str, team_id: str, number: int) -> Issue | None:
    """The issue one team's number names, following a move, or `None`.

    A number the team still holds answers directly. A number whose issue moved
    away answers the issue wherever it now lives, so a key written before the move
    keeps working. The caller decides visibility against the answer's own team.
    """
    issue = repositories.issues.get_by_number(workspace_id, team_id, number)
    if issue is not None:
        return issue
    moved = repositories.counters.moved_issue_id(workspace_id, team_id, number)
    if moved is None:
        return None
    return repositories.issues.get(workspace_id, moved)


def target_status(
    repositories: Repositories, workspace_id: str, source_team_id: str, team_id: str, status_id: str
) -> Status:
    """The status a moved issue lands in on its new team.

    The same status when the target team shows it, since statuses are workspace
    wide and a team inherits them. Otherwise the target's first status of the same
    category, so an issue in progress stays in progress, and failing that the
    target's default.
    """
    same = repositories.team_config.get_status(workspace_id, team_id, status_id)
    if same is not None and not same.hidden:
        return same
    source = same or repositories.team_config.get_status(workspace_id, source_team_id, status_id)
    category = source.category if source is not None else None
    rows = repositories.team_config.list_statuses(workspace_id, team_id, include_hidden=False)
    matching = sorted((row for row in rows if row.category == category), key=lambda row: (row.position, row.name))
    if matching:
        return matching[0]
    return default_status(repositories, workspace_id, team_id)


def _kept_assignee(repositories: Repositories, workspace_id: str, team_id: str, assignee_id: str | None) -> str | None:
    """The assignee when they can see the target team, otherwise nobody."""
    try:
        return check_assignee(repositories, workspace_id, team_id, assignee_id)
    except HTTPException:
        return None


def _kept_estimate(estimate: str | None, team: Team) -> str | None:
    """The estimate when the target team's scale holds it, otherwise none."""
    try:
        return check_estimate(estimate, team)
    except HTTPException:
        return None


def _kept_project(repositories: Repositories, workspace_id: str, issue: Issue) -> tuple[str | None, str | None]:
    """The project and milestone the moved issue keeps: both, while the project still exists."""
    if not issue.project_id:
        return None, None
    if repositories.planning.get_project(workspace_id, issue.project_id) is None:
        return None, None
    return issue.project_id, issue.project_milestone_id


def _join_projects(repositories: Repositories, workspace_id: str, team_id: str, planned: list[Issue]) -> None:
    """Add the target team to every project a moved issue keeps that it is not on yet.

    The way Linear treats a move: the issue stays in its project and the project
    gains the team, so it never sits in a project its team cannot plan in. The
    caller already writes in the target team, which is what adding a team to a
    project asks of them. A project deleted meanwhile is skipped.
    """
    for project_id in sorted({issue.project_id for issue in planned if issue.project_id}):
        project = repositories.planning.get_project(workspace_id, project_id)
        if project is None or team_id in project.team_ids:
            continue
        try:
            repositories.planning.replace_project(project.model_copy(update={"team_ids": [*project.team_ids, team_id]}))
        except ConditionFailed:
            continue


def plan_move(
    repositories: Repositories,
    context: AuthzContext,
    issue: Issue,
    target: Team,
    *,
    parent_id: str | None,
) -> Issue:
    """The issue as it would stand in the target team, before a number is allocated.

    Every value is held to the target team's rules here rather than through the
    patch checks, because a move drops what does not fit instead of refusing it.
    """
    workspace_id = context.workspace_id
    team_id = target.team_id
    status_row = target_status(repositories, workspace_id, issue.team_id, team_id, issue.status_id)
    labels = [
        label_id
        for label_id in issue.label_ids
        if (row := repositories.team_config.get_label(workspace_id, team_id, label_id)) is not None and not row.hidden
    ]
    project_id, milestone_id = _kept_project(repositories, workspace_id, issue)
    return issue.model_copy(
        deep=True,
        update={
            "team_id": team_id,
            "status_id": status_row.status_id,
            "label_ids": labels,
            "cycle_id": None,
            "cycle_carried_from": None,
            "project_id": project_id,
            "project_milestone_id": milestone_id,
            "estimate": _kept_estimate(issue.estimate, target),
            "assignee_id": _kept_assignee(repositories, workspace_id, team_id, issue.assignee_id),
            "parent_id": parent_id,
        },
    )


def _activity(context: AuthzContext, before: Issue, after: Issue) -> list[Activity]:
    """The history a move writes on the moved issue: the move itself, then each field it changed."""
    rows = [
        build_activity(
            context.workspace_id,
            after.team_id,
            after.issue_id,
            context.user_id,
            "field_changed",
            field=MOVED_FIELD,
            from_value={"id": before.team_id, "key": before.key},
            to_value={"id": after.team_id, "key": after.key},
            source=context.source,
        )
    ]
    rows.extend(
        build_activity(
            context.workspace_id,
            after.team_id,
            after.issue_id,
            context.user_id,
            "field_changed",
            field=field,
            from_value=jsonable(old),
            to_value=jsonable(new),
            source=context.source,
        )
        for field, old, new in changed_fields(before, after, PATCHABLE_FIELDS)
    )
    return rows


def _store(repositories: Repositories, context: AuthzContext, before: Issue, planned: Issue, target: Team) -> Issue:
    """Allocate the target's next number, write the moved issue and everything that records it.

    The number is allocated only once every value has been decided, because a
    number is consumed whether or not the write lands. The old number is recorded
    after the write, so it never points at an issue still holding it.
    """
    workspace_id = context.workspace_id
    number = repositories.counters.allocate_issue_number(workspace_id, target.team_id)
    moved = planned.model_copy(
        update={
            "number": number,
            "key": issue_key(target.key_prefix, number),
            "updated_at": utc_now(),
            "updated_by": context.user_id,
            "updated_source": context.source,
        }
    )
    apply_sla(repositories, before, moved)
    try:
        stored = repositories.issues.replace(moved)
    except IssueWriteConflict as exc:
        raise issue_changed() from exc
    except ConditionFailed as exc:
        raise not_found() from exc
    repositories.counters.record_moved_issue(workspace_id, before.team_id, before.number, stored.issue_id)
    repositories.activity.record_many(_activity(context, before, stored))
    repositories.activity.record_tombstone(workspace_id, before.team_id, stored.issue_id, context.user_id)
    subscribe_touched(repositories, stored, before)
    return stored


def move_issue(repositories: Repositories, context: AuthzContext, issue: Issue, team_id: str) -> Issue:
    """Move one visible issue, and its sub-issues, to another team, answering it as it now stands.

    The caller must be able to write in both teams. Moving to the team the issue
    is already in answers it untouched. Every issue is planned before any is
    written, so a target that cannot take the issue at all, such as one with no
    statuses, fails with nothing changed.
    """
    require_team_member(repositories, context, issue.team_id)
    require_team_member(repositories, context, team_id)
    if team_id == issue.team_id:
        return issue
    target = repositories.teams.get(context.workspace_id, team_id)
    if target is None:
        raise not_found()

    workspace_id = context.workspace_id
    planned = plan_move(repositories, context, issue, target, parent_id=None)
    children = [
        (child, plan_move(repositories, context, child, target, parent_id=issue.issue_id))
        for child in repositories.issues.iter_children(workspace_id, issue.issue_id)
    ]

    _join_projects(repositories, workspace_id, team_id, [planned, *(row for _, row in children)])
    stored = _store(repositories, context, issue, planned, target)
    if issue.parent_id:
        repositories.activity.record_many(
            child_activity(repositories, workspace_id, context.user_id, stored, issue.parent_id, None, context.source)
        )
    for child, planned_child in children:
        _store(repositories, context, child, planned_child, target)
    return stored
