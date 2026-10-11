"""The issue list, create, patch and bulk patch paths, shared by the issue routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and an agent creating or patching an issue must leave exactly the rows a
person's request leaves: the same key allocation, validation, activity and
subscriptions. Every function raises the routes' `HTTPException`s, which the MCP
transport maps to tool errors.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from boto3.dynamodb.conditions import Attr
from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed, encode_start_key

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import digest_scope, merge_sorted, resume_key
from app.common.api.schemas.issues import IssueBulkUpdate, IssueCreate
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.api_keys import is_service_subject
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import (
    PRIORITY_ORDER,
    Issue,
    IssueWriteConflict,
    issue_key,
    new_issue_id,
)
from app.common.db.dynamo.team_config import Label
from app.common.estimates import is_unestimated
from app.common.filter_resolution import resolve_issue_filter
from app.common.issue_archive import archive_issue, unarchive_issue
from app.common.issue_filters import ME, NONE, IssueFilter, estimate_value
from app.common.issue_keyed_reads import keyed_rows
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
    issue_changed,
    lands_in_triage,
    not_found,
    require_team_member,
    status_categories,
    subscribe_touched,
    unprocessable,
)
from app.common.issue_templates import apply_template
from app.common.labels import replace_group_siblings
from app.common.mentions import mentioned_user_ids
from app.common.relation_effects import child_activity
from app.common.sla import apply_sla, sla_breach_key
from app.common.sub_teams import listed_teams

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

TEAM_SCAN_BUDGET = 2000
"""How many issues one list request reads across its teams before the walk stops.

Every team is read whole, newest number first, until this many issues are in hand;
filtering and sorting then run over everything read. When the budget stops the
walk, the page carries a cursor that resumes it where it stopped, so no issue is
dropped, and the sort holds within each stretch the budget covers.
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
    if sort == "sla_asc":
        return sla_breach_key
    if sort == "manual":
        return lambda issue: (issue.sort_order is None, issue.sort_order or "", issue.issue_id)
    return lambda issue: (issue.updated_at, issue.issue_id)


def descending(sort: str) -> bool:
    """Whether one sort reads newest or highest first.

    `key_asc`, `due_asc`, `sla_asc` and `manual` climb; the rest descend, which is what their
    names say. A manual order climbs so the smallest key is the top of the list,
    and an issue nobody has placed yet sorts after every placed one.
    """
    return sort not in ("key_asc", "due_asc", "sla_asc", "manual")


def list_issues(
    repositories: Repositories,
    context: AuthzContext,
    wanted: IssueFilter,
    *,
    team_id: Optional[str],
    sort: str,
    cursor: Optional[str],
    limit: int,
    subscribed: bool = False,
    include_sub_teams: bool = False,
) -> tuple[list[Issue], Optional[str]]:
    """One page of the issues the caller may see, filtered and sorted, and the next cursor.

    Fans out across the visible teams, or the one named, because there is no index
    spanning a workspace's issues. Each team is walked through every page up to
    `TEAM_SCAN_BUDGET`, so an old issue a filter matches is found; the cursor is a
    position in that walk and is bound to the filter, so a cursor carried to a
    different filter starts over rather than skipping rows.

    A filter on one person, or `subscribed` for the caller's own subscriptions,
    reads that person's index instead of every team; the mode is part of the
    cursor scope, since the keyed and fanned out sets differ. `include_sub_teams`
    rolls the named team's visible sub-teams into the list.
    """
    teams = listed_teams(repositories, context, team_id, include_sub_teams=include_sub_teams)

    if not teams:
        return [], None

    wanted = resolve_issue_filter(repositories, context.workspace_id, teams, wanted)
    categories: dict[str, str] = {}
    if wanted.needs_categories:
        for candidate in teams:
            categories.update(status_categories(repositories, context.workspace_id, candidate))

    mode = "subscribed" if subscribed else "all"
    scope = digest_scope(f"issues:{context.workspace_id}:{','.join(teams)}:{sort}:{mode}:{wanted.fingerprint()}")
    keyed = keyed_rows(repositories, context, wanted, subscribed, teams)
    if keyed is None and wanted.archived_only:
        keyed = archived_rows(repositories, context.workspace_id, teams, TEAM_SCAN_BUDGET)
    return walk_page(
        repositories,
        context.workspace_id,
        teams,
        cursor=cursor,
        scope=scope,
        limit=limit,
        keep=lambda issue: wanted.matches(issue, categories),
        key=sort_key(sort),
        descending=descending(sort),
        rows=keyed,
    )


def walk_teams(
    repositories: Repositories,
    workspace_id: str,
    teams: list[str],
    start: tuple[int, int],
    budget: int,
) -> tuple[list[Issue], Optional[tuple[int, int]]]:
    """Read the named teams in turn, newest number first, until the budget is spent.

    `start` and the position answered are a team index and the number to read
    below in that team, 0 for its newest. The position is `None` once every team
    has been read to its end.
    """
    team_index, below = start
    rows: list[Issue] = []
    while team_index < len(teams):
        remaining = budget - len(rows)
        if remaining <= 0:
            return current_all(repositories.teams, rows), (team_index, below)
        chunk = repositories.issues.read_team_newest(
            workspace_id, teams[team_index], below=below or None, max_items=remaining
        )
        rows.extend(chunk)
        if len(chunk) < remaining:
            team_index += 1
            below = 0
        else:
            below = chunk[-1].number
    return current_all(repositories.teams, rows), None


def walk_page(
    repositories: Repositories,
    workspace_id: str,
    teams: list[str],
    *,
    cursor: Optional[str],
    scope: str,
    limit: int,
    keep: Callable[[Issue], bool],
    key: Any,
    descending: bool,
    rows: Optional[list[Issue]] = None,
    budget: Optional[int] = None,
) -> tuple[list[Issue], Optional[str]]:
    """One page of the issues `keep` admits, in `key` order, and the next cursor.

    The cursor holds where the current stretch of the team walk started and how far
    into its sorted matches the caller got. When the stretch is used up and the
    budget had stopped the walk, the next cursor starts the following stretch, so
    a page can come back short or empty while a cursor is still answered. `rows`
    stands in for the walk when an index other than the team one already holds
    every candidate.
    """
    position = resume_key(cursor, scope) or {}
    start = (_position(position, "t"), _position(position, "b"))
    offset = _position(position, "o")
    end: Optional[tuple[int, int]] = None
    if rows is None:
        rows, end = walk_teams(repositories, workspace_id, teams, start, budget or TEAM_SCAN_BUDGET)
    ordered = merge_sorted([issue for issue in rows if keep(issue)], key, descending=descending)
    window_rows = ordered[offset : offset + limit]
    next_offset = offset + len(window_rows)
    if next_offset < len(ordered):
        next_cursor = encode_start_key({"t": start[0], "b": start[1], "o": next_offset}, scope=scope)
    elif end is not None:
        next_cursor = encode_start_key({"t": end[0], "b": end[1], "o": 0}, scope=scope)
    else:
        next_cursor = None
    return window_rows, next_cursor


def _position(payload: dict[str, Any], name: str) -> int:
    """One non-negative integer of a walk cursor, 0 when it is absent or unusable."""
    try:
        return max(int(payload.get(name, 0)), 0)
    except (TypeError, ValueError):
        return 0


def archived_rows(repositories: Repositories, workspace_id: str, teams: list[str], window: int) -> list[Issue]:
    """The archived issues of every named team, read from each status's archived partition.

    One query per status of each team, touching no live row, each partition read
    up to `window` issues.
    """
    rows: list[Issue] = []
    for team in teams:
        for row in repositories.team_config.list_statuses(workspace_id, team):
            rows.extend(
                repositories.issues.iter_archived_for_status(workspace_id, team, row.status_id, max_items=window)
            )
    return current_all(repositories.teams, rows)


def resolve_me(context: AuthzContext, user_id: Optional[str]) -> Optional[str]:
    """A user field's value with `me` resolved to the caller, as the list filters resolve it.

    A workspace key acts as the workspace rather than as a person, so `me` names
    nobody there and is refused with a 422 rather than stored as the key's
    synthetic principal.
    """
    if user_id != ME:
        return user_id
    if is_service_subject(context.user_id):
        raise unprocessable("me names no person for a workspace key")
    return context.user_id


def create_issue(repositories: Repositories, context: AuthzContext, payload: IssueCreate) -> Issue:
    """Create an issue, allocating its key from the team's counter.

    A named template fills the fields the payload leaves out before anything is
    validated, so a template's rows are held to the same checks as typed ones.
    The counter is allocated after every validation has passed, because a number
    is consumed whether or not the write lands and the contract accepts gaps but not
    wasted ones.
    """
    require_team_member(repositories, context, payload.team_id)
    team = repositories.teams.get(context.workspace_id, payload.team_id)
    if team is None:
        raise not_found()
    payload = apply_template(repositories, context, payload)

    if payload.status_id:
        chosen = check_status(repositories, context.workspace_id, payload.team_id, payload.status_id)
    else:
        chosen = default_status(repositories, context.workspace_id, payload.team_id)

    estimate = check_estimate(payload.estimate, team)
    label_ids = check_labels(repositories, context.workspace_id, payload.team_id, payload.label_ids)
    assignee_id = check_assignee(
        repositories, context.workspace_id, payload.team_id, resolve_me(context, payload.assignee_id)
    )
    issue_id = new_issue_id()
    parent_id = check_parent(repositories, context.workspace_id, payload.team_id, issue_id, payload.parent_id)

    cycle_id = check_cycle(repositories, context.workspace_id, payload.team_id, payload.cycle_id)
    project_id = check_project(repositories, context.workspace_id, payload.team_id, payload.project_id)
    project_milestone_id = check_project_milestone(
        repositories, context.workspace_id, project_id, payload.project_milestone_id
    )

    mentions = mentioned_user_ids(repositories, context.workspace_id, payload.body)
    in_triage = lands_in_triage(repositories, context, payload.team_id, payload.triage)
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
        updated_source=context.source,
        mentioned_user_ids=mentions,
        in_triage=in_triage,
    )
    apply_sla(repositories, None, issue)
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
            source=context.source,
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
                    source=context.source,
                ),
                *child_activity(
                    repositories,
                    context.workspace_id,
                    context.user_id,
                    created,
                    None,
                    created.parent_id,
                    context.source,
                ),
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
    issue before it stores any. A status change by anyone but a guest also takes
    the issue out of triage, as accepting it would.
    """
    updated = issue.model_copy(deep=True)
    if "status_id" in attributes and attributes["status_id"] is not None:
        chosen = check_status(repositories, context.workspace_id, issue.team_id, attributes["status_id"])
        updated.status_id = chosen.status_id
        if updated.status_id != issue.status_id and not context.is_guest:
            updated.in_triage = False
            updated.snoozed_until = None
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
        updated.estimate = check_estimate(attributes["estimate"], team, current=issue.estimate)
    if "label_ids" in attributes and attributes["label_ids"] is not None:
        updated.label_ids = check_labels(repositories, context.workspace_id, issue.team_id, attributes["label_ids"])
    if "assignee_id" in attributes:
        updated.assignee_id = check_assignee(
            repositories, context.workspace_id, issue.team_id, resolve_me(context, attributes["assignee_id"])
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


def store_patch(
    repositories: Repositories,
    context: AuthzContext,
    issue: Issue,
    updated: Issue,
    *,
    triage_outcome: str = "accepted",
    condition: Any = None,
) -> Issue:
    """Write a patched issue and its activity rows, or leave it alone if nothing moved.

    A moved manual position is written but records no activity: dragging a row is
    arrangement rather than a change to the issue, and a history full of reorders
    would bury the edits a reader is looking for. An issue leaving triage records
    `triage_outcome`. `condition` makes the write depend on the stored row as
    well. Raises the 404 when the issue was deleted after it was read, or when the
    stored row no longer meets `condition`.
    """
    changes = changed_fields(issue, updated, PATCHABLE_FIELDS)
    left_triage = issue.in_triage and not updated.in_triage
    if left_triage:
        changes.append(("triage", "pending", triage_outcome))
    if not changes and issue.sort_order == updated.sort_order:
        return issue

    apply_sla(repositories, issue, updated)
    updated.updated_at = utc_now()
    updated.updated_by = context.user_id
    updated.updated_source = context.source
    try:
        stored = repositories.issues.replace(updated, condition=condition)
    except IssueWriteConflict as exc:
        raise issue_changed() from exc
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
                    source=context.source,
                )
                for field, before, after in changes
            ]
        )
    if issue.parent_id != stored.parent_id:
        repositories.activity.record_many(
            child_activity(
                repositories,
                context.workspace_id,
                context.user_id,
                stored,
                issue.parent_id,
                stored.parent_id,
                context.source,
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


def expected_estimate(raw: Optional[str]) -> tuple[bool, Optional[str]]:
    """`only_if_estimate` as whether it is set and the estimate it expects, `none` read as unset."""
    if raw is None or not raw.strip():
        return False, None
    if raw.strip().lower() == NONE:
        return True, None
    return True, estimate_value(raw)


def estimate_condition(stored: Optional[str]) -> Any:
    """The write condition that holds only while the estimate is still the `stored` one read.

    An unset estimate is stored as a null, an empty string or not at all, so all three read as unestimated.
    """
    if is_unestimated(stored):
        return Attr("estimate").not_exists() | Attr("estimate").attribute_type("NULL") | Attr("estimate").eq("")
    return Attr("estimate").eq(stored)


def bulk_update_issues(
    repositories: Repositories, context: AuthzContext, payload: IssueBulkUpdate
) -> tuple[list[Issue], list[str]]:
    """Apply one partial patch to up to `BULK_MAX_ISSUES` issues, answering the written and the skipped.

    All or nothing on validation: every issue is loaded, authorized and has the
    patch applied in memory before any is written, so an invisible issue (404), a
    team the caller cannot write in (403) or a value one issue's team refuses (422)
    fails the whole request with nothing changed. Each issue then goes through the
    same write and activity path a single patch does, so history cannot tell a bulk
    edit from one issue edited at a time. `archived` then archives or restores each
    issue through the single-issue archive path, with the same team membership rule.
    An issue deleted between validation and its write is skipped rather than failing
    the rest. With `only_if_estimate`, an issue whose estimate is not that value is
    skipped too, both on the read and through a condition on its write, and so is
    one another writer changed after it was read, since its estimate may have moved.
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

    guarded, expected = expected_estimate(payload.only_if_estimate)
    skipped: list[str] = []
    if guarded:
        skipped = [issue.issue_id for issue in issues if estimate_value(issue.estimate) != expected]
        issues = [issue for issue in issues if estimate_value(issue.estimate) == expected]

    patch = payload.patch
    shared = patch.model_dump(exclude_unset=True, exclude={"add_label_ids", "remove_label_ids", "archived"})
    planned: list[tuple[Issue, Issue]] = []
    palettes: dict[str, list[Label]] = {}
    for issue in issues:
        attributes = dict(shared)
        if patch.add_label_ids or patch.remove_label_ids:
            removed = set(patch.remove_label_ids)
            kept = [label for label in issue.label_ids if label not in removed]
            if issue.team_id not in palettes:
                palettes[issue.team_id] = repositories.team_config.list_labels(context.workspace_id, issue.team_id)
            attributes["label_ids"] = replace_group_siblings(palettes[issue.team_id], kept, patch.add_label_ids)
        planned.append((issue, apply_patch(repositories, context, issue, attributes)))

    stored: list[Issue] = []
    for issue, updated in planned:
        try:
            condition = estimate_condition(issue.estimate) if guarded else None
            written = store_patch(repositories, context, issue, updated, condition=condition)
            if patch.archived is True:
                written = archive_issue(repositories, context, written)
            elif patch.archived is False:
                written = unarchive_issue(repositories, context, written)
            stored.append(written)
        except HTTPException as exc:
            if exc.status_code != status.HTTP_404_NOT_FOUND and not (
                guarded and exc.status_code == status.HTTP_409_CONFLICT
            ):
                raise
            skipped.append(issue.issue_id)
    return stored, skipped
