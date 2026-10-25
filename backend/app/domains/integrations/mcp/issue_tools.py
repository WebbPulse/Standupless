"""The MCP tools that read and write issues, their comments and their relations.

Every write goes through the same `app.common` paths the issue and comment routes
run, so an agent's issue carries the same key allocation, validation, activity rows
and subscriptions as a person's, and a field the route refuses the tool refuses
too. There is no MCP-shaped write path, which is what keeps the two from drifting.

There is no tool that deletes an issue or a comment: an agent that can create and
update but never destroy history is a different risk from one that can do both.
Removing a relation is offered, marked destructive, because the link is all it loses.
"""

from __future__ import annotations

import logging
import re
from typing import Any, cast, get_args

from app.common.api.pagination import digest_scope
from app.common.api.schemas.insights import INSIGHT_DIMENSIONS, INSIGHT_MEASURES
from app.common.api.schemas.issues import (
    BULK_MAX_ISSUES,
    ActivityRead,
    IssueBulkUpdate,
    IssueCreate,
    IssueUpdate,
    LinkCreate,
    LinkRead,
    SortField,
    SubscribersRead,
)
from app.common.change_source import CHANGE_SOURCES
from app.common.comment_anchors import ANCHOR_QUOTE_MAX, anchor_from_quote
from app.common.comment_drafts import clear_posted_draft
from app.common.comment_writes import comment_page, create_comment
from app.common.customer_index import require_customer_list_reader
from app.common.cycle_schedule import RELATIVE_CYCLES
from app.common.db.dynamo.comments import Comment
from app.common.db.dynamo.github import IssueLink
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.relations import INVERSE_TYPES
from app.common.filter_resolution import resolve_issue_filter
from app.common.insights import insights_for
from app.common.issue_activity import activity_page
from app.common.issue_archive import archive_issue, unarchive_issue
from app.common.issue_conversion import duplicate_issue
from app.common.issue_filters import UnknownStatusCategory, build_issue_filter, subscribed_by_caller
from app.common.issue_keys import current
from app.common.issue_links import create_link, delete_link, list_links
from app.common.issue_move import move_issue
from app.common.issue_parents import parents_of
from app.common.issue_rules import TRIAGE_STATUS_ID, TRIAGE_STATUS_NAME, require_team_reader, visible_team_ids
from app.common.issue_subscribers import list_subscribers, subscribe, unsubscribe
from app.common.issue_writes import (
    bulk_update_issues,
    create_issue,
    descending,
    list_issues,
    sort_key,
    status_ranks,
    unset_value,
    update_issue,
    walk_page,
)
from app.common.similar_issues import find_similar
from app.common.thread_resolution import resolve_thread, unresolve_thread
from app.domains.integrations import pr_status, thread_sync
from app.domains.integrations.mcp.team_tools import boolean
from app.domains.integrations.mcp.template_tools import template_ref
from app.domains.integrations.mcp.toolkit import (
    PRIORITIES,
    Tool,
    ToolCall,
    enum,
    filter_values,
    issue_by_key,
    issue_id_ref,
    issue_json,
    issue_ref,
    limit,
    nullable,
    object_schema,
    one_or_many,
    page_properties,
    resolve_user,
    string,
    string_list,
    summary_json,
    team_id_ref,
    user_ref,
)
from app.domains.integrations.mcp.transport import ToolError
from app.domains.integrations.service import link_reads

_log = logging.getLogger(__name__)

ULID_PATTERN = re.compile(r"^[0-9A-Z]{26}$")
"""A row id's shape, so an id the team does not list passes to the write path to be answered there."""

SORTS: tuple[str, ...] = get_args(SortField)

SORT_HELP = (
    "The order, defaulting to updated_desc; sla_asc puts the soonest SLA breach first "
    "and issues without a running SLA last; status_asc follows the board's status order, "
    "start_asc the earliest start date and estimate_desc the largest estimate; "
    "customer_requests_desc puts the most customer requests first and customer_revenue_desc "
    "the highest summed revenue of the customers asking; completed_desc puts the latest completed_at "
    "first and issues not completed last"
)

REVERSE_HELP = "Turn the sort around, issues without the sorted value still last, default false"

LINK_TYPES: tuple[str, ...] = ("blocks", "blocked_by", "relates_to", "duplicate_of")

STORED_LINK_TYPES: tuple[str, ...] = tuple(INVERSE_TYPES)
"""Every type a stored link row can carry, `duplicated_by` included, as a listing shows them."""

BULK_CLEARABLE: tuple[str, ...] = (
    "assignee_id",
    "project_id",
    "project_milestone_id",
    "cycle_id",
    "estimate",
    "parent_id",
)
"""The bulk patch fields an explicit null clears."""

NULLABLE_FIELDS: tuple[str, ...] = (
    "body",
    "assignee_id",
    "estimate",
    "start_date",
    "due_date",
    "parent_id",
    "cycle_id",
    "project_id",
    "project_milestone_id",
)
"""The patchable fields an explicit null clears."""

PLAIN_FIELDS: tuple[str, ...] = ("title", "status_id", "priority", "label_ids")
"""The patchable fields a null leaves alone, because the row cannot hold one."""


def _status_name(call: ToolCall, issue: Issue) -> str:
    """The display name of one issue's status, or empty when it has been deleted."""
    row = call.repositories.team_config.get_status(call.context.workspace_id, issue.team_id, issue.status_id)
    return row.name if row is not None else ""


def _answer(call: ToolCall, issue: Issue) -> dict[str, Any]:
    """One written or read issue as the tools answer it, under its current key."""
    return issue_json(call.repositories.teams, issue, status_name=_status_name(call, issue))


FILTER_ARGUMENTS: tuple[str, ...] = (
    "status_id",
    "status_id_not",
    "status_category",
    "status_category_not",
    "assignee_id",
    "assignee_id_not",
    "label_id",
    "label_id_not",
    "priority",
    "parent_id",
    "project_id",
    "project_milestone_id",
    "cycle_id",
    "estimate",
    "estimate_not",
    "sla_status",
    "has_relation",
    "team_id_in",
    "team_id_not",
    "creator_id",
    "creator_id_not",
    "subscriber_id",
    "subscriber_id_not",
    "label_id_all",
    "priority_not",
    "parent_id_not",
    "project_id_not",
    "project_milestone_id_not",
    "cycle_id_not",
    "customer_id",
    "customer_id_not",
)
"""The issue list filter arguments the tools take, by the HTTP list's query parameter names."""

BOOLEAN_FILTER_ARGUMENTS: tuple[str, ...] = ("is_blocked", "is_blocking", "has_sub_issues")
"""The filter arguments taken as booleans and passed through as sent, for the filter to check."""

SCALAR_FILTER_ARGUMENTS: tuple[str, ...] = (
    "due_before",
    "due_after",
    "created_after",
    "created_before",
    "updated_after",
    "updated_before",
    "completed_after",
    "completed_before",
    "content",
    "content_not",
    "match",
)
"""The filter arguments taken once as text, passed through for the filter to check."""

PARENT_ARGUMENTS: tuple[str, ...] = ("parent_id", "parent_id_not")
"""The filter arguments naming issues, where an issue key is resolved to its id."""


def _filter_properties(*, with_assignee: bool = True) -> dict[str, Any]:
    """The issue list filters, spelled as the HTTP list's query parameters are."""
    properties: dict[str, Any] = {
        "team_id": string("Narrow to one team"),
        "status_id": one_or_many("Any of these statuses; 'triage' is issues awaiting triage"),
        "status_id_not": one_or_many("None of these statuses; 'triage' leaves out issues awaiting triage"),
        "status_category": one_or_many("Any of these categories: backlog, unstarted, started, completed, cancelled"),
        "status_category_not": one_or_many("None of these categories, as a list or comma separated"),
        "label_id": one_or_many("Carrying any of these labels; 'none' is unlabelled"),
        "label_id_not": one_or_many("Carrying none of these labels"),
        "priority": one_or_many("Any of these priorities: none, urgent, high, medium, low"),
        "parent_id": one_or_many("Children of any of these issues, by id or key; 'none' is top level issues"),
        "project_id": one_or_many("In any of these projects; 'none' is no project"),
        "project_milestone_id": one_or_many("In any of these project milestones; 'none' is no milestone"),
        "cycle_id": one_or_many(
            "In any of these cycles; 'none' is no cycle, and current, next or previous follow each team's schedule"
        ),
        "estimate": one_or_many("Any of these estimates, such as M or 3; 'none' is unestimated"),
        "estimate_not": one_or_many("None of these estimates; 'none' leaves out unestimated issues"),
        "sla_status": one_or_many("Any of these SLA states: none, on_track, at_risk, breached"),
        "is_blocked": {
            "type": "boolean",
            "description": "True for issues an open blocker holds up, false for the rest",
        },
        "is_blocking": {
            "type": "boolean",
            "description": "True for open issues that block an open issue, false for the rest",
        },
        "has_relation": one_or_many(
            "Holding a link of any of these types: blocks, blocked_by, relates_to, duplicate_of"
        ),
        "team_id_in": one_or_many("In any of these teams, among the teams the list already covers"),
        "team_id_not": one_or_many("In none of these teams"),
        "creator_id": one_or_many("Created by any of these people; 'me' is the caller"),
        "creator_id_not": one_or_many("Created by none of these people"),
        "subscriber_id": one_or_many("Subscribed to by any of these people; 'me' is the caller"),
        "subscriber_id_not": one_or_many("Subscribed to by none of these people"),
        "label_id_all": one_or_many("Carrying every one of these labels"),
        "priority_not": one_or_many("None of these priorities"),
        "parent_id_not": one_or_many("Not a child of any of these issues, by id or key; 'none' is sub-issues only"),
        "has_sub_issues": {
            "type": "boolean",
            "description": "True for issues with at least one sub-issue, false for issues with none",
        },
        "project_id_not": one_or_many("In none of these projects"),
        "project_milestone_id_not": one_or_many("In none of these project milestones"),
        "cycle_id_not": one_or_many("In none of these cycles"),
        "customer_id": one_or_many("Requested by any of these customers; 'none' is issues no customer asked for"),
        "customer_id_not": one_or_many("Requested by none of these customers; 'none' keeps requested issues only"),
        "due_before": string("Due before this day, YYYY-MM-DD, exclusive"),
        "due_after": string("Due after this day, YYYY-MM-DD, exclusive"),
        "created_after": string("Created after this day, YYYY-MM-DD, exclusive"),
        "created_before": string("Created before this day, YYYY-MM-DD, exclusive"),
        "updated_after": string("Updated after this day, YYYY-MM-DD, exclusive"),
        "updated_before": string("Updated before this day, YYYY-MM-DD, exclusive"),
        "completed_after": string("Completed after this day, YYYY-MM-DD, exclusive; only completed issues match"),
        "completed_before": string("Completed before this day, YYYY-MM-DD, exclusive; only completed issues match"),
        "content": string("Title or description contains this text, case insensitive"),
        "content_not": string("Neither title nor description contains this text"),
        "match": enum(("all", "any"), "How the conditions combine: all of them (default) or any one"),
        "groups": {
            "type": "array",
            "maxItems": 10,
            "items": {"type": "object"},
            "description": (
                "Condition groups, each an object holding these same filter names plus its own match "
                "(all or any), and each counting as one condition. A group may hold groups of its own, "
                "two levels at most. Example: "
                '[{"match": "any", "label_id": "BUG_LABEL_ID", "priority": "urgent"}] keeps issues '
                "that carry the label or are urgent"
            ),
        },
    }
    if with_assignee:
        properties["assignee_id"] = one_or_many("Any of these assignees; 'me' is the caller, 'none' is unassigned")
        properties["assignee_id_not"] = one_or_many("None of these assignees")
    return properties


def _include_archived(call: ToolCall, default: bool) -> bool:
    """The `include_archived` argument as a boolean, refusing anything else."""
    value = call.optional("include_archived", default)
    if not isinstance(value, bool):
        raise ToolError("include_archived must be true or false")
    return value


def _parent_values(call: ToolCall, values: list[str] | None) -> list[str] | None:
    """The parent filter's values with any issue key resolved to its id.

    A key resolves the way `get_issue` resolves one, retired prefixes included,
    while an id and the `none` sentinel pass through unchanged.
    """
    if values is None:
        return None
    return [issue_by_key(call, value.strip()).issue_id if "-" in value else value for value in values]


def _filter_values(call: ToolCall) -> dict[str, Any]:
    """The filter arguments as the shared filter takes them, parent keys resolved to ids, groups included."""
    values: dict[str, Any] = {name: filter_values(call.optional(name)) for name in FILTER_ARGUMENTS}
    values.update({name: call.optional(name) for name in BOOLEAN_FILTER_ARGUMENTS})
    values.update({name: call.optional(name) for name in SCALAR_FILTER_ARGUMENTS})
    for name in PARENT_ARGUMENTS:
        values[name] = _parent_values(call, values[name])
    values["groups"] = _groups(call)
    return values


def _groups(call: ToolCall, raw: Any = None, *, top: bool = True) -> list[dict[str, Any]] | None:
    """The condition groups argument with each group's parent keys resolved to ids, nested groups included."""
    if top:
        raw = call.optional("groups")
    if raw is None:
        return None
    if not isinstance(raw, list) or not all(isinstance(group, dict) for group in raw):
        raise ToolError("groups must be a list of condition objects")
    resolved: list[dict[str, Any]] = []
    for group in raw:
        entry = dict(group)
        for name in PARENT_ARGUMENTS:
            if entry.get(name) is not None:
                entry[name] = _parent_values(call, filter_values(entry[name]))
        if entry.get("groups") is not None:
            entry["groups"] = _groups(call, entry["groups"], top=False)
        resolved.append(entry)
    return resolved


def _build_filter(call: ToolCall, *, include_archived: bool = False, **overrides: Any) -> Any:
    """The shared issue filter from a tool's arguments, as the HTTP list builds it.

    Archived issues are left out unless the caller asks for them, the list's own default.
    """
    values = _filter_values(call)
    values.update(overrides)
    values["include_archived"] = _include_archived(call, include_archived)
    try:
        return build_issue_filter(user_id=call.context.user_id, **values)
    except UnknownStatusCategory as exc:
        raise ToolError(str(exc)) from exc


def _sort(call: ToolCall) -> SortField:
    """The requested sort, or the list's default."""
    value = str(call.optional("sort", "updated_desc"))
    if value not in SORTS:
        raise ToolError(f"sort must be one of: {', '.join(SORTS)}")
    return cast(SortField, value)


def _reverse(call: ToolCall) -> bool:
    """Whether the caller asked for the sort turned around, refusing anything but a boolean."""
    value = call.optional("reverse", False)
    if not isinstance(value, bool):
        raise ToolError("reverse must be true or false")
    return value


def _page(call: ToolCall, **overrides: Any) -> dict[str, Any]:
    """One page of the issue list, through the same fan-out the HTTP list runs, each sub-issue naming its parent.

    "Subscribed by me" reads the caller's own subscription index, as the HTTP list does.
    """
    subscribed = subscribed_by_caller(call.optional("subscriber_id"), call.optional("match"), call.context.user_id)
    if subscribed:
        overrides = {**overrides, "subscriber_id": None}
    wanted = _build_filter(call, **overrides)
    team_id = call.optional("team_id")
    rows, next_cursor = list_issues(
        call.repositories,
        call.context,
        wanted,
        team_id=str(team_id) if team_id else None,
        sort=_sort(call),
        cursor=call.optional("cursor"),
        limit=limit(call.optional("limit")),
        include_sub_teams=call.optional("include_sub_teams", False) is True,
        reverse=_reverse(call),
        subscribed=subscribed,
    )
    parents = parents_of(call.repositories.issues, call.repositories.teams, call.context.workspace_id, rows)
    return {
        "issues": [summary_json(call.repositories.teams, row, parents.get(row.parent_id or "")) for row in rows],
        "next_cursor": next_cursor,
    }


def _list_issues(call: ToolCall) -> Any:
    """One page of the issues this credential can see, filtered and sorted."""
    query = call.optional("query")
    return _page(call, q=str(query) if query else None)


def _get_insights(call: ToolCall) -> Any:
    """A breakdown of the issues a team, a filter or a saved view selects, as the insights route answers it."""
    filters = _filter_values(call)
    subscriber_id = filters.pop("subscriber_id", None)
    filters["include_archived"] = _include_archived(call, False)
    team_id = call.optional("team_id")
    view_id = call.optional("view_id")
    segment_by = call.optional("segment_by")
    body = insights_for(
        call.repositories,
        call.context,
        team_id=str(team_id) if team_id else None,
        view_id=str(view_id) if view_id else None,
        subscriber_id=subscriber_id,
        group_by=str(call.optional("group_by", "status")),
        segment_by=str(segment_by) if segment_by else None,
        measure=str(call.optional("measure", "count")),
        filters=filters,
        include_sub_teams=call.optional("include_sub_teams", False) is True,
    )
    return body.model_dump(mode="json")


def _list_my_issues(call: ToolCall) -> Any:
    """One page of the issues assigned to the caller, filtered and sorted."""
    return _page(call, assignee_id=["me"], assignee_id_not=None)


def _search_issues(call: ToolCall) -> Any:
    """Issues whose key is a text or whose title or body contains it, in the sort's order, in visible teams only.

    A key matches whole and in any case, as Linear's search finds `ABC-12`; the
    rest is a substring over title and body, unlike `list_issues`, whose `query` is the
    HTTP list's key or title prefix. Filtered after the team read rather than
    through the search index, because the index is a separate table this domain
    holds no grant on. Each team is walked through every page up to the list's
    scan budget, and when the budget stops the walk `next_cursor` resumes it.
    Archived issues are found too unless `include_archived` is false, as the app's
    search finds them, and so are issues awaiting triage.
    """
    query = str(call.optional("query", "") or "").strip().lower()
    team_id = call.optional("team_id")
    sort = _sort(call)
    reverse = _reverse(call)
    wanted = _build_filter(call, include_archived=True, include_triage=True)

    if team_id:
        require_team_reader(call.repositories, call.context, str(team_id))
        teams = [str(team_id)]
    else:
        teams = visible_team_ids(call.repositories, call.context)

    require_customer_list_reader(call.context, wanted.needs_customers, sort)
    wanted = resolve_issue_filter(call.repositories, call.context.workspace_id, teams, wanted, sort=sort)
    categories: dict[str, str] = {}
    if wanted.needs_categories:
        for candidate in teams:
            for row in call.repositories.team_config.list_statuses(call.context.workspace_id, candidate):
                categories[row.status_id] = row.category

    def keep(issue: Issue) -> bool:
        """Whether one issue carries the key or holds the text, and passes the filters."""
        if (
            query
            and query != issue.key.lower()
            and query != current(call.repositories.teams, issue).key.lower()
            and query not in issue.title.lower()
            and query not in (issue.body or "").lower()
        ):
            return False
        return wanted.matches(issue, categories)

    workspace_id = call.context.workspace_id
    direction = "reverse" if reverse else "forward"
    scope = digest_scope(f"search:{workspace_id}:{','.join(teams)}:{query}:{sort}:{direction}:{wanted.fingerprint()}")
    ranks = status_ranks(call.repositories, workspace_id, teams) if sort == "status_asc" else None
    found, next_cursor = walk_page(
        call.repositories,
        workspace_id,
        teams,
        cursor=call.optional("cursor"),
        scope=scope,
        limit=limit(call.optional("limit")),
        keep=keep,
        key=sort_key(sort, ranks, wanted.customer_index),
        descending=descending(sort) != reverse,
        last=unset_value(sort, wanted.customer_index) if reverse else None,
    )
    return {"issues": [summary_json(call.repositories.teams, issue) for issue in found], "next_cursor": next_cursor}


PULL_REQUEST_LIMIT = 50
"""How many linked pull requests `get_issue` lists, the issue panel's own page size."""


def _pull_requests(call: ToolCall, issue: Issue) -> list[dict[str, Any]]:
    """The issue's linked pull requests with their review, check and stack state, as the API reads them."""
    page = call.repositories.github.list_links_for_issue(
        call.context.workspace_id, issue.issue_id, limit=PULL_REQUEST_LIMIT
    )
    links = [IssueLink.model_validate({**dict(row), "issue_key": issue.key}) for row in page.items]
    pr_status.request_reconcile(call.repositories, call.context.workspace_id, links)
    return [read.model_dump(mode="json") for read in link_reads(links)]


def _get_issue(call: ToolCall) -> Any:
    """One issue by its id or its key, with its linked pull requests and the stacks they form."""
    issue = issue_ref(call, call.require("issue_id"))
    answer = _answer(call, issue)
    answer["pull_requests"] = _pull_requests(call, current(call.repositories.teams, issue))
    return answer


def _possible_duplicates(call: ToolCall, issue: Issue) -> list[dict[str, Any]]:
    """Open issues in the caller's visible teams whose titles look like the new one's, its own team first.

    The same deterministic term match the create dialog shows, so an agent can
    notice a duplicate it just filed and relate or archive it. The issue's own
    parent is never answered, since a sub-issue shares its parent's terms by design,
    and sub-issues are one level deep so there is no further ancestor to leave out.
    """
    hits = find_similar(
        call.repositories,
        call.context,
        issue.title,
        exclude_issue_id=issue.issue_id,
        exclude_issue_ids=[issue.parent_id] if issue.parent_id else [],
        team_id=issue.team_id,
    )
    return [
        {
            "issue_id": hit.issue.issue_id,
            "issue_key": hit.issue.key,
            "title": hit.issue.title,
            "status": TRIAGE_STATUS_NAME if hit.issue.in_triage else hit.status.name if hit.status else "",
        }
        for hit in hits
    ]


def _create_issue(call: ToolCall) -> Any:
    """Create an issue through the route's own create path, naming any possible duplicates.

    A template fills every field the caller left out, so an argument sent always
    wins over the template's value, as it does in the create dialog. A form
    template holds `form_answers` to its questions, a missing required one included.
    """
    fields = (
        "team_id",
        "title",
        "body",
        "status_id",
        "priority",
        "label_ids",
        "estimate",
        "start_date",
        "due_date",
        "cycle_id",
        "project_id",
        "project_milestone_id",
    )
    payload: dict[str, Any] = {name: call.arguments[name] for name in fields if call.optional(name) is not None}
    if call.optional("assignee_id") is not None:
        payload["assignee_id"] = resolve_user(call, call.optional("assignee_id"))
    if call.optional("parent_id") is not None:
        payload["parent_id"] = issue_id_ref(call, call.optional("parent_id"))
    if call.optional("template_id") is not None:
        payload["template_id"] = template_ref(call, str(payload["team_id"]), call.optional("template_id")).template_id
    if call.optional("form_answers") is not None:
        payload["form_answers"] = call.arguments["form_answers"]
    if payload.get("status_id"):
        payload["status_id"] = _status_ref(call, str(payload["team_id"]), str(payload["status_id"]))
    if payload.get("label_ids"):
        payload["label_ids"] = _label_refs(call, str(payload["team_id"]), payload["label_ids"])
    created = create_issue(call.repositories, call.context, IssueCreate.model_validate(payload))
    return {**_answer(call, created), "possible_duplicates": _safe_duplicates(call, created)}


def _safe_duplicates(call: ToolCall, issue: Issue) -> list[dict[str, Any]]:
    """The possible duplicates of an issue already written, or none when the lookup fails.

    The issue exists by the time this runs, so a failed lookup must not turn the
    call into an error: an agent retrying on that error files the issue twice.
    """
    try:
        return _possible_duplicates(call, issue)
    except Exception:
        _log.exception("possible duplicate lookup failed", extra={"issue_id": issue.issue_id})
        return []


def _update_issue(call: ToolCall) -> Any:
    """Patch an issue through the route's own patch path.

    Only the arguments present are written. A null clears the fields that can be
    unset, such as the parent, cycle, project or assignee, and is ignored on the
    ones that cannot.
    """
    issue = issue_ref(call, call.require("issue_id"))
    patch: dict[str, Any] = {}
    for name in PLAIN_FIELDS:
        if call.optional(name) is not None:
            patch[name] = call.arguments[name]
    for name in NULLABLE_FIELDS:
        if call.present(name):
            patch[name] = call.arguments[name]
    if "assignee_id" in patch:
        patch["assignee_id"] = resolve_user(call, patch["assignee_id"])
    if "parent_id" in patch:
        patch["parent_id"] = issue_id_ref(call, patch["parent_id"])
    if patch.get("status_id"):
        patch["status_id"] = _status_ref(call, issue.team_id, str(patch["status_id"]))
    if patch.get("label_ids"):
        patch["label_ids"] = _label_refs(call, issue.team_id, patch["label_ids"])
    attributes = IssueUpdate.model_validate(patch).model_dump(exclude_unset=True)
    return _answer(call, update_issue(call.repositories, call.context, issue, attributes))


def _assign_issue(call: ToolCall) -> Any:
    """Assign or unassign an issue, a null assignee unassigning.

    The argument is required but nullable, because omitting it would be ambiguous
    between the two.
    """
    issue = issue_ref(call, call.require("issue_id"))
    assignee = resolve_user(call, call.arguments.get("assignee_id"))
    return _answer(call, update_issue(call.repositories, call.context, issue, {"assignee_id": assignee}))


def _archive_issue(call: ToolCall) -> Any:
    """Archive an issue through the route's own path, idempotently."""
    issue = issue_ref(call, call.require("issue_id"))
    return _answer(call, archive_issue(call.repositories, call.context, issue))


def _move_issue(call: ToolCall) -> Any:
    """Move an issue, and its sub-issues, to another team through the route's own path."""
    issue = issue_ref(call, call.require("issue_id"))
    return _answer(call, move_issue(call.repositories, call.context, issue, str(call.require("team_id"))))


def _duplicate_issue(call: ToolCall) -> Any:
    """Copy an issue into a new one in its team through the route's own path."""
    issue = issue_ref(call, call.require("issue_id"))
    return _answer(call, duplicate_issue(call.repositories, call.context, issue))


def _unarchive_issue(call: ToolCall) -> Any:
    """Restore an archived issue through the route's own path, idempotently."""
    issue = issue_ref(call, call.require("issue_id"))
    return _answer(call, unarchive_issue(call.repositories, call.context, issue))


def _comment_json(comment: Comment) -> dict[str, Any]:
    """One comment as the tools answer it."""
    return {
        "comment_id": comment.comment_id,
        "issue_id": comment.issue_id,
        "parent_comment_id": comment.parent_comment_id,
        "author_id": comment.author_id,
        "body": comment.body,
        "source": comment.source,
        "created_at": comment.created_at.isoformat(),
        "edited_at": comment.edited_at.isoformat() if comment.edited_at else None,
        "github_thread": comment.github_thread.model_dump(mode="json") if comment.github_thread else None,
        "resolution": comment.resolution.model_dump(mode="json") if comment.resolution else None,
        "anchor": comment.anchor.model_dump(mode="json") if comment.anchor else None,
    }


def _sync_root(call: ToolCall, issue: Issue, comment_id: str) -> Comment:
    """Sync one root comment's thread to the target `github_target` names, or the only one there is."""
    target = call.optional("github_target")
    return thread_sync.sync_thread(
        call.repositories, call.context, issue.issue_id, comment_id, reference=str(target) if target else None
    )


def _add_comment(call: ToolCall) -> Any:
    """Add a comment, or a reply to a top level comment, through the route's path.

    With `sync_to_github` the thread is synced too: a reply's thread before the
    reply is written, so the reply is posted, and a new thread once its root is.

    `quote` pins a new thread to the first place the description shows that text,
    with the context either side found here, so an agent names only the words.
    """
    issue = issue_ref(call, call.require("issue_id"))
    parent = call.optional("parent_comment_id")
    quote = call.optional("quote")
    anchor = None
    if quote is not None:
        if parent:
            raise ToolError("quote pins a new thread, so it cannot go on a reply")
        text = str(quote).strip()
        if not text or len(text) > ANCHOR_QUOTE_MAX:
            raise ToolError(f"quote must be between 1 and {ANCHOR_QUOTE_MAX} characters")
        anchor = anchor_from_quote(issue.body or "", text)
        if anchor is None:
            raise ToolError("quote must be text the issue description shows")
    sync = call.optional("sync_to_github") is True
    if sync and parent:
        _sync_root(call, issue, str(parent))
    created = create_comment(
        call.repositories,
        call.context,
        issue.issue_id,
        str(call.require("body")),
        parent_comment_id=str(parent) if parent else None,
        anchor=anchor,
    )
    clear_posted_draft(
        call.repositories,
        created.workspace_id,
        created.author_id,
        created.issue_id,
        created.parent_comment_id,
        created.created_at,
    )
    if sync and not parent:
        created = _sync_root(call, issue, created.comment_id)
    return _comment_json(created)


def _sync_comment_thread(call: ToolCall) -> Any:
    """Sync a root comment's thread to a linked pull request or GitHub issue through the route's path."""
    issue = issue_ref(call, call.require("issue_id"))
    return thread_sync.thread_read(_sync_root(call, issue, str(call.require("comment_id"))))


def _unsync_comment_thread(call: ToolCall) -> Any:
    """Stop mirroring a thread to GitHub through the route's path, keeping every comment."""
    issue = issue_ref(call, call.require("issue_id"))
    comment = thread_sync.unsync_thread(
        call.repositories, call.context, issue.issue_id, str(call.require("comment_id"))
    )
    return thread_sync.thread_read(comment)


def _resolve_comment_thread(call: ToolCall) -> Any:
    """Resolve a top level comment's thread through the route's path."""
    issue = issue_ref(call, call.require("issue_id"))
    return _comment_json(
        resolve_thread(call.repositories, call.context, issue.issue_id, str(call.require("comment_id")))
    )


def _unresolve_comment_thread(call: ToolCall) -> Any:
    """Unresolve a top level comment's thread through the route's path."""
    issue = issue_ref(call, call.require("issue_id"))
    return _comment_json(
        unresolve_thread(call.repositories, call.context, issue.issue_id, str(call.require("comment_id")))
    )


def _list_github_thread_targets(call: ToolCall) -> Any:
    """Where an issue's threads may be synced, each with the ref `github_target` takes."""
    issue = issue_ref(call, call.require("issue_id"))
    return {"targets": thread_sync.thread_targets(call.repositories, issue)}


def _list_comments(call: ToolCall) -> Any:
    """One page of an issue's comments, oldest first, replies carrying their parent."""
    issue = issue_ref(call, call.require("issue_id"))
    rows, next_cursor = comment_page(
        call.repositories,
        call.context,
        issue.issue_id,
        cursor=call.optional("cursor"),
        limit=limit(call.optional("limit")),
    )
    return {"comments": [_comment_json(row) for row in rows], "next_cursor": next_cursor}


def _list_issue_activity(call: ToolCall) -> Any:
    """One page of an issue's history, newest first, each row naming the client it came through."""
    issue = issue_ref(call, call.require("issue_id"))
    source = call.optional("source")
    rows, next_cursor = activity_page(
        call.repositories,
        call.context,
        issue.issue_id,
        cursor=call.optional("cursor"),
        limit=limit(call.optional("limit")),
        source=str(source) if source else None,
    )
    return {
        "activity": [ActivityRead.from_row(row).model_dump(mode="json", by_alias=True) for row in rows],
        "next_cursor": next_cursor,
    }


def _link_json(link: LinkRead) -> dict[str, Any]:
    """One relation as the tools answer it, the far side named by id and key.

    `relation_id` is the name `delete_issue_relation` takes; `link_id` repeats it as
    a deprecated alias for callers written against the earlier shape.
    """
    return {
        "relation_id": link.link_id,
        "link_id": link.link_id,
        "issue_id": link.issue_id,
        "type": link.type,
        "target_issue_id": link.target_issue_id,
        "target_issue_key": link.target_key,
        "target_title": link.target_title,
        "target_status": link.target_status.name if link.target_status else None,
        "target_status_category": link.target_status.category if link.target_status else None,
    }


def _list_issue_relations(call: ToolCall) -> Any:
    """Every relation touching one issue, in both directions."""
    issue = issue_ref(call, call.require("issue_id"))
    links = list_links(call.repositories, call.context, issue.issue_id)
    return {"relations": [_link_json(link) for link in links]}


def _create_issue_relation(call: ToolCall) -> Any:
    """Relate two issues, idempotently on the same pair and type.

    The inverse row is written by the same path the route runs, so `A blocks B`
    reads back from B as `blocked_by A`.
    """
    issue = issue_ref(call, call.require("issue_id"))
    target = issue_ref(call, call.require("target_issue_id"))
    payload = LinkCreate.model_validate({"type": call.require("type"), "target_issue_id": target.issue_id})
    return _link_json(create_link(call.repositories, call.context, issue.issue_id, payload))


def _delete_issue_relation(call: ToolCall) -> Any:
    """Remove a relation, both directions, named by its id or by its type and target.

    The pair is looked up under the issue's own partition only after the issue has
    resolved, and an absent pair reaches the shared delete path as an unknown id, so
    a reader who may not write gets the route's 403 before learning whether it exists.
    """
    issue = issue_ref(call, call.require("issue_id"))
    relation_id = call.optional("relation_id") or call.optional("link_id")
    if relation_id:
        link_id = str(relation_id)
    else:
        relation_type = str(call.optional("type") or "")
        target = call.optional("target_issue_id")
        if not relation_type or not target:
            raise ToolError(
                "Name either relation_id (the relation_id list_issue_relations answers), or type and target_issue_id"
            )
        if relation_type not in STORED_LINK_TYPES:
            raise ToolError(f"type must be one of: {', '.join(STORED_LINK_TYPES)}")
        target_id = issue_id_ref(call, target) or ""
        row = call.repositories.relations.get(call.context.workspace_id, issue.issue_id, relation_type, target_id)
        link_id = row.link_id if row is not None else "none"
    removed = delete_link(call.repositories, call.context, issue.issue_id, link_id)
    return {
        "deleted": True,
        "relation_id": removed.link_id,
        "issue_id": removed.issue_id,
        "type": removed.relation_type,
        "target_issue_id": removed.target_issue_id,
    }


def _subscribers_json(found: SubscribersRead) -> dict[str, Any]:
    """An issue's subscribers as the tools answer them, and whether the caller is one."""
    return {
        "subscribers": [
            {
                "user_id": row.user_id,
                "display_name": row.display_name,
                "avatar_url": row.avatar_url,
                "reason": row.reason,
                "created_at": row.created_at.isoformat(),
            }
            for row in found.subscribers
        ],
        "subscribed": found.subscribed,
    }


def _list_issue_subscribers(call: ToolCall) -> Any:
    """Everyone following one issue, oldest subscription first."""
    issue = issue_ref(call, call.require("issue_id"))
    return _subscribers_json(list_subscribers(call.repositories, call.context, issue.issue_id))


def _subscriber_target(call: ToolCall) -> str | None:
    """The `user_id` argument as a user id, `me` and an email resolved, or `None` for the caller."""
    value = call.optional("user_id")
    if value is None or not str(value).strip():
        return None
    reference = str(value).strip()
    return user_ref(call, reference) if "@" in reference else resolve_user(call, reference)


def _subscribe_to_issue(call: ToolCall) -> Any:
    """Follow an issue as the caller, or subscribe a teammate who can see it, idempotently."""
    issue = issue_ref(call, call.require("issue_id"))
    return _subscribers_json(subscribe(call.repositories, call.context, issue.issue_id, _subscriber_target(call)))


def _unsubscribe_from_issue(call: ToolCall) -> Any:
    """Stop following an issue as the caller, or unsubscribe a teammate, idempotently."""
    issue = issue_ref(call, call.require("issue_id"))
    return _subscribers_json(unsubscribe(call.repositories, call.context, issue.issue_id, _subscriber_target(call)))


def _status_ref(call: ToolCall, team: str, value: str) -> str:
    """A status id from its id or its name within one team, else the value unchanged.

    `team` may be a team id, key prefix or name. A team the caller cannot see
    leaves the value as given, so the shared write path answers it as it would.
    `triage`, in any case, is the synthetic triage status and wins over a status
    of that name, as the clients' pickers list it first.
    """
    if _is_triage(value):
        return TRIAGE_STATUS_ID
    try:
        team_id = team_id_ref(call, team)
    except ToolError:
        return value
    statuses = call.repositories.team_config.list_statuses(call.context.workspace_id, team_id)
    return _by_name(statuses, "status_id", value)


def _label_refs(call: ToolCall, team: str, values: Any) -> Any:
    """Label ids from ids or names within one team, workspace labels included.

    `team` may be a team id, key prefix or name. A value that is a listed id, or
    is shaped like an id, passes through for the write path to answer. A name that
    matches no label, or more than one, is refused with the team's label names, so
    an agent can correct the call without listing labels first. A team the caller
    cannot see, or a value that is not a list, passes through unchanged.
    """
    if not isinstance(values, list):
        return values
    try:
        team_id = team_id_ref(call, team)
    except ToolError:
        return values
    labels = call.repositories.team_config.list_labels(call.context.workspace_id, team_id)
    return [_label_ref(labels, str(value)) for value in values]


def _label_ref(labels: list[Any], value: str) -> str:
    """One label id from its id or its name among a team's labels, refusing an unknown or ambiguous name."""
    if any(row.label_id == value for row in labels) or ULID_PATTERN.match(value):
        return value
    folded = value.strip().casefold()
    named = [row for row in labels if row.name.casefold() == folded]
    if len(named) == 1:
        return str(named[0].label_id)
    choices = ", ".join(sorted({row.name for row in labels if not row.is_group})) or "none"
    problem = "matches more than one label" if named else "is not a label of this team"
    raise ToolError(f"Label {value!r} {problem}. The team's labels are: {choices}")


def _is_triage(value: str) -> bool:
    """Whether a status reference names the synthetic triage status."""
    return value.strip().casefold() == TRIAGE_STATUS_ID


def _by_name(rows: list[Any], id_attribute: str, value: str) -> str:
    """The id of the one row whose id or name matches, else the value unchanged.

    An unknown or ambiguous name passes through, so the shared write path refuses it
    with the same message it gives an unknown id.
    """
    if any(getattr(row, id_attribute) == value for row in rows):
        return value
    folded = value.strip().casefold()
    named = [row for row in rows if row.name.casefold() == folded]
    return getattr(named[0], id_attribute) if len(named) == 1 else value


def _bulk_selection(call: ToolCall) -> list[str]:
    """The bulk selection as issue ids, keys resolved, capped as the route caps it."""
    raw = call.require("issue_ids")
    if not isinstance(raw, list):
        raise ToolError("issue_ids must be a list of issue ids or keys")
    if len(raw) > BULK_MAX_ISSUES:
        raise ToolError(f"issue_ids takes at most {BULK_MAX_ISSUES} issues")
    return [issue_id_ref(call, item) or "" for item in raw if item is not None and str(item).strip()]


def _selection_team(call: ToolCall, issue_ids: list[str]) -> str | None:
    """The one team every visible issue of the selection sits in, or `None` when they span teams."""
    rows = call.repositories.issues.get_many(call.context.workspace_id, issue_ids)
    teams = {row.team_id for row in rows.values() if call.context.can_see_team(row.team_id)}
    return teams.pop() if len(teams) == 1 else None


def _selection_projects(call: ToolCall, issue_ids: list[str]) -> set[str | None]:
    """The projects the visible issues of a selection sit in now, `None` for an issue in no project."""
    rows = call.repositories.issues.get_many(call.context.workspace_id, issue_ids)
    return {row.project_id for row in rows.values() if call.context.can_see_team(row.team_id)}


def _bulk_milestone(call: ToolCall, patch: dict[str, Any], issue_ids: list[str]) -> None:
    """Resolve a milestone name in a bulk patch that names no project, in place.

    The name resolves against the one project every issue of the selection is in
    now. Issues spread over several projects are refused, because one name means a
    different milestone in each. An id, or a selection in no project, passes
    through for the write path to answer.
    """
    value = patch.get("project_milestone_id")
    if not value or "project_id" in patch or ULID_PATTERN.match(str(value)):
        return
    projects = _selection_projects(call, issue_ids)
    if len(projects) > 1:
        raise ToolError(
            f"The issues are in different projects, so the milestone {value!r} cannot be resolved by name. "
            "Pass project_id, or the milestone's id."
        )
    project_id = next(iter(projects), None)
    if project_id is None:
        return
    milestones = call.repositories.planning.list_milestones(call.context.workspace_id, project_id)
    patch["project_milestone_id"] = _by_name(milestones, "milestone_id", str(value))


def _bulk_names(call: ToolCall, patch: dict[str, Any], team_id: str | None) -> None:
    """Resolve status, label, cycle, project and milestone names in a bulk patch, in place.

    Names resolve only against the selection's single team and the projects on it,
    because a name means a different row in each team and one patch carries one id.
    A milestone named without a project is resolved by `_bulk_milestone` instead.
    Labels both added and removed are left as sent, for the route to refuse.
    The synthetic triage status resolves in any selection, since every team shares it.
    """
    workspace_id = call.context.workspace_id
    triage = bool(patch.get("status_id")) and _is_triage(str(patch["status_id"]))
    if triage:
        patch["status_id"] = TRIAGE_STATUS_ID
    if team_id is None:
        return
    if patch.get("status_id") and not triage:
        statuses = call.repositories.team_config.list_statuses(workspace_id, team_id)
        patch["status_id"] = _by_name(statuses, "status_id", str(patch["status_id"]))
    labels = None
    overlap = set(map(str, patch.get("add_label_ids") or [])) & set(map(str, patch.get("remove_label_ids") or []))
    for name in ("add_label_ids", "remove_label_ids"):
        if patch.get(name) and not overlap:
            labels = labels or call.repositories.team_config.list_labels(workspace_id, team_id)
            patch[name] = [_label_ref(labels, str(item)) for item in patch[name]]
    if patch.get("cycle_id") and str(patch["cycle_id"]).strip().casefold() not in RELATIVE_CYCLES:
        cycles, _ = call.repositories.planning.list_cycles(workspace_id, team_id, limit=500)
        patch["cycle_id"] = _by_name(cycles, "cycle_id", str(patch["cycle_id"]))
    if patch.get("project_id"):
        projects = [row for row in call.repositories.planning.list_projects(workspace_id) if team_id in row.team_ids]
        patch["project_id"] = _by_name(projects, "project_id", str(patch["project_id"]))
    if patch.get("project_milestone_id") and patch.get("project_id"):
        milestones = call.repositories.planning.list_milestones(workspace_id, str(patch["project_id"]))
        patch["project_milestone_id"] = _by_name(milestones, "milestone_id", str(patch["project_milestone_id"]))


def _bulk_update_issues(call: ToolCall) -> Any:
    """Apply one patch to many issues through the route's own bulk path.

    All or nothing on validation, exactly as the route: one invisible issue, one
    team the caller cannot write in, or one value an issue's team refuses fails the
    call with nothing changed. `only_if_estimate` writes only the issues still
    holding that estimate and lists the rest under `skipped`, so an agent
    backfilling estimates never overwrites a value a peer set meanwhile.
    """
    issue_ids = _bulk_selection(call)
    patch: dict[str, Any] = {}
    for name in ("status_id", "priority", "archived", "add_label_ids", "remove_label_ids"):
        if call.optional(name) is not None:
            patch[name] = call.arguments[name]
    for name in BULK_CLEARABLE:
        if call.present(name):
            patch[name] = call.arguments[name]
    if patch.get("assignee_id") is not None:
        assignee = str(patch["assignee_id"])
        patch["assignee_id"] = user_ref(call, assignee) if "@" in assignee else resolve_user(call, assignee)
    if "parent_id" in patch:
        patch["parent_id"] = issue_id_ref(call, patch["parent_id"])
    _bulk_names(call, patch, _selection_team(call, issue_ids))
    _bulk_milestone(call, patch, issue_ids)
    body: dict[str, Any] = {"issue_ids": issue_ids, "patch": patch}
    if call.optional("only_if_estimate") is not None:
        body["only_if_estimate"] = str(call.arguments["only_if_estimate"])
    payload = IssueBulkUpdate.model_validate(body)
    stored, skipped = bulk_update_issues(call.repositories, call.context, payload)
    return {"issues": [summary_json(call.repositories.teams, row) for row in stored], "skipped": skipped}


ISSUE_REF = "The issue's id, or its key such as ABC-123"

ISSUE_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_issues",
        description=(
            "One page of issues this credential can see, with the issue list filters, a sort and a cursor. "
            "Every filter takes one value or a list, ORed, and filters are ANDed unless match is any; "
            "groups nest conditions two levels deep with their own match. Answers issue summaries, each with "
            "started_at, completed_at and cancelled_at as ISO 8601 UTC or null, and next_cursor."
        ),
        scopes=("issues:read",),
        schema=object_schema(
            {
                **_filter_properties(),
                "query": string("A key or title prefix, such as ABC-12 or 'Fix login'"),
                "include_archived": {"type": "boolean", "description": "Include archived issues, default false"},
                "include_sub_teams": {
                    "type": "boolean",
                    "description": "With team_id, also list the issues of that team's sub-teams, default false",
                },
                "sort": enum(SORTS, SORT_HELP),
                "reverse": {"type": "boolean", "description": REVERSE_HELP},
                **page_properties(),
            }
        ),
        handler=_list_issues,
    ),
    Tool(
        name="get_insights",
        description=(
            "Issue count or estimate points grouped by one dimension, optionally segmented by a second, "
            "over a team, every visible team, or a saved view with its filter, plus the list filters. "
            "Answers groups with label, value, issue_count and segments, the total, and truncated when "
            "the scope held more issues than row_cap."
        ),
        scopes=("issues:read",),
        schema=object_schema(
            {
                **_filter_properties(),
                "view_id": string("A saved view whose team and filter apply as well"),
                "group_by": enum(INSIGHT_DIMENSIONS, "What each bar is, defaulting to status"),
                "segment_by": enum(INSIGHT_DIMENSIONS, "What splits each bar, optional"),
                "measure": enum(INSIGHT_MEASURES, "count of issues or sum of estimate points, defaulting to count"),
                "include_archived": {"type": "boolean", "description": "Include archived issues, default false"},
                "include_sub_teams": {
                    "type": "boolean",
                    "description": "With team_id, also count the issues of that team's sub-teams, default false",
                },
            }
        ),
        handler=_get_insights,
    ),
    Tool(
        name="list_my_issues",
        description="One page of the issues assigned to the caller, with the issue list filters, a sort and a cursor.",
        scopes=("issues:read",),
        schema=object_schema(
            {
                **_filter_properties(with_assignee=False),
                "include_archived": {"type": "boolean", "description": "Include archived issues, default false"},
                "sort": enum(SORTS, SORT_HELP),
                "reverse": {"type": "boolean", "description": REVERSE_HELP},
                **page_properties(),
            }
        ),
        handler=_list_my_issues,
    ),
    Tool(
        name="search_issues",
        description=(
            "Search issues whose key is a text, such as ABC-123, or whose title or body contains it, "
            "with the issue list filters. "
            "Answers summaries in the sort's order, most recently updated first by default, "
            "and a next_cursor while more issues remain to search."
        ),
        scopes=("issues:read",),
        schema=object_schema(
            {
                "query": string("An issue key such as ABC-123, or text to match against the title and body"),
                **_filter_properties(),
                "include_archived": {"type": "boolean", "description": "Include archived issues, default true"},
                "sort": enum(SORTS, SORT_HELP),
                "reverse": {"type": "boolean", "description": REVERSE_HELP},
                **page_properties(),
            }
        ),
        handler=_search_issues,
    ),
    Tool(
        name="get_issue",
        description=(
            "Read one issue in full, by its id or its key such as ABC-123, with its linked pull requests: "
            "each one's review and check state, and its position when it is stacked on another."
        ),
        scopes=("issues:read",),
        schema=object_schema({"issue_id": string(ISSUE_REF)}, required=("issue_id",)),
        handler=_get_issue,
    ),
    Tool(
        name="create_issue",
        description=(
            "Create an issue in a team, allocating its key. With no status_id it starts in the team's first status "
            "while the team has triage off. While triage is on, an issue with no status_id waits in triage even "
            "when project_id or cycle_id is passed; a team member skips triage by naming a real status_id such as "
            "Backlog or Todo, and a team member's sub-issue skips it unless asked. Issues from guests, people "
            "outside the team and workspace keys always wait in triage while it is on. "
            "parent_id makes it a sub-issue; cycle_id, project_id and project_milestone_id place it. "
            "template_id fills every field not passed from one of the team's templates (see list_templates), "
            "and title may then be omitted when the template has one. A form template (one with form_fields) also "
            "takes form_answers keyed by each field's key: required fields must be answered, a select takes one of "
            "its options, and the answers land in the body and send the issue to triage. "
            "The answer lists possible_duplicates: open issues whose titles share its terms."
        ),
        scopes=("issues:write",),
        schema=object_schema(
            {
                "team_id": string("The team to create it in"),
                "title": string("The issue title"),
                "body": string("The issue body, in Markdown"),
                "status_id": string(
                    "The starting status, by id or name; a real status skips triage for a team member, "
                    "'triage' files it into triage"
                ),
                "priority": enum(PRIORITIES, "The priority, defaulting to none"),
                "assignee_id": string("Who to assign it to; 'me' is the caller"),
                "label_ids": string_list("Labels of the same team, by id or name"),
                "estimate": string("The estimate, in the team's scale"),
                "start_date": string("Start date, YYYY-MM-DD"),
                "due_date": string("Due date, YYYY-MM-DD"),
                "parent_id": string("The parent issue's id or key, in the same team"),
                "cycle_id": string("A cycle of the same team, or current, next or previous on its schedule"),
                "project_id": string("A project the team is on"),
                "project_milestone_id": string("A milestone of that project"),
                "template_id": string("A template the team offers, by id or name, filling the fields not passed"),
                "form_answers": {
                    "type": "object",
                    "description": (
                        "For a form template: answers by field key, text for short_text, long_text and select, "
                        "true or false for checkbox"
                    ),
                    "additionalProperties": {"type": ["string", "boolean"]},
                },
            },
            required=("team_id",),
        ),
        handler=_create_issue,
    ),
    Tool(
        name="update_issue",
        description=(
            "Change fields on an issue. Only the fields named are written; null clears a nullable field, "
            "so parent_id null detaches a sub-issue and cycle_id or project_id null removes it from one."
        ),
        scopes=("issues:write",),
        schema=object_schema(
            {
                "issue_id": string(ISSUE_REF),
                "title": string("A new title"),
                "body": nullable("A new body, in Markdown"),
                "status_id": string(
                    "A new status of the same team, by id or name; 'triage' sends it to triage, "
                    "and a real status accepts an issue waiting there"
                ),
                "priority": enum(PRIORITIES, "A new priority"),
                "assignee_id": nullable("A new assignee, 'me' for the caller, or null to unassign"),
                "label_ids": string_list("The full new label set, by id or name"),
                "estimate": nullable("A new estimate in the team's scale, or null"),
                "start_date": nullable("A new start date, YYYY-MM-DD, or null"),
                "due_date": nullable("A new due date, YYYY-MM-DD, or null"),
                "parent_id": nullable("A parent issue's id or key in the same team, or null to detach"),
                "cycle_id": nullable("A cycle of the same team, current, next or previous on its schedule, or null"),
                "project_id": nullable("A project the team is on, or null; changing it clears the milestone"),
                "project_milestone_id": nullable("A milestone of the issue's project, or null"),
            },
            required=("issue_id",),
        ),
        handler=_update_issue,
    ),
    Tool(
        name="assign_issue",
        description="Assign an issue, or unassign it with a null assignee_id.",
        scopes=("issues:write",),
        schema=object_schema(
            {
                "issue_id": string(ISSUE_REF),
                "assignee_id": nullable("Who to assign it to, 'me' for the caller, or null to unassign"),
            },
            required=("issue_id",),
        ),
        handler=_assign_issue,
    ),
    Tool(
        name="archive_issue",
        description=(
            "Archive an issue, hiding it from lists and boards. It stays readable by id or key, "
            "searchable and restorable with unarchive_issue. Idempotent."
        ),
        scopes=("issues:write",),
        schema=object_schema({"issue_id": string(ISSUE_REF)}, required=("issue_id",)),
        handler=_archive_issue,
    ),
    Tool(
        name="move_issue",
        description=(
            "Move an issue to another team. It gets the next key there and the old key keeps resolving. "
            "Sub-issues move with it, a sub-issue moved alone leaves its parent, the cycle is cleared, "
            "and a status or label the target team lacks is mapped or dropped."
        ),
        scopes=("issues:write",),
        schema=object_schema(
            {"issue_id": string(ISSUE_REF), "team_id": string("The team to move it to")},
            required=("issue_id", "team_id"),
        ),
        handler=_move_issue,
    ),
    Tool(
        name="duplicate_issue",
        description=(
            "Copy an issue into a new issue in the same team. The copy keeps the title with a (copy) suffix, "
            "the body, labels, priority, estimate, parent, project and milestone, and starts in the team's "
            "default status, unassigned, outside any cycle and with no dates or relations."
        ),
        scopes=("issues:write",),
        schema=object_schema({"issue_id": string(ISSUE_REF)}, required=("issue_id",)),
        handler=_duplicate_issue,
    ),
    Tool(
        name="unarchive_issue",
        description="Restore an archived issue to its lists and board. Idempotent.",
        scopes=("issues:write",),
        schema=object_schema({"issue_id": string(ISSUE_REF)}, required=("issue_id",)),
        handler=_unarchive_issue,
    ),
    Tool(
        name="list_comments",
        description="One page of an issue's comments, oldest first. Replies carry parent_comment_id.",
        scopes=("issues:read",),
        schema=object_schema({"issue_id": string(ISSUE_REF), **page_properties()}, required=("issue_id",)),
        handler=_list_comments,
    ),
    Tool(
        name="list_issue_activity",
        description=(
            "One page of an issue's history, newest first. Each row carries source: web, mcp, cli, api, "
            "github or system, or null for rows recorded before sources were."
        ),
        scopes=("issues:read",),
        schema=object_schema(
            {
                "issue_id": string(ISSUE_REF),
                "source": enum(CHANGE_SOURCES, "Keep only the changes made through this client"),
                **page_properties(),
            },
            required=("issue_id",),
        ),
        handler=_list_issue_activity,
    ),
    Tool(
        name="add_comment",
        description="Add a comment to an issue, or a reply to a top level comment with parent_comment_id.",
        scopes=("comments:write",),
        schema=object_schema(
            {
                "issue_id": string(ISSUE_REF),
                "body": string("The comment body, in Markdown; @mentions notify"),
                "parent_comment_id": string("A top level comment on the same issue to reply to"),
                "quote": string(
                    "Pin a new thread to this passage of the issue description, copied as it reads; the "
                    "description highlights it. Not for replies"
                ),
                "sync_to_github": boolean(
                    "Also sync the thread to a pull request or GitHub issue linked to this issue, so the App "
                    "posts it there and GitHub replies land in the thread. A public repository publishes it"
                ),
                "github_target": string(
                    "Which linked pull request or GitHub issue to sync to, as owner/repo#12 or its URL; "
                    "needed when there is more than one"
                ),
            },
            required=("issue_id", "body"),
        ),
        handler=_add_comment,
    ),
    Tool(
        name="list_github_thread_targets",
        description=(
            "The linked pull requests and one way GitHub issue an issue's comment threads can be synced to, "
            "each with ref, the name github_target takes, and private."
        ),
        scopes=("issues:read",),
        schema=object_schema({"issue_id": string(ISSUE_REF)}, required=("issue_id",)),
        handler=_list_github_thread_targets,
    ),
    Tool(
        name="sync_comment_thread",
        description=(
            "Sync a top level comment's thread to a pull request or GitHub issue linked to the issue. The App "
            "posts an opening comment quoting it, then each new reply, and GitHub comments written there land "
            "in the thread. Idempotent on the same target."
        ),
        scopes=("comments:write",),
        schema=object_schema(
            {
                "issue_id": string(ISSUE_REF),
                "comment_id": string("The top level comment whose thread to sync"),
                "github_target": string("owner/repo#12 or its URL; needed when more than one target is linked"),
            },
            required=("issue_id", "comment_id"),
        ),
        handler=_sync_comment_thread,
    ),
    Tool(
        name="unsync_comment_thread",
        description="Stop syncing a comment thread to GitHub. Comments already copied stay on both sides.",
        scopes=("comments:write",),
        schema=object_schema(
            {"issue_id": string(ISSUE_REF), "comment_id": string("The top level comment whose thread to unsync")},
            required=("issue_id", "comment_id"),
        ),
        handler=_unsync_comment_thread,
    ),
    Tool(
        name="resolve_comment_thread",
        description=(
            "Resolve a top level comment's thread, which collapses it to one line in the issue's activity. "
            "Any team member may resolve; a reply to the thread reopens it. Idempotent."
        ),
        scopes=("comments:write",),
        schema=object_schema(
            {"issue_id": string(ISSUE_REF), "comment_id": string("The top level comment whose thread to resolve")},
            required=("issue_id", "comment_id"),
        ),
        handler=_resolve_comment_thread,
    ),
    Tool(
        name="unresolve_comment_thread",
        description="Reopen a resolved comment thread, whoever resolved it. Idempotent.",
        scopes=("comments:write",),
        schema=object_schema(
            {"issue_id": string(ISSUE_REF), "comment_id": string("The top level comment whose thread to reopen")},
            required=("issue_id", "comment_id"),
        ),
        handler=_unresolve_comment_thread,
    ),
    Tool(
        name="list_issue_relations",
        description="Every relation touching an issue, in both directions: blocks, blocked_by, relates_to, "
        "duplicate_of and duplicated_by.",
        scopes=("issues:read",),
        schema=object_schema({"issue_id": string(ISSUE_REF)}, required=("issue_id",)),
        handler=_list_issue_relations,
    ),
    Tool(
        name="create_issue_relation",
        description=(
            "Relate an issue to another: blocks, blocked_by, relates_to or duplicate_of. "
            "Name each issue by id or key. The inverse is recorded on the target. Idempotent on the same pair and type."
        ),
        scopes=("issues:write",),
        schema=object_schema(
            {
                "issue_id": string(ISSUE_REF),
                "type": enum(LINK_TYPES, "How issue_id relates to the target"),
                "target_issue_id": string("The other issue's id or key"),
            },
            required=("issue_id", "type", "target_issue_id"),
        ),
        handler=_create_issue_relation,
    ),
    Tool(
        name="delete_issue_relation",
        description=(
            "Remove a relation between two issues, both directions at once. Name it by relation_id (as "
            "list_issue_relations answers it), or by type and target_issue_id. The link is lost; the issues are not."
        ),
        scopes=("issues:write",),
        schema=object_schema(
            {
                "issue_id": string(ISSUE_REF),
                "relation_id": string("The relation's relation_id, from list_issue_relations"),
                "link_id": string("Deprecated alias for relation_id"),
                "type": enum(STORED_LINK_TYPES, "How issue_id relates to the target, when naming the pair"),
                "target_issue_id": string("The other issue's id or key, when naming the pair"),
            },
            required=("issue_id",),
        ),
        handler=_delete_issue_relation,
        destructive=True,
    ),
    Tool(
        name="list_issue_subscribers",
        description="Everyone following an issue, oldest first, and whether the caller is one of them.",
        scopes=("issues:read",),
        schema=object_schema({"issue_id": string(ISSUE_REF)}, required=("issue_id",)),
        handler=_list_issue_subscribers,
    ),
    Tool(
        name="subscribe_to_issue",
        description=(
            "Follow an issue to be notified of its changes, as the caller or on behalf of a teammate who can see "
            "it. Subscribing someone else notifies them and records it in the issue's history. Idempotent."
        ),
        scopes=("issues:write",),
        schema=object_schema(
            {
                "issue_id": string(ISSUE_REF),
                "user_id": string("Who to subscribe: a user id or email, or 'me' for the caller (the default)"),
            },
            required=("issue_id",),
        ),
        handler=_subscribe_to_issue,
    ),
    Tool(
        name="unsubscribe_from_issue",
        description=(
            "Stop following an issue, as the caller or on behalf of a teammate. Removing someone else is recorded "
            "in the issue's history. Idempotent."
        ),
        scopes=("issues:write",),
        schema=object_schema(
            {
                "issue_id": string(ISSUE_REF),
                "user_id": string("Who to unsubscribe: a user id or email, or 'me' for the caller (the default)"),
            },
            required=("issue_id",),
        ),
        handler=_unsubscribe_from_issue,
    ),
    Tool(
        name="bulk_update_issues",
        description=(
            f"Apply one change to up to {BULK_MAX_ISSUES} issues at once: status, assignee, priority, labels added "
            "or removed, project, milestone, cycle, estimate, parent issue, or archived. All or nothing: one refused "
            "issue changes none. Status, label, cycle, project and milestone accept names when the issues share a "
            "team. Answers the written issues and the ids skipped."
        ),
        scopes=("issues:write",),
        schema=object_schema(
            {
                "issue_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                    "maxItems": BULK_MAX_ISSUES,
                    "description": "The issues, by id or key such as ABC-12",
                },
                "status_id": string("A status of the issues' team, by id or name; 'triage' sends them to triage"),
                "assignee_id": nullable("An assignee: 'me', an email or a user id, or null to unassign"),
                "priority": enum(PRIORITIES, "A new priority"),
                "add_label_ids": string_list("Labels to add, by id or name; other labels are kept"),
                "remove_label_ids": string_list("Labels to remove, by id or name"),
                "project_id": nullable("A project the team is on, by id or name, or null to remove"),
                "project_milestone_id": nullable("A milestone of the project, by id or name, or null"),
                "cycle_id": nullable(
                    "A cycle of each issue's team, by id or name, current, next or previous, or null to remove"
                ),
                "estimate": nullable("An estimate in the team's scale, or null"),
                "parent_id": nullable(
                    "A top level issue of the same team to nest the issues under, by id or key, or null to detach"
                ),
                "archived": {"type": "boolean", "description": "true archives the issues, false restores them"},
                "only_if_estimate": string(
                    "Write only issues whose estimate is this now, 'none' for unestimated; the rest come back "
                    "under skipped"
                ),
            },
            required=("issue_ids",),
        ),
        handler=_bulk_update_issues,
    ),
)
