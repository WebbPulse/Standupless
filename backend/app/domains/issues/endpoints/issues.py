"""Issue routes: list, create, read, look up by key, patch, delete and list children.

Issues are workspace scoped, so the team is a field rather than a path segment
and every route decides visibility against the issue's own team through the
service helpers. The list route fans out across the teams the caller may see,
because there is no index spanning a workspace's issues and filtering after the
read would let an invisible team's rows influence a page boundary.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from webbpulse.http import CursorPage

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.pagination import (
    decode_cursor,
    encode_cursor,
)
from app.common.api.schemas.issues import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    IssueBulkRead,
    IssueBulkUpdate,
    IssueCreate,
    IssueListRead,
    IssueRead,
    IssueSyncListRead,
    IssueUpdate,
    SortField,
    parse_issue_key,
)
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.issues import (
    Issue,
    as_issue,
)
from app.common.issue_archive import archive_issue as archive_issue_row
from app.common.issue_archive import unarchive_issue as unarchive_issue_row
from app.common.issue_changes import list_issue_changes, sync_cursor
from app.common.issue_filters import ME, UnknownStatusCategory, build_issue_filter
from app.common.issue_keys import current
from app.common.issue_rules import (
    load_visible_issue,
    not_found,
    require_team_admin,
    require_team_member,
    unprocessable,
)
from app.common.issue_writes import bulk_update_issues as bulk_update_row
from app.common.issue_writes import create_issue as create_issue_row
from app.common.issue_writes import list_issues as list_issues_page
from app.common.issue_writes import update_issue as update_issue_row
from app.common.relation_effects import child_activity, delete_relations

router = APIRouter()

Values = Annotated[Optional[list[str]], Query()]
"""A repeatable query parameter: `k=a&k=b` is any of `a` or `b`, and one `k=a` still works."""


@router.get("/{workspace_id}/issues", response_model=IssueSyncListRead)
def list_issues(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    team_id: Annotated[Optional[str], Query()] = None,
    status_id: Values = None,
    status_id_not: Values = None,
    status_category: Values = None,
    status_category_not: Values = None,
    assignee_id: Values = None,
    assignee_id_not: Values = None,
    creator_id: Values = None,
    creator_id_not: Values = None,
    subscriber_id: Annotated[Optional[str], Query()] = None,
    label_id: Values = None,
    label_id_not: Values = None,
    parent_id: Values = None,
    priority: Values = None,
    priority_not: Values = None,
    cycle_id: Values = None,
    cycle_id_not: Values = None,
    project_id: Values = None,
    project_id_not: Values = None,
    project_milestone_id: Values = None,
    project_milestone_id_not: Values = None,
    due_before: Annotated[Optional[str], Query()] = None,
    due_after: Annotated[Optional[str], Query()] = None,
    q: Annotated[Optional[str], Query()] = None,
    include_archived: Annotated[bool, Query()] = False,
    archived_only: Annotated[bool, Query()] = False,
    sort: Annotated[SortField, Query()] = "updated_desc",
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    updated_since: Annotated[Optional[datetime], Query()] = None,
) -> IssueSyncListRead:
    """One page of the issues the caller may see, filtered and sorted.

    Every id filter repeats, ORing its values, and `none` matches the unset field
    where the field can be unset. Filters are applied after the key read rather
    than through an index, so adding one costs no GSI. The cursor is a position in
    the filtered, sorted set and is bound to the filter, so a cursor carried to a
    different filter starts over rather than skipping rows.

    The exception is a filter on one person: `subscriber_id=me`, one `creator_id`
    or one `assignee_id` reads that person's own index instead of every team, which
    is what the My issues tabs ask for. `subscriber_id` takes only the caller,
    because what someone else follows is theirs to know.

    Archived issues are left out unless `include_archived` is set, and
    `archived_only` lists nothing but them, the archive view. That read goes
    straight to each status's archived partition of the status index rather than
    reading every issue of the team and dropping the live ones.

    Every body carries `synced_at`. Sent back as `updated_since` with the same
    filter, it turns the read into a delta: only the issues changed since, every
    one in the list's sort order and unpaged, plus `removed_ids` for issues that
    left the filter, were archived or were deleted. `resync_required` asks for a
    full read instead, when the cursor is older than deletions are remembered or
    the delta is too large to carry. A delta costs one key-bounded query per team
    on the change feed index, so a poll that finds nothing reads almost nothing.
    """
    subscribed = subscriber_id is not None
    if subscribed and subscriber_id not in (ME, context.user_id):
        raise unprocessable("subscriber_id only accepts me")
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
            priority=priority,
            priority_not=priority_not,
            parent_id=parent_id,
            cycle_id=cycle_id,
            cycle_id_not=cycle_id_not,
            project_id=project_id,
            project_id_not=project_id_not,
            project_milestone_id=project_milestone_id,
            project_milestone_id_not=project_milestone_id_not,
            due_before=due_before,
            due_after=due_after,
            q=q,
            include_archived=include_archived,
            archived_only=archived_only,
        )
    except UnknownStatusCategory as exc:
        raise unprocessable(str(exc)) from exc

    if updated_since is not None:
        changes = list_issue_changes(
            repositories, context, wanted, team_id=team_id, sort=sort, since=updated_since, subscribed=subscribed
        )
        return IssueSyncListRead(
            items=[IssueRead.from_row(issue) for issue in changes.issues],
            next_cursor=None,
            synced_at=changes.synced_at,
            removed_ids=changes.removed_ids,
            resync_required=changes.resync_required,
        )

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
    )
    return IssueSyncListRead(
        items=[IssueRead.from_row(issue) for issue in rows], next_cursor=next_cursor, synced_at=synced_at
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


@router.get("/{workspace_id}/issues/by-key/{key}", response_model=IssueRead)
def read_issue_by_key(
    key: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IssueRead:
    """One issue by its human key, `ABC-123` and case insensitive.

    Declared before `/issues/{issue_id}` so `by-key` is not swallowed as an id, and
    the prefix names the team, which is what makes this one indexed query.
    """
    parsed = parse_issue_key(key)
    if parsed is None:
        raise not_found()
    prefix, number = parsed

    team = repositories.teams.get_by_key_prefix(context.workspace_id, prefix)
    if team is None or not context.can_see_team(team.team_id):
        raise not_found()

    issue = repositories.issues.get_by_number(context.workspace_id, team.team_id, number)
    if issue is None:
        raise not_found()
    return IssueRead.from_row(current(repositories.teams, issue))


@router.get("/{workspace_id}/issues/{issue_id}", response_model=IssueRead)
def read_issue(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IssueRead:
    """One issue the caller may read."""
    return IssueRead.from_row(current(repositories.teams, load_visible_issue(repositories, context, issue_id)))


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
    """Delete an issue, reparenting its children and removing its links and history.

    A team admin may always delete. Anyone else may delete only an issue they
    created and only while it has no children, so an ordinary member cannot orphan
    someone else's sub-issues.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    children = repositories.issues.iter_children(context.workspace_id, issue_id)

    if not _may_delete(repositories, context, issue, children):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error_code": "FORBIDDEN", "message": "Not allowed"},
        )

    for child in children:
        orphan = child.model_copy(deep=True)
        orphan.parent_id = None
        repositories.issues.replace(orphan)
    repositories.activity.record_many(
        [
            build_activity(
                context.workspace_id,
                child.team_id,
                child.issue_id,
                context.user_id,
                "field_changed",
                field="parent_id",
                from_value=issue_id,
                to_value=None,
            )
            for child in children
        ]
        + child_activity(repositories, context.workspace_id, context.user_id, issue, issue.parent_id, None)
    )

    delete_relations(repositories, context.workspace_id, issue_id)
    repositories.activity.delete_for_issue(context.workspace_id, issue_id)
    repositories.subscriptions.delete_for_issue(context.workspace_id, issue_id)
    repositories.issues.delete(context.workspace_id, issue_id)
    repositories.activity.record_tombstone(context.workspace_id, issue.team_id, issue_id, context.user_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _may_delete(repositories: Repositories, context: AuthzContext, issue: Issue, children: list[Issue]) -> bool:
    """Whether this caller may delete this issue.

    Split out because the contract's rule is two clauses joined by an or, and
    reading it as one condition inside the route hid the creator case.
    """
    try:
        require_team_admin(repositories, context, issue.team_id)
        return True
    except HTTPException as exc:
        if exc.status_code == status.HTTP_404_NOT_FOUND:
            raise
    if issue.created_by != context.user_id:
        return False
    if children:
        return False
    try:
        require_team_member(repositories, context, issue.team_id)
    except HTTPException:
        return False
    return True


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
        start_key=decode_cursor(cursor, scope),
    )
    rows = [as_issue(item) for item in page.items]
    return IssueListRead(
        items=[IssueRead.from_row(current(repositories.teams, issue)) for issue in rows],
        next_cursor=encode_cursor(page.last_evaluated_key, scope),
    )
