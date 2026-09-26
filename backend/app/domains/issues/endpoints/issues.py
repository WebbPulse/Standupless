"""Issue routes: list, create, read, look up by key, patch, delete and list children.

Issues are workspace scoped, so the team is a field rather than a path segment
and every route decides visibility against the issue's own team through the
service helpers. The list route fans out across the teams the caller may see,
because there is no index spanning a workspace's issues and filtering after the
read would let an invisible team's rows influence a page boundary.
"""

from __future__ import annotations

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from webbpulse.dynamodb import ConditionFailed
from webbpulse.http import CursorPage

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.pagination import (
    decode_cursor,
    decode_offset_cursor,
    encode_cursor,
    encode_offset_cursor,
    merge_sorted,
)
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.issues import (
    PRIORITY_ORDER,
    Issue,
    as_issue,
    issue_key,
    new_issue_id,
)
from app.common.issue_filters import UnknownStatusCategory, build_issue_filter
from app.common.issue_keys import current, current_all
from app.domains.issues.relation_effects import child_activity, delete_relations
from app.domains.issues.schemas.issue import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    IssueBulkRead,
    IssueBulkUpdate,
    IssueCreate,
    IssueListRead,
    IssueRead,
    IssueUpdate,
    SortField,
    parse_issue_key,
)
from app.domains.issues.service import (
    changed_fields,
    check_assignee,
    check_cycle,
    check_estimate,
    check_labels,
    check_parent,
    check_project,
    check_status,
    default_status,
    load_visible_issue,
    not_found,
    require_team_admin,
    require_team_member,
    require_team_reader,
    status_categories,
    unprocessable,
    visible_team_ids,
)

router = APIRouter()

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


def _sort_key(sort: str) -> Any:
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


def _descending(sort: str) -> bool:
    """Whether one sort reads newest or highest first.

    `key_asc`, `due_asc` and `manual` climb; the rest descend, which is what their
    names say. A manual order climbs so the smallest key is the top of the list,
    and an issue nobody has placed yet sorts after every placed one.
    """
    return sort not in ("key_asc", "due_asc", "manual")


Values = Annotated[Optional[list[str]], Query()]
"""A repeatable query parameter: `k=a&k=b` is any of `a` or `b`, and one `k=a` still works."""


@router.get("/{workspace_id}/issues", response_model=IssueListRead)
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
    label_id: Values = None,
    label_id_not: Values = None,
    parent_id: Values = None,
    priority: Values = None,
    priority_not: Values = None,
    cycle_id: Values = None,
    cycle_id_not: Values = None,
    project_id: Values = None,
    project_id_not: Values = None,
    due_before: Annotated[Optional[str], Query()] = None,
    due_after: Annotated[Optional[str], Query()] = None,
    q: Annotated[Optional[str], Query()] = None,
    sort: Annotated[SortField, Query()] = "updated_desc",
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> CursorPage[IssueRead]:
    """One page of the issues the caller may see, filtered and sorted.

    Every id filter repeats, ORing its values, and `none` matches the unset field
    where the field can be unset. Filters are applied after the key read rather
    than through an index, so adding one costs no GSI. The cursor is a position in
    the filtered, sorted set and is bound to the filter, so a cursor carried to a
    different filter starts over rather than skipping rows.
    """
    try:
        wanted = build_issue_filter(
            user_id=context.user_id,
            status_id=status_id,
            status_id_not=status_id_not,
            status_category=status_category,
            status_category_not=status_category_not,
            assignee_id=assignee_id,
            assignee_id_not=assignee_id_not,
            label_id=label_id,
            label_id_not=label_id_not,
            priority=priority,
            priority_not=priority_not,
            parent_id=parent_id,
            cycle_id=cycle_id,
            cycle_id_not=cycle_id_not,
            project_id=project_id,
            project_id_not=project_id_not,
            due_before=due_before,
            due_after=due_after,
            q=q,
        )
    except UnknownStatusCategory as exc:
        raise unprocessable(str(exc)) from exc

    if team_id is not None:
        require_team_reader(repositories, context, team_id)
        teams = [team_id]
    else:
        teams = visible_team_ids(repositories, context)

    if not teams:
        return IssueListRead(items=[], next_cursor=None)

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
    ordered = merge_sorted(matched, _sort_key(sort), descending=_descending(sort))
    window_rows = ordered[offset : offset + limit]
    next_offset = offset + len(window_rows)
    next_cursor = encode_offset_cursor(next_offset, scope) if next_offset < len(ordered) else None
    return IssueListRead(items=[IssueRead.from_row(issue) for issue in window_rows], next_cursor=next_cursor)


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
        sort_order=payload.sort_order,
        created_by=context.user_id,
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
    edit from one issue edited at a time.
    """
    loaded = repositories.issues.get_many(context.workspace_id, payload.issue_ids)
    issues: list[Issue] = []
    for issue_id in payload.issue_ids:
        issue = loaded.get(issue_id)
        if issue is None or not context.can_see_team(issue.team_id):
            raise not_found()
        issues.append(issue)

    for team in dict.fromkeys(issue.team_id for issue in issues):
        require_team_member(repositories, context, team)

    patch = payload.patch
    shared = patch.model_dump(exclude_unset=True, exclude={"add_label_ids", "remove_label_ids"})
    planned: list[tuple[Issue, Issue]] = []
    for issue in issues:
        attributes = dict(shared)
        if patch.add_label_ids or patch.remove_label_ids:
            removed = set(patch.remove_label_ids)
            kept = [label for label in issue.label_ids if label not in removed]
            attributes["label_ids"] = kept + [label for label in patch.add_label_ids if label not in kept]
        planned.append((issue, _apply_patch(repositories, context, issue, attributes)))

    stored: list[Issue] = []
    skipped: list[str] = []
    for issue, updated in planned:
        try:
            stored.append(_store(repositories, context, issue, updated))
        except HTTPException as exc:
            if exc.status_code != status.HTTP_404_NOT_FOUND:
                raise
            skipped.append(issue.issue_id)
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
    require_team_member(repositories, context, issue.team_id)

    attributes = payload.model_dump(exclude_unset=True)
    if not attributes:
        return IssueRead.from_row(current(repositories.teams, issue))

    updated = _apply_patch(repositories, context, issue, attributes)
    return IssueRead.from_row(current(repositories.teams, _store(repositories, context, issue, updated)))


def _apply_patch(repositories: Repositories, context: AuthzContext, issue: Issue, attributes: dict[str, Any]) -> Issue:
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
    if "sort_order" in attributes:
        updated.sort_order = attributes["sort_order"]
    return updated


def _store(repositories: Repositories, context: AuthzContext, issue: Issue, updated: Issue) -> Issue:
    """Write a patched issue and its activity rows, or leave it alone if nothing moved.

    A moved manual position is written but records no activity: dragging a row is
    arrangement rather than a change to the issue, and a history full of reorders
    would bury the edits a reader is looking for. Raises the 404 when the issue was
    deleted after it was read.
    """
    changes = changed_fields(issue, updated, PATCHABLE_FIELDS)
    if not changes and issue.sort_order == updated.sort_order:
        return issue

    updated.updated_at = _now()
    try:
        stored = repositories.issues.replace(updated)
    except ConditionFailed as exc:
        raise not_found() from exc

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
                    from_value=_jsonable(before),
                    to_value=_jsonable(after),
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
    repositories.issues.delete(context.workspace_id, issue_id)
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


def _jsonable(value: Any) -> Any:
    """One field value as something DynamoDB and JSON both accept.

    A label list and a date string pass through; anything with a richer type is
    rendered as text, because an activity row records what changed for a reader
    rather than being read back into a model.
    """
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, list):
        return [_jsonable(entry) for entry in value]
    return str(value)


def _now() -> Any:
    """The current instant, imported lazily so the clock has one source.

    Deferred to keep the module's import graph the same as every other endpoint
    module's, which the entrypoint isolation test reads.
    """
    from app.common.db.dynamo.base import utc_now

    return utc_now()
