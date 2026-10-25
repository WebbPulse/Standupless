"""Issue routes: list, create, read, look up by key, patch, delete, restore and list children.

Issues are workspace scoped, so the team is a field rather than a path segment
and every route decides visibility against the issue's own team through the
service helpers. The list route fans out across the teams the caller may see,
because there is no index spanning a workspace's issues and filtering after the
read would let an invisible team's rows influence a page boundary.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Path, Query, Request, Response, status
from webbpulse.dynamodb import encode_start_key
from webbpulse.http import CursorPage, conditional_response

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.pagination import resume_key
from app.common.api.schemas.issues import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    DeletedIssueListRead,
    IssueBulkRead,
    IssueBulkUpdate,
    IssueConversionRead,
    IssueCreate,
    IssueDuplicate,
    IssueListRead,
    IssueMove,
    IssueRead,
    IssueSyncListRead,
    IssueUpdate,
    SortField,
    parse_issue_key,
)
from app.common.db.dynamo.issues import TRASH_RETENTION_DAYS, as_issue
from app.common.issue_archive import archive_issue as archive_issue_row
from app.common.issue_archive import unarchive_issue as unarchive_issue_row
from app.common.issue_changes import list_issue_changes, sync_cursor
from app.common.issue_conversion import convert_to_project, duplicate_issue
from app.common.issue_filters import UnknownStatusCategory, build_issue_filter, subscribed_by_caller
from app.common.issue_keys import current
from app.common.issue_move import find_issue_by_number
from app.common.issue_move import move_issue as move_issue_row
from app.common.issue_parents import parents_of
from app.common.issue_rules import (
    load_visible_issue,
    not_found,
    unprocessable,
)
from app.common.issue_trash import delete_issue as trash_issue_row
from app.common.issue_trash import list_trash, purge_now
from app.common.issue_trash import restore_issue as restore_issue_row
from app.common.issue_writes import bulk_update_issues as bulk_update_row
from app.common.issue_writes import create_issue as create_issue_row
from app.common.issue_writes import list_issues as list_issues_page
from app.common.issue_writes import update_issue as update_issue_row

router = APIRouter()

Values = Annotated[Optional[list[str]], Query()]
"""A repeatable query parameter: `k=a&k=b` is any of `a` or `b`, and one `k=a` still works."""


@router.get("/{workspace_id}/issues", response_model=IssueSyncListRead)
def list_issues(
    request: Request,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    team_id: Annotated[Optional[str], Query()] = None,
    include_sub_teams: Annotated[bool, Query()] = False,
    status_id: Values = None,
    status_id_not: Values = None,
    status_category: Values = None,
    status_category_not: Values = None,
    assignee_id: Values = None,
    assignee_id_not: Values = None,
    creator_id: Values = None,
    creator_id_not: Values = None,
    subscriber_id: Values = None,
    subscriber_id_not: Values = None,
    label_id: Values = None,
    label_id_not: Values = None,
    label_id_all: Values = None,
    parent_id: Values = None,
    parent_id_not: Values = None,
    has_sub_issues: Annotated[Optional[bool], Query()] = None,
    priority: Values = None,
    priority_not: Values = None,
    cycle_id: Values = None,
    cycle_id_not: Values = None,
    project_id: Values = None,
    project_id_not: Values = None,
    project_milestone_id: Values = None,
    project_milestone_id_not: Values = None,
    estimate: Values = None,
    estimate_not: Values = None,
    sla_status: Values = None,
    due_before: Annotated[Optional[str], Query()] = None,
    due_after: Annotated[Optional[str], Query()] = None,
    team_id_in: Values = None,
    team_id_not: Values = None,
    created_after: Annotated[Optional[str], Query()] = None,
    created_before: Annotated[Optional[str], Query()] = None,
    updated_after: Annotated[Optional[str], Query()] = None,
    updated_before: Annotated[Optional[str], Query()] = None,
    completed_after: Annotated[Optional[str], Query()] = None,
    completed_before: Annotated[Optional[str], Query()] = None,
    content: Annotated[Optional[str], Query(max_length=200)] = None,
    content_not: Annotated[Optional[str], Query(max_length=200)] = None,
    q: Annotated[Optional[str], Query()] = None,
    is_blocked: Annotated[Optional[bool], Query()] = None,
    is_blocking: Annotated[Optional[bool], Query()] = None,
    has_relation: Values = None,
    customer_id: Values = None,
    customer_id_not: Values = None,
    match: Annotated[Optional[str], Query()] = None,
    groups: Annotated[Optional[str], Query(max_length=8000)] = None,
    include_archived: Annotated[bool, Query()] = False,
    archived_only: Annotated[bool, Query()] = False,
    include_triage: Annotated[bool, Query()] = False,
    triage_only: Annotated[bool, Query()] = False,
    sort: Annotated[SortField, Query()] = "updated_desc",
    reverse: Annotated[bool, Query()] = False,
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    updated_since: Annotated[Optional[datetime], Query()] = None,
) -> IssueSyncListRead | Response:
    """One page of the issues the caller may see, filtered and sorted.

    Every id filter repeats, ORing its values, and `none` matches the unset field
    where the field can be unset. Filters are applied after the key read rather
    than through an index, so adding one costs no GSI. The cursor is a position in
    the filtered, sorted set and is bound to the filter, so a cursor carried to a
    different filter starts over rather than skipping rows.

    The exception is a filter on one person: `subscriber_id=me`, one `creator_id`
    or one `assignee_id` reads that person's own index instead of every team, which
    is what the My issues tabs ask for. Any other `subscriber_id` is matched after
    the read, against the subscriptions of each person it names.

    `match=any` keeps an issue meeting any one condition rather than all of them.
    `groups` is a JSON array of condition objects, each holding these same filter
    names plus its own `match`, and each counting as one condition, which is how
    "status is Todo and (label is Bug or priority is Urgent)" is said. A group may
    hold groups of its own, two levels at most, so a client can wrap its own
    conditions in one group under the list's fixed scope. `content`
    matches title and description text, `label_id_all` wants every label named,
    and `completed_after` and `completed_before` bound the day an issue was done.
    The `completed_desc` sort puts the latest `completed_at` first and issues not
    completed last.
    `customer_id` keeps the issues one of the named customers asked for and
    `customer_id_not` drops them, `none` standing for no customer request and
    `important` for an important one, and the `customer_requests_desc`,
    `customer_important_desc` and `customer_revenue_desc` sorts put the most
    requested, most importantly requested or highest revenue issues first.
    Guests may use neither.

    Archived issues are left out unless `include_archived` is set, and
    `archived_only` lists nothing but them, the archive view. That read goes
    straight to each status's archived partition of the status index rather than
    reading every issue of the team and dropping the live ones. Issues awaiting
    triage are left out the same way unless `include_triage` is set, and
    `triage_only` lists nothing but them.

    `include_sub_teams` with a `team_id` rolls that team's sub-teams the caller
    may see into the list, so a parent team's views show its sub-teams' issues.
    `reverse` turns the sort around, issues lacking the sorted value still last.
    Each sub-issue carries its parent's `parent_key` and `parent_title`, so a row
    listed apart from its parent can still name it.

    Every body carries `synced_at`. Sent back as `updated_since` with the same
    filter, it turns the read into a delta: only the issues changed since, every
    one in the list's sort order and unpaged, plus `removed_ids` for issues that
    left the filter, were archived or were deleted. `resync_required` asks for a
    full read instead, when the cursor is older than deletions are remembered or
    the delta is too large to carry. A delta costs one key-bounded query per team
    on the change feed index, so a poll that finds nothing reads almost nothing.

    A delta answer carries a weak `ETag` over its body. Two polls that find the
    same thing answer the same body, so a poll that sends the tag back in
    `If-None-Match` gets a 304 with no body instead. A full read carries none,
    because its cursor moves with the clock.
    """
    subscribed = subscribed_by_caller(subscriber_id, match, context.user_id)
    try:
        wanted = build_issue_filter(
            user_id=context.user_id,
            status_id=status_id,
            status_id_not=status_id_not,
            status_category=status_category,
            status_category_not=status_category_not,
            assignee_id=assignee_id,
            assignee_id_not=assignee_id_not,
            creator_id=creator_id,
            creator_id_not=creator_id_not,
            label_id=label_id,
            label_id_not=label_id_not,
            label_id_all=label_id_all,
            priority=priority,
            priority_not=priority_not,
            parent_id=parent_id,
            parent_id_not=parent_id_not,
            has_sub_issues=has_sub_issues,
            subscriber_id=None if subscribed else subscriber_id,
            subscriber_id_not=subscriber_id_not,
            cycle_id=cycle_id,
            cycle_id_not=cycle_id_not,
            project_id=project_id,
            project_id_not=project_id_not,
            project_milestone_id=project_milestone_id,
            project_milestone_id_not=project_milestone_id_not,
            estimate=estimate,
            estimate_not=estimate_not,
            sla_status=sla_status,
            due_before=due_before,
            due_after=due_after,
            team_id_in=team_id_in,
            team_id_not=team_id_not,
            created_after=created_after,
            created_before=created_before,
            updated_after=updated_after,
            updated_before=updated_before,
            completed_after=completed_after,
            completed_before=completed_before,
            content=content,
            content_not=content_not,
            q=q,
            include_archived=include_archived,
            archived_only=archived_only,
            is_blocked=is_blocked,
            is_blocking=is_blocking,
            has_relation=has_relation,
            customer_id=customer_id,
            customer_id_not=customer_id_not,
            include_triage=include_triage,
            triage_only=triage_only,
            match=match,
            groups=groups,
        )
    except UnknownStatusCategory as exc:
        raise unprocessable(str(exc)) from exc

    if updated_since is not None:
        changes = list_issue_changes(
            repositories,
            context,
            wanted,
            team_id=team_id,
            sort=sort,
            since=updated_since,
            subscribed=subscribed,
            include_sub_teams=include_sub_teams,
            reverse=reverse,
        )
        changed_parents = parents_of(repositories.issues, repositories.teams, context.workspace_id, changes.issues)
        delta = IssueSyncListRead(
            items=[IssueRead.from_row(issue, changed_parents.get(issue.parent_id or "")) for issue in changes.issues],
            next_cursor=None,
            synced_at=changes.synced_at,
            removed_ids=changes.removed_ids,
            resync_required=changes.resync_required,
        )
        return conditional_response(request, delta)

    synced_at = sync_cursor()
    rows, next_cursor = list_issues_page(
        repositories,
        context,
        wanted,
        team_id=team_id,
        sort=sort,
        cursor=cursor,
        limit=limit,
        subscribed=subscribed,
        include_sub_teams=include_sub_teams,
        reverse=reverse,
    )
    parents = parents_of(repositories.issues, repositories.teams, context.workspace_id, rows)
    return IssueSyncListRead(
        items=[IssueRead.from_row(issue, parents.get(issue.parent_id or "")) for issue in rows],
        next_cursor=next_cursor,
        synced_at=synced_at,
    )


@router.post("/{workspace_id}/issues", response_model=IssueRead, status_code=status.HTTP_201_CREATED)
def create_issue(
    payload: IssueCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IssueRead:
    """Create an issue, allocating its key from the team's counter.

    The counter is allocated after every validation has passed, because a number is
    consumed whether or not the write lands and the contract accepts gaps but not
    wasted ones.
    """
    created = create_issue_row(repositories, context, payload)
    return IssueRead.from_row(current(repositories.teams, created))


@router.get("/{workspace_id}/issues/deleted", response_model=DeletedIssueListRead)
def list_deleted_issues(
    team_id: Annotated[str, Query(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> DeletedIssueListRead:
    """One team's recently deleted issues, newest first, each restorable until it is purged.

    Declared before `/issues/{issue_id}` so `deleted` is not swallowed as an id.
    """
    rows = list_trash(repositories, context, team_id)
    rows.sort(key=lambda row: row.deleted_at or row.updated_at, reverse=True)
    return DeletedIssueListRead(
        issues=[IssueRead.from_row(current(repositories.teams, row)) for row in rows],
        retention_days=TRASH_RETENTION_DAYS,
    )


@router.get("/{workspace_id}/issues/by-key/{key}", response_model=IssueRead)
def read_issue_by_key(
    request: Request,
    key: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """One issue by its human key, `ABC-123` and case insensitive.

    Declared before `/issues/{issue_id}` so `by-key` is not swallowed as an id, and
    the prefix names the team, which is what makes this one indexed query. A key
    the issue held before it moved to another team answers the issue under its new
    key, visible by the team it now belongs to. Like the read by id, the answer
    carries a weak `ETag` and an unchanged poll gets a 304.
    """
    parsed = parse_issue_key(key)
    if parsed is None:
        raise not_found()
    prefix, number = parsed

    team = repositories.teams.get_by_key_prefix(context.workspace_id, prefix)
    if team is None:
        raise not_found()

    issue = find_issue_by_number(repositories, context.workspace_id, team.team_id, number, include_deleted=True)
    if issue is None or not context.can_see_team(issue.team_id):
        raise not_found()
    return conditional_response(request, IssueRead.from_row(current(repositories.teams, issue)))


@router.get("/{workspace_id}/issues/{issue_id}", response_model=IssueRead)
def read_issue(
    request: Request,
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """One issue the caller may read.

    The answer carries a weak `ETag` over its body, so a poll that sends it back
    in `If-None-Match` gets a 304 with no body while the issue is unchanged.
    """
    row = load_visible_issue(repositories, context, issue_id, include_deleted=True)
    return conditional_response(request, IssueRead.from_row(current(repositories.teams, row)))


@router.patch("/{workspace_id}/issues", response_model=IssueBulkRead)
def bulk_update_issues(
    payload: IssueBulkUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IssueBulkRead:
    """Apply one partial patch to up to `BULK_MAX_ISSUES` issues.

    All or nothing on validation: every issue is loaded, authorized and has the
    patch applied in memory before any is written, so an invisible issue (404), a
    team the caller cannot write in (403) or a value one issue's team refuses (422)
    fails the whole request with nothing changed. Each issue then goes through the
    same write and activity path a single patch does, so history cannot tell a bulk
    edit from one issue edited at a time. `archived` then archives or restores each
    issue through the single-issue archive path, with the same team membership rule.
    """
    stored, skipped = bulk_update_row(repositories, context, payload)
    return IssueBulkRead(
        issues=[IssueRead.from_row(current(repositories.teams, issue)) for issue in stored], skipped=skipped
    )


@router.patch("/{workspace_id}/issues/{issue_id}", response_model=IssueRead)
def update_issue(
    payload: IssueUpdate,
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IssueRead:
    """Change an issue's fields and record one activity row per field that moved.

    Activity is written here rather than by the stream consumer, so history can
    name the actor: a stream record carries the change but not who made it.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    stored = update_issue_row(repositories, context, issue, payload.model_dump(exclude_unset=True))
    return IssueRead.from_row(current(repositories.teams, stored))


@router.post("/{workspace_id}/issues/{issue_id}/move", response_model=IssueRead)
def move_issue(
    payload: IssueMove,
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IssueRead:
    """Move an issue, and its sub-issues, to another team, answering it under its new key.

    The caller must be able to write in both teams. The old key keeps resolving
    through the by-key read, and values the target team cannot hold are dropped
    rather than refused.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    stored = move_issue_row(repositories, context, issue, payload.team_id)
    return IssueRead.from_row(current(repositories.teams, stored))


@router.post(
    "/{workspace_id}/issues/{issue_id}/duplicate", response_model=IssueRead, status_code=status.HTTP_201_CREATED
)
def duplicate(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    payload: IssueDuplicate | None = None,
) -> IssueRead:
    """Create a copy of an issue in its team, answering the new issue under its own key.

    The copy carries the title with a copy suffix, the description, labels,
    priority, estimate, parent, project and milestone, and starts in the team's
    default status, unassigned and outside any cycle, as in Linear. With
    `include_sub_issues` its sub-issue tree is copied under it too, and a tree
    above the cap is refused with a 422.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    include = payload is not None and payload.include_sub_issues
    copy = duplicate_issue(repositories, context, issue, include_sub_issues=include)
    return IssueRead.from_row(current(repositories.teams, copy))


@router.post("/{workspace_id}/issues/{issue_id}/convert-to-project", response_model=IssueConversionRead)
def convert_issue_to_project(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IssueConversionRead:
    """Turn an issue into a project on its team, moving its sub-issues into the project and closing it.

    The project takes the issue's title, description, priority, assignee as lead
    and dates. The issue is pointed at the project, which is the link back, and
    moved to the team's first completed status, or cancelled when the team has no
    completed one.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    project, closed, moved = convert_to_project(repositories, context, issue)
    return IssueConversionRead(
        project=project,
        issue=IssueRead.from_row(current(repositories.teams, closed)),
        moved_issue_ids=[child.issue_id for child in moved],
    )


@router.post("/{workspace_id}/issues/{issue_id}/archive", response_model=IssueRead)
def archive_issue(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IssueRead:
    """Archive an issue, hiding it from lists and boards while keeping it searchable and restorable.

    Idempotent: archiving an archived issue answers with it unchanged.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    return IssueRead.from_row(current(repositories.teams, archive_issue_row(repositories, context, issue)))


@router.post("/{workspace_id}/issues/{issue_id}/unarchive", response_model=IssueRead)
def unarchive_issue(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IssueRead:
    """Restore an archived issue to its lists and board.

    Idempotent: restoring a live issue answers with it unchanged.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    return IssueRead.from_row(current(repositories.teams, unarchive_issue_row(repositories, context, issue)))


@router.delete("/{workspace_id}/issues/{issue_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_issue(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Move an issue to its team's trash, where it stays restorable for 30 days.

    A team admin may always delete. Anyone else may delete only an issue they
    created and only while it has no sub-issues, so an ordinary member cannot hide
    someone else's tree. Its children, links and history wait for a restore.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    trash_issue_row(repositories, context, issue)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{workspace_id}/issues/{issue_id}/restore", response_model=IssueRead)
def restore_issue(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IssueRead:
    """Bring a deleted issue back from the trash with its sub-issues, links, labels and comments.

    Allowed for the same people who may delete it. Idempotent: restoring a live
    issue answers with it unchanged.
    """
    issue = load_visible_issue(repositories, context, issue_id, include_deleted=True)
    return IssueRead.from_row(current(repositories.teams, restore_issue_row(repositories, context, issue)))


@router.delete("/{workspace_id}/issues/{issue_id}/permanent", status_code=status.HTTP_204_NO_CONTENT)
def delete_issue_permanently(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Delete an issue in the trash for good, which only a team admin may do.

    Its sub-issues lose their parent and its links and history are removed, as
    the hourly sweep does once the 30 days have passed.
    """
    issue = load_visible_issue(repositories, context, issue_id, include_deleted=True)
    purge_now(repositories, context, issue)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{workspace_id}/issues/{issue_id}/children", response_model=IssueListRead)
def list_children(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> CursorPage[IssueRead]:
    """One page of an issue's direct children, oldest first."""
    load_visible_issue(repositories, context, issue_id)
    scope = f"children:{context.workspace_id}:{issue_id}"
    page = repositories.issues.list_children(
        context.workspace_id,
        issue_id,
        limit=limit,
        start_key=resume_key(cursor, scope),
    )
    rows = [as_issue(item) for item in page.items]
    return IssueListRead(
        items=[IssueRead.from_row(current(repositories.teams, issue)) for issue in rows],
        next_cursor=encode_start_key(page.last_evaluated_key, scope=scope),
    )
