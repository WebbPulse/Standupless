"""The issue list, create, patch and bulk patch paths, shared by the issue routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and an agent creating or patching an issue must leave exactly the rows a
person's request leaves: the same key allocation, validation, activity and
subscriptions. Every function raises the routes' `HTTPException`s, which the MCP
transport maps to tool errors.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Callable, Collection, Mapping, Optional

from boto3.dynamodb.conditions import Attr
from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed, encode_start_key

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import digest_scope, merge_sorted, resume_key
from app.common.api.schemas.issues import IssueBulkUpdate, IssueCreate
from app.common.customer_index import CustomerIndex, require_customer_list_reader
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
from app.common.db.dynamo.planning import Project
from app.common.db.dynamo.team_config import STATUS_CATEGORIES, Label
from app.common.db.dynamo.team_templates import IssueTemplate
from app.common.estimates import estimate_points, is_unestimated
from app.common.filter_resolution import resolve_issue_filter
from app.common.issue_archive import archive_issue, unarchive_issue
from app.common.issue_descriptions import get_description_version, record_description_version, seal_latest_version
from app.common.issue_filters import ME, NONE, IssueFilter, estimate_value
from app.common.issue_keyed_reads import keyed_rows
from app.common.issue_keys import current_all
from app.common.issue_mentions import record_issue_mentions
from app.common.issue_rules import (
    TRIAGE_STATUS_ID,
    changed_fields,
    check_assignee,
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
    require_triage_on,
    resolve_cycle,
    status_categories,
    subscribe_touched,
    unprocessable,
)
from app.common.issue_templates import apply_template, blueprint_values, chosen_sub_issues
from app.common.labels import replace_group_siblings
from app.common.mentions import mentioned_user_ids
from app.common.relation_effects import child_activity
from app.common.sla import apply_sla, sla_breach_key
from app.common.sub_teams import listed_teams
from app.common.triage_duty import duty_assignee, require_priority

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


StatusRanks = dict[tuple[str, str], tuple[int, int]]
"""Each `(team_id, status_id)` mapped to where that status sits on its team's board."""

TRIAGE_RANK: tuple[int, int] = (-1, 0)
"""Where an issue waiting in triage sorts by status: ahead of every real status, as its group leads."""

ASCENDING_SORTS: frozenset[str] = frozenset({"key_asc", "due_asc", "sla_asc", "manual", "status_asc", "start_asc"})
"""The sorts that climb; every other one reads highest or newest first."""

NEVER: datetime = datetime.min.replace(tzinfo=UTC)
"""The moment an unset timestamp sorts at, below every real one."""


def status_ranks(repositories: Repositories, workspace_id: str, teams: list[str]) -> StatusRanks:
    """Every listed team's statuses mapped to their board place: category first, then position.

    Read only for the status sort, since no other sort needs a team's statuses.
    """
    ranks: StatusRanks = {}
    for team in teams:
        for row in repositories.team_config.list_statuses(workspace_id, team):
            known = row.category in STATUS_CATEGORIES
            category = STATUS_CATEGORIES.index(row.category) if known else len(STATUS_CATEGORIES)
            ranks[(team, row.status_id)] = (category, row.position)
    return ranks


def status_rank(issue: Issue, ranks: StatusRanks) -> tuple[int, int]:
    """Where one issue's status sits on its board, triage first and a vanished status last."""
    if issue.in_triage:
        return TRIAGE_RANK
    return ranks.get((issue.team_id, issue.status_id), (len(STATUS_CATEGORIES), 0))


def sort_key(sort: str, ranks: Optional[StatusRanks] = None, customers: Optional[CustomerIndex] = None) -> Any:
    """The key one sort orders a merged fan-out by.

    Written as one function so the merge and the fallback ordering inside a single
    team's page cannot disagree about what a sort means. `ranks` carries the board
    order the status sort climbs, and every status ties without it. `customers`
    carries the request counts and revenue the customer sorts read, and every
    issue ties at zero without it.
    """
    if sort == "customer_requests_desc":
        held = customers or CustomerIndex()
        return lambda issue: (held.request_count("issue", issue.issue_id), issue.updated_at, issue.issue_id)
    if sort == "customer_important_desc":
        held = customers or CustomerIndex()
        return lambda issue: (held.important_count("issue", issue.issue_id), issue.updated_at, issue.issue_id)
    if sort == "customer_revenue_desc":
        held = customers or CustomerIndex()
        return lambda issue: (held.revenue_of("issue", issue.issue_id), issue.updated_at, issue.issue_id)
    if sort == "created_desc":
        return lambda issue: (issue.created_at, issue.issue_id)
    if sort == "key_asc":
        return lambda issue: (issue.team_id, issue.number)
    if sort == "priority_desc":
        return lambda issue: (-PRIORITY_ORDER.get(issue.priority, 4), issue.created_at, issue.issue_id)
    if sort == "due_asc":
        return lambda issue: (issue.due_date is None, issue.due_date or "", issue.issue_id)
    if sort == "sla_asc":
        return sla_breach_key
    if sort == "manual":
        return lambda issue: (issue.sort_order is None, issue.sort_order or "", issue.issue_id)
    if sort == "status_asc":
        held = ranks or {}
        return lambda issue: (status_rank(issue, held), PRIORITY_ORDER.get(issue.priority, 4), issue.issue_id)
    if sort == "start_asc":
        return lambda issue: (issue.start_date is None, issue.start_date or "", issue.issue_id)
    if sort == "estimate_desc":
        return lambda issue: (
            not is_unestimated(issue.estimate),
            estimate_points(issue.estimate),
            issue.issue_id,
        )
    if sort == "completed_desc":
        return lambda issue: (issue.completed_at is not None, issue.completed_at or NEVER, issue.issue_id)
    return lambda issue: (issue.updated_at, issue.issue_id)


def descending(sort: str) -> bool:
    """Whether one sort reads newest or highest first.

    The sorts in `ASCENDING_SORTS` climb; the rest descend, which is what their
    names say. A manual order climbs so the smallest key is the top of the list,
    and an issue nobody has placed yet sorts after every placed one.
    """
    return sort not in ASCENDING_SORTS


def unset_value(sort: str, customers: Optional[CustomerIndex] = None) -> Optional[Callable[[Issue], bool]]:
    """Whether an issue lacks the value one sort reads, or `None` for a sort over a value every issue has.

    A reversed sort still lists those issues last, the way a list reads in either
    direction, so they are held apart from the reversal. An issue no customer asked
    for has no value under either customer sort.
    """
    if sort == "customer_requests_desc":
        held = customers or CustomerIndex()
        return lambda issue: held.request_count("issue", issue.issue_id) == 0
    if sort == "customer_important_desc":
        held = customers or CustomerIndex()
        return lambda issue: held.important_count("issue", issue.issue_id) == 0
    if sort == "customer_revenue_desc":
        held = customers or CustomerIndex()
        return lambda issue: held.revenue_of("issue", issue.issue_id) == 0
    if sort == "due_asc":
        return lambda issue: issue.due_date is None
    if sort == "sla_asc":
        return lambda issue: sla_breach_key(issue)[0]
    if sort == "manual":
        return lambda issue: issue.sort_order is None
    if sort == "start_asc":
        return lambda issue: issue.start_date is None
    if sort == "estimate_desc":
        return lambda issue: is_unestimated(issue.estimate)
    if sort == "completed_desc":
        return lambda issue: issue.completed_at is None
    return None


def order_issues(
    rows: list[Issue],
    sort: str,
    *,
    reverse: bool = False,
    ranks: Optional[StatusRanks] = None,
    customers: Optional[CustomerIndex] = None,
) -> list[Issue]:
    """Rows in one sort's order, or its reverse with issues lacking the sorted value still last."""
    ordered = merge_sorted(rows, sort_key(sort, ranks, customers), descending=descending(sort) != reverse)
    missing = unset_value(sort, customers) if reverse else None
    if missing is None:
        return ordered
    return [issue for issue in ordered if not missing(issue)] + [issue for issue in ordered if missing(issue)]


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
    reverse: bool = False,
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
    rolls the named team's visible sub-teams into the list, and `reverse` turns the
    sort around, issues lacking the sorted value still last. With no team named,
    retired teams are left out unless the team filter asks for one.
    """
    teams = listed_teams(
        repositories, context, team_id, include_sub_teams=include_sub_teams, named=wanted.named_team_ids
    )

    if not teams:
        return [], None

    require_customer_list_reader(context, wanted.needs_customers, sort)
    wanted = resolve_issue_filter(repositories, context.workspace_id, teams, wanted, sort=sort)
    categories: dict[str, str] = {}
    if wanted.needs_categories:
        for candidate in teams:
            categories.update(status_categories(repositories, context.workspace_id, candidate))

    mode = "subscribed" if subscribed else "all"
    direction = "reverse" if reverse else "forward"
    scope = digest_scope(
        f"issues:{context.workspace_id}:{','.join(teams)}:{sort}:{direction}:{mode}:{wanted.fingerprint()}"
    )
    ranks = status_ranks(repositories, context.workspace_id, teams) if sort == "status_asc" else None
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
        key=sort_key(sort, ranks, wanted.customer_index),
        descending=descending(sort) != reverse,
        rows=keyed,
        last=unset_value(sort, wanted.customer_index) if reverse else None,
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
    last: Optional[Callable[[Issue], bool]] = None,
) -> tuple[list[Issue], Optional[str]]:
    """One page of the issues `keep` admits, in `key` order, and the next cursor.

    The cursor holds where the current stretch of the team walk started and how far
    into its sorted matches the caller got. When the stretch is used up and the
    budget had stopped the walk, the next cursor starts the following stretch, so
    a page can come back short or empty while a cursor is still answered. `rows`
    stands in for the walk when an index other than the team one already holds
    every candidate. `last` holds the rows it admits after every other row, in
    their order, so a reversed sort still lists issues lacking its value last.
    """
    position = resume_key(cursor, scope) or {}
    start = (_position(position, "t"), _position(position, "b"))
    offset = _position(position, "o")
    end: Optional[tuple[int, int]] = None
    if rows is None:
        rows, end = walk_teams(repositories, workspace_id, teams, start, budget or TEAM_SCAN_BUDGET)
    ordered = merge_sorted([issue for issue in rows if keep(issue)], key, descending=descending)
    if last is not None:
        ordered = [issue for issue in ordered if not last(issue)] + [issue for issue in ordered if last(issue)]
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


@dataclass(frozen=True)
class FreshRows:
    """Rows the same request wrote moments ago, which an eventually consistent read may not see yet.

    A caller that has just written a project, its milestones or a parent issue
    names them here, so `create_issue` checks against the rows as written rather
    than reading them back. `milestones` maps a project id to its milestone ids,
    and `issues` maps an issue id to the issue.
    """

    project: Optional[Project] = None
    milestones: Mapping[str, Collection[str]] = field(default_factory=dict)
    issues: Mapping[str, Issue] = field(default_factory=dict)


def create_issue(
    repositories: Repositories, context: AuthzContext, payload: IssueCreate, *, fresh: Optional[FreshRows] = None
) -> Issue:
    """Create an issue and the sub-issues its template adds, answering the issue."""
    return create_issue_tree(repositories, context, payload, fresh=fresh)[0]


def create_issue_tree(
    repositories: Repositories, context: AuthzContext, payload: IssueCreate, *, fresh: Optional[FreshRows] = None
) -> tuple[Issue, list[Issue]]:
    """Create an issue and the sub-issues its template adds, all of them or none.

    The sub-issues the create keeps are made under the new issue in the
    template's order, in its project, milestone and cycle. Sub-issues are one
    level deep, so a create that names a parent and keeps any is refused before
    anything is written. When one of them fails, every row this create wrote is
    removed and the 422 names the sub-issue, so a parent is never left half
    built. An issue landing in triage then runs its team's triage rules.
    """
    fresh = fresh or FreshRows()
    issue, template, filled = _create_one(repositories, context, payload, fresh)
    created: list[Issue] = []
    try:
        team = repositories.teams.get(context.workspace_id, issue.team_id)
        if team is None:
            raise not_found()
        for item in chosen_sub_issues(template, filled):
            child = IssueCreate.model_validate(
                {
                    **blueprint_values(repositories, context.workspace_id, team, item),
                    "team_id": issue.team_id,
                    "parent_id": issue.issue_id,
                    "project_id": issue.project_id,
                    "project_milestone_id": issue.project_milestone_id,
                    "cycle_id": issue.cycle_id,
                }
            )
            known = FreshRows(
                project=fresh.project, milestones=fresh.milestones, issues={**fresh.issues, issue.issue_id: issue}
            )
            try:
                created.append(_create_one(repositories, context, child, known)[0])
            except HTTPException as exc:
                raise unprocessable(
                    f"Could not create the sub-issue {item.title}: {_reason(exc)}. Nothing was created."
                ) from exc
    except BaseException:
        for row in [*reversed(created), issue]:
            _remove_new_issue(repositories, context, row)
        raise
    if issue.in_triage:
        from app.common.triage_rules import issue_origin, run_triage_rules

        origin = issue_origin(context, from_form=bool(template is not None and template.form_fields))
        return run_triage_rules(repositories, context, issue, origin=origin, children=created)
    return issue, created


def _reason(exc: HTTPException) -> str:
    """The message an `HTTPException` carried, without its trailing full stop."""
    detail: Any = exc.detail
    message = detail.get("message") if isinstance(detail, dict) else None
    return (message if isinstance(message, str) else str(detail)).rstrip(".")


def _remove_new_issue(repositories: Repositories, context: AuthzContext, issue: Issue) -> None:
    """Remove an issue this request just wrote, with its history and subscriptions, leaving a tombstone."""
    workspace_id = context.workspace_id
    repositories.activity.delete_for_issue(workspace_id, issue.issue_id)
    repositories.subscriptions.delete_for_issue(workspace_id, issue.issue_id)
    repositories.issues.delete(workspace_id, issue.issue_id)
    repositories.activity.record_tombstone(workspace_id, issue.team_id, issue.issue_id, context.user_id)


def _create_one(
    repositories: Repositories, context: AuthzContext, payload: IssueCreate, fresh: FreshRows
) -> tuple[Issue, Optional[IssueTemplate], IssueCreate]:
    """Create one issue, allocating its key from the team's counter, and answer the template and the filled create.

    A named template fills the fields the payload leaves out before anything is
    validated, so a template's rows are held to the same checks as typed ones.
    The counter is allocated after every validation has passed, because a number
    is consumed whether or not the write lands and the contract accepts gaps but not
    wasted ones. `fresh` names rows this request has just written, so a project,
    milestone or parent created a moment ago is not refused for read lag. An
    unassigned issue landing in a triage inbox whose team assigns its duty goes
    to the member on duty.
    """
    require_team_member(repositories, context, payload.team_id)
    team = repositories.teams.get(context.workspace_id, payload.team_id)
    if team is None:
        raise not_found()
    payload, template = apply_template(repositories, context, payload)
    if chosen_sub_issues(template, payload) and payload.parent_id:
        raise unprocessable("Sub-issues are one level deep, so a sub-issue cannot add its template's sub-issues")

    requested_triage = payload.triage
    status_ref = payload.status_id
    if status_ref == TRIAGE_STATUS_ID:
        require_triage_on(repositories, context.workspace_id, payload.team_id)
        requested_triage = True
        status_ref = None
    if status_ref:
        chosen = check_status(repositories, context.workspace_id, payload.team_id, status_ref)
    else:
        chosen = default_status(repositories, context.workspace_id, payload.team_id)

    estimate = check_estimate(payload.estimate, team)
    label_ids = check_labels(repositories, context.workspace_id, payload.team_id, payload.label_ids)
    assignee_id = check_assignee(
        repositories, context.workspace_id, payload.team_id, resolve_me(context, payload.assignee_id)
    )
    issue_id = new_issue_id()
    parent_id = check_parent(
        repositories, context.workspace_id, payload.team_id, issue_id, payload.parent_id, known=fresh.issues
    )

    cycle_id = resolve_cycle(repositories, context.workspace_id, payload.team_id, payload.cycle_id)
    project_id = check_project(
        repositories, context.workspace_id, payload.team_id, payload.project_id, known=fresh.project
    )
    project_milestone_id = check_project_milestone(
        repositories, context.workspace_id, project_id, payload.project_milestone_id, known=fresh.milestones
    )

    mentions = mentioned_user_ids(repositories, context.workspace_id, payload.body)
    in_triage = lands_in_triage(
        repositories,
        context,
        payload.team_id,
        requested_triage,
        status_named=bool(status_ref),
        has_parent=parent_id is not None,
    )
    if in_triage and assignee_id is None:
        assignee_id = duty_assignee(repositories, context.workspace_id, payload.team_id)
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
    record_description_version(repositories, context, None, created)
    record_issue_mentions(repositories, context, created, None, created.body, place="description")
    return created, template, payload


def update_issue(repositories: Repositories, context: AuthzContext, issue: Issue, attributes: dict[str, Any]) -> Issue:
    """Patch one visible issue the caller may write in, recording activity per moved field.

    The single-issue patch both the route and the MCP tools run: the write check,
    then `apply_patch` and `store_patch`. An empty patch answers the issue untouched.
    """
    require_team_member(repositories, context, issue.team_id)
    if not attributes:
        return issue
    return store_patch(repositories, context, issue, apply_patch(repositories, context, issue, attributes))


def restore_description(repositories: Repositories, context: AuthzContext, issue: Issue, version_id: str) -> Issue:
    """Put one earlier version of a visible issue's description back as its current text.

    Runs the ordinary patch, so the caller needs write rights in the team and the
    restore records a body change in the history and a version of its own.
    """
    version = get_description_version(repositories, issue, version_id)
    require_team_member(repositories, context, issue.team_id)
    seal_latest_version(repositories, issue)
    return update_issue(repositories, context, issue, {"body": version.body})


def apply_patch(
    repositories: Repositories,
    context: AuthzContext,
    issue: Issue,
    attributes: dict[str, Any],
    *,
    accepting: bool = True,
) -> Issue:
    """The issue as a patch would leave it, validated against its own team, unsaved.

    Shared by the single and the bulk patch so both refuse the same values for the
    same reasons, and split from the write so a bulk patch can validate every
    issue before it stores any. The synthetic triage status sends the issue to its
    team's triage inbox, keeping its hidden status. A real status named by anyone
    but a guest takes an issue out of triage, as accepting it would, even when it
    names the hidden status the issue already holds.

    An unassigned issue sent back to triage is assigned to the member on duty
    when its team assigns triage duty. An issue taken out of triage into
    anything but a cancelled status counts as accepted unless `accepting` says
    otherwise, as a decline or a duplicate does, and so must have a priority
    when its team requires one.
    """
    updated = issue.model_copy(deep=True)
    leaving_into: Optional[str] = None
    if attributes.get("status_id") == TRIAGE_STATUS_ID:
        if not issue.in_triage:
            require_triage_on(repositories, context.workspace_id, issue.team_id)
            updated.in_triage = True
            updated.snoozed_until = None
    elif "status_id" in attributes and attributes["status_id"] is not None:
        chosen = check_status(repositories, context.workspace_id, issue.team_id, attributes["status_id"])
        updated.status_id = chosen.status_id
        if issue.in_triage and not context.is_guest:
            updated.in_triage = False
            updated.snoozed_until = None
            leaving_into = chosen.category
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
        updated.cycle_id = resolve_cycle(repositories, context.workspace_id, issue.team_id, attributes["cycle_id"])
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
    if updated.in_triage and not issue.in_triage and updated.assignee_id is None:
        updated.assignee_id = duty_assignee(repositories, context.workspace_id, issue.team_id)
    if accepting and leaving_into is not None and leaving_into != "cancelled":
        require_priority(repositories, context.workspace_id, issue.team_id, updated.priority)
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
    `triage_outcome`, and one sent back records `pending`. `condition` makes the
    write depend on the stored row as well. Raises the 404 when the issue was
    deleted after it was read, or when the stored row no longer meets `condition`.
    An issue sent back to triage runs its team's triage rules.
    """
    changes = changed_fields(issue, updated, PATCHABLE_FIELDS)
    if issue.in_triage and not updated.in_triage:
        changes.append(("triage", "pending", triage_outcome))
    elif updated.in_triage and not issue.in_triage:
        changes.append(("triage", None, "pending"))
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
    if issue.body != stored.body:
        record_description_version(repositories, context, issue, stored)
        record_issue_mentions(repositories, context, stored, issue.body, stored.body, place="description")
    if stored.in_triage and not issue.in_triage:
        from app.common.triage_rules import run_triage_rules

        return run_triage_rules(repositories, context, stored)[0]
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
