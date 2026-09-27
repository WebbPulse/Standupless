"""The issue list, create and patch paths, shared by the issue routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and an agent creating or patching an issue must leave exactly the rows a
person's request leaves: the same key allocation, validation, activity and
subscriptions. Every function raises the routes' `HTTPException`s, which the MCP
transport maps to tool errors.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import decode_offset_cursor, encode_offset_cursor, merge_sorted
from app.common.api.schemas.issues import IssueCreate
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import PRIORITY_ORDER, Issue, as_issue, issue_key, new_issue_id
from app.common.issue_filters import IssueFilter
from app.common.issue_keys import current_all
from app.common.issue_rules import (
    changed_fields,
    check_assignee,
    check_cycle,
    check_estimate,
    check_labels,
    check_parent,
    check_project,
    check_project_milestone,
    check_status,
    default_status,
    not_found,
    require_team_member,
    require_team_reader,
    status_categories,
    subscribe_touched,
    unprocessable,
    visible_team_ids,
)
from app.common.mentions import mentioned_user_ids
from app.common.relation_effects import child_activity

PATCHABLE_FIELDS: tuple[str, ...] = (
    "title",
    "body",
    "status_id",
    "priority",
    "assignee_id",
    "label_ids",
    "estimate",
    "start_date",
    "due_date",
    "parent_id",
    "cycle_id",
    "project_id",
    "project_milestone_id",
)
"""Every field a patch may move, and so every field activity is recorded for.

`team_id` is absent because the contract makes it unchangeable, and `progress`
because only the rollup consumer writes it.
"""

FAN_OUT_MULTIPLIER = 4
"""How much more than one page each team is read for before the merge.

A merged page of 50 can come entirely from one team or evenly from twenty, so
each read has to over-fetch; bounded rather than unbounded because the answer only
needs to be right about the first page.
"""


def sort_key(sort: str) -> Any:
    """The key one sort orders a merged fan-out by.

    Written as one function so the merge and the fallback ordering inside a single
    team's page cannot disagree about what a sort means.
    """
    if sort == "created_desc":
        return lambda issue: (issue.created_at, issue.issue_id)
    if sort == "key_asc":
        return lambda issue: (issue.team_id, issue.number)
    if sort == "priority_desc":
        return lambda issue: (-PRIORITY_ORDER.get(issue.priority, 4), issue.updated_at)
    if sort == "due_asc":
        return lambda issue: (issue.due_date is None, issue.due_date or "", issue.issue_id)
    if sort == "manual":
        return lambda issue: (issue.sort_order is None, issue.sort_order or "", issue.issue_id)
    return lambda issue: (issue.updated_at, issue.issue_id)


def descending(sort: str) -> bool:
    """Whether one sort reads newest or highest first.

    `key_asc`, `due_asc` and `manual` climb; the rest descend, which is what their
    names say. A manual order climbs so the smallest key is the top of the list,
    and an issue nobody has placed yet sorts after every placed one.
    """
    return sort not in ("key_asc", "due_asc", "manual")


def list_issues(
    repositories: Repositories,
    context: AuthzContext,
    wanted: IssueFilter,
    *,
    team_id: Optional[str],
    sort: str,
    cursor: Optional[str],
    limit: int,
) -> tuple[list[Issue], Optional[str]]:
    """One page of the issues the caller may see, filtered and sorted, and the next cursor.

    Fans out across the visible teams, or the one named, because there is no index
    spanning a workspace's issues. The cursor is a position in the filtered, sorted
    set and is bound to the filter, so a cursor carried to a different filter
    starts over rather than skipping rows.
    """
    if team_id is not None:
        require_team_reader(repositories, context, team_id)
        teams = [team_id]
    else:
        teams = visible_team_ids(repositories, context)

    if not teams:
        return [], None

    categories: dict[str, str] = {}
    if wanted.needs_categories:
        for candidate in teams:
            categories.update(status_categories(repositories, context.workspace_id, candidate))

    scope = f"issues:{context.workspace_id}:{','.join(teams)}:{sort}:{wanted.fingerprint()}"
    offset = decode_offset_cursor(cursor, scope)
    window = (offset + limit) * FAN_OUT_MULTIPLIER
    rows: list[Issue] = []
    for candidate in teams:
        page = repositories.issues.list_for_team(context.workspace_id, candidate, limit=window)
        rows.extend(current_all(repositories.teams, (as_issue(item) for item in page.items)))

    matched = [issue for issue in rows if wanted.matches(issue, categories)]
    ordered = merge_sorted(matched, sort_key(sort), descending=descending(sort))
    window_rows = ordered[offset : offset + limit]
    next_offset = offset + len(window_rows)
    next_cursor = encode_offset_cursor(next_offset, scope) if next_offset < len(ordered) else None
    return window_rows, next_cursor


def create_issue(repositories: Repositories, context: AuthzContext, payload: IssueCreate) -> Issue:
    """Create an issue, allocating its key from the team's counter.

    The counter is allocated after every validation has passed, because a number is
    consumed whether or not the write lands and the contract accepts gaps but not
    wasted ones.
    """
    require_team_member(repositories, context, payload.team_id)
    team = repositories.teams.get(context.workspace_id, payload.team_id)
    if team is None:
        raise not_found()

    if payload.status_id:
        chosen = check_status(repositories, context.workspace_id, payload.team_id, payload.status_id)
    else:
        chosen = default_status(repositories, context.workspace_id, payload.team_id)

    estimate = check_estimate(payload.estimate, team.estimate_scale)
    label_ids = check_labels(repositories, context.workspace_id, payload.team_id, payload.label_ids)
    assignee_id = check_assignee(repositories, context.workspace_id, payload.team_id, payload.assignee_id)
    issue_id = new_issue_id()
    parent_id = check_parent(repositories, context.workspace_id, payload.team_id, issue_id, payload.parent_id)

    cycle_id = check_cycle(repositories, context.workspace_id, payload.team_id, payload.cycle_id)
    project_id = check_project(repositories, context.workspace_id, payload.team_id, payload.project_id)
    project_milestone_id = check_project_milestone(
        repositories, context.workspace_id, project_id, payload.project_milestone_id
    )

    mentions = mentioned_user_ids(repositories, context.workspace_id, payload.body)
    number = repositories.counters.allocate_issue_number(context.workspace_id, payload.team_id)
    issue = Issue(
        workspace_id=context.workspace_id,
        issue_id=issue_id,
        team_id=payload.team_id,
        key=issue_key(team.key_prefix, number),
        number=number,
        title=payload.title,
        body=payload.body,
        status_id=chosen.status_id,
        priority=payload.priority,
        assignee_id=assignee_id,
        label_ids=label_ids,
        estimate=estimate,
        start_date=payload.start_date,
        due_date=payload.due_date,
        parent_id=parent_id,
        cycle_id=cycle_id,
        project_id=project_id,
        project_milestone_id=project_milestone_id,
        sort_order=payload.sort_order,
        created_by=context.user_id,
        updated_by=context.user_id,
        mentioned_user_ids=mentions,
    )
    try:
        created = repositories.issues.create(issue)
    except ConditionFailed as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error_code": "CONFLICT", "message": "That issue already exists"},
        ) from exc

    repositories.activity.record(
        build_activity(
            context.workspace_id,
            created.team_id,
            created.issue_id,
            context.user_id,
            "created",
        )
    )
    if created.parent_id:
        repositories.activity.record_many(
            [
                build_activity(
                    context.workspace_id,
                    created.team_id,
                    created.issue_id,
                    context.user_id,
                    "field_changed",
                    field="parent_id",
                    from_value=None,
                    to_value=created.parent_id,
                ),
                *child_activity(repositories, context.workspace_id, context.user_id, created, None, created.parent_id),
            ]
        )
    subscribe_touched(repositories, created, None)
    return created


def update_issue(repositories: Repositories, context: AuthzContext, issue: Issue, attributes: dict[str, Any]) -> Issue:
    """Patch one visible issue the caller may write in, recording activity per moved field.

    The single-issue patch both the route and the MCP tools run: the write check,
    then `apply_patch` and `store_patch`. An empty patch answers the issue untouched.
    """
    require_team_member(repositories, context, issue.team_id)
    if not attributes:
        return issue
    return store_patch(repositories, context, issue, apply_patch(repositories, context, issue, attributes))


def apply_patch(repositories: Repositories, context: AuthzContext, issue: Issue, attributes: dict[str, Any]) -> Issue:
    """The issue as a patch would leave it, validated against its own team, unsaved.

    Shared by the single and the bulk patch so both refuse the same values for the
    same reasons, and split from the write so a bulk patch can validate every
    issue before it stores any.
    """
    updated = issue.model_copy(deep=True)
    if "status_id" in attributes and attributes["status_id"] is not None:
        chosen = check_status(repositories, context.workspace_id, issue.team_id, attributes["status_id"])
        updated.status_id = chosen.status_id
    if "title" in attributes and attributes["title"] is not None:
        updated.title = attributes["title"]
    if "body" in attributes:
        updated.body = attributes["body"]
        updated.mentioned_user_ids = mentioned_user_ids(repositories, context.workspace_id, updated.body)
    if "priority" in attributes and attributes["priority"] is not None:
        updated.priority = attributes["priority"]
    if "estimate" in attributes:
        team = repositories.teams.get(context.workspace_id, issue.team_id)
        if team is None:
            raise not_found()
        updated.estimate = check_estimate(attributes["estimate"], team.estimate_scale)
    if "label_ids" in attributes and attributes["label_ids"] is not None:
        updated.label_ids = check_labels(repositories, context.workspace_id, issue.team_id, attributes["label_ids"])
    if "assignee_id" in attributes:
        updated.assignee_id = check_assignee(
            repositories, context.workspace_id, issue.team_id, attributes["assignee_id"]
        )
    if "start_date" in attributes:
        updated.start_date = attributes["start_date"]
    if "due_date" in attributes:
        updated.due_date = attributes["due_date"]
    if updated.start_date and updated.due_date and updated.due_date < updated.start_date:
        raise unprocessable("due_date must not be before start_date")
    if "parent_id" in attributes:
        updated.parent_id = check_parent(
            repositories, context.workspace_id, issue.team_id, issue.issue_id, attributes["parent_id"]
        )
    if "cycle_id" in attributes:
        updated.cycle_id = check_cycle(repositories, context.workspace_id, issue.team_id, attributes["cycle_id"])
    if "project_id" in attributes:
        updated.project_id = check_project(repositories, context.workspace_id, issue.team_id, attributes["project_id"])
    if "project_milestone_id" in attributes:
        updated.project_milestone_id = check_project_milestone(
            repositories, context.workspace_id, updated.project_id, attributes["project_milestone_id"]
        )
    elif updated.project_id != issue.project_id:
        updated.project_milestone_id = None
    if "sort_order" in attributes:
        updated.sort_order = attributes["sort_order"]
    return updated


def store_patch(repositories: Repositories, context: AuthzContext, issue: Issue, updated: Issue) -> Issue:
    """Write a patched issue and its activity rows, or leave it alone if nothing moved.

    A moved manual position is written but records no activity: dragging a row is
    arrangement rather than a change to the issue, and a history full of reorders
    would bury the edits a reader is looking for. Raises the 404 when the issue was
    deleted after it was read.
    """
    changes = changed_fields(issue, updated, PATCHABLE_FIELDS)
    if not changes and issue.sort_order == updated.sort_order:
        return issue

    updated.updated_at = utc_now()
    updated.updated_by = context.user_id
    try:
        stored = repositories.issues.replace(updated)
    except ConditionFailed as exc:
        raise not_found() from exc

    subscribe_touched(repositories, stored, issue)

    if changes:
        repositories.activity.record_many(
            [
                build_activity(
                    context.workspace_id,
                    stored.team_id,
                    stored.issue_id,
                    context.user_id,
                    "field_changed",
                    field=field,
                    from_value=jsonable(before),
                    to_value=jsonable(after),
                )
                for field, before, after in changes
            ]
        )
    if issue.parent_id != stored.parent_id:
        repositories.activity.record_many(
            child_activity(
                repositories, context.workspace_id, context.user_id, stored, issue.parent_id, stored.parent_id
            )
        )
    return stored


def jsonable(value: Any) -> Any:
    """One field value as something DynamoDB and JSON both accept.

    A label list and a date string pass through; anything with a richer type is
    rendered as text, because an activity row records what changed for a reader
    rather than being read back into a model.
    """
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, list):
        return [jsonable(entry) for entry in value]
    return str(value)
