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

from typing import Any, cast

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
from app.common.comment_writes import comment_page, create_comment
from app.common.db.dynamo.comments import Comment
from app.common.db.dynamo.issues import Issue, as_issue
from app.common.db.dynamo.relations import INVERSE_TYPES
from app.common.insights import insights_for
from app.common.issue_activity import activity_page
from app.common.issue_archive import archive_issue, unarchive_issue
from app.common.issue_filters import UnknownStatusCategory, build_issue_filter
from app.common.issue_keys import current
from app.common.issue_links import create_link, delete_link, list_links
from app.common.issue_move import move_issue
from app.common.issue_rules import require_team_reader, visible_team_ids
from app.common.issue_subscribers import list_subscribers, subscribe, unsubscribe
from app.common.issue_writes import bulk_update_issues, create_issue, list_issues, update_issue
from app.domains.integrations.mcp.toolkit import (
    MAX_RESULTS,
    PRIORITIES,
    Tool,
    ToolCall,
    enum,
    filter_values,
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

SORTS: tuple[str, ...] = ("updated_desc", "created_desc", "key_asc", "priority_desc", "due_asc", "manual")

LINK_TYPES: tuple[str, ...] = ("blocks", "blocked_by", "relates_to", "duplicate_of")

STORED_LINK_TYPES: tuple[str, ...] = tuple(INVERSE_TYPES)
"""Every type a stored link row can carry, `duplicated_by` included, as a listing shows them."""

BULK_CLEARABLE: tuple[str, ...] = ("assignee_id", "project_id", "project_milestone_id", "cycle_id", "estimate")
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
    return issue_json(current(call.repositories.teams, issue), status_name=_status_name(call, issue))


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
)
"""The issue list filter arguments the tools take, by the HTTP list's query parameter names."""


def _filter_properties(*, with_assignee: bool = True) -> dict[str, Any]:
    """The issue list filters, spelled as the HTTP list's query parameters are."""
    properties: dict[str, Any] = {
        "team_id": string("Narrow to one team"),
        "status_id": one_or_many("Any of these statuses"),
        "status_id_not": one_or_many("None of these statuses"),
        "status_category": one_or_many("Any of these categories: backlog, unstarted, started, completed, cancelled"),
        "status_category_not": one_or_many("None of these categories"),
        "label_id": one_or_many("Carrying any of these labels; 'none' is unlabelled"),
        "label_id_not": one_or_many("Carrying none of these labels"),
        "priority": one_or_many("Any of these priorities: none, urgent, high, medium, low"),
        "parent_id": one_or_many("Children of any of these issue ids; 'none' is top level issues"),
        "project_id": one_or_many("In any of these projects; 'none' is no project"),
        "project_milestone_id": one_or_many("In any of these project milestones; 'none' is no milestone"),
        "cycle_id": one_or_many("In any of these cycles; 'none' is no cycle"),
        "estimate": one_or_many("Any of these estimates, such as M or 3; 'none' is unestimated"),
        "estimate_not": one_or_many("None of these estimates; 'none' leaves out unestimated issues"),
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


def _build_filter(call: ToolCall, *, include_archived: bool = False, **overrides: Any) -> Any:
    """The shared issue filter from a tool's arguments, as the HTTP list builds it.

    Archived issues are left out unless the caller asks for them, the list's own default.
    """
    values: dict[str, Any] = {name: filter_values(call.optional(name)) for name in FILTER_ARGUMENTS}
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


def _page(call: ToolCall, **overrides: Any) -> dict[str, Any]:
    """One page of the issue list, through the same fan-out the HTTP list runs."""
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
    )
    return {"issues": [summary_json(row) for row in rows], "next_cursor": next_cursor}


def _list_issues(call: ToolCall) -> Any:
    """One page of the issues this credential can see, filtered and sorted."""
    query = call.optional("query")
    return _page(call, q=str(query) if query else None)


def _get_insights(call: ToolCall) -> Any:
    """A breakdown of the issues a team, a filter or a saved view selects, as the insights route answers it."""
    filters: dict[str, Any] = {name: filter_values(call.optional(name)) for name in FILTER_ARGUMENTS}
    filters["include_archived"] = _include_archived(call, False)
    team_id = call.optional("team_id")
    view_id = call.optional("view_id")
    segment_by = call.optional("segment_by")
    body = insights_for(
        call.repositories,
        call.context,
        team_id=str(team_id) if team_id else None,
        view_id=str(view_id) if view_id else None,
        subscriber_id=None,
        group_by=str(call.optional("group_by", "status")),
        segment_by=str(segment_by) if segment_by else None,
        measure=str(call.optional("measure", "count")),
        filters=filters,
    )
    return body.model_dump(mode="json")


def _list_my_issues(call: ToolCall) -> Any:
    """One page of the issues assigned to the caller, filtered and sorted."""
    return _page(call, assignee_id=["me"], assignee_id_not=None)


def _search_issues(call: ToolCall) -> Any:
    """Issues whose title or body contains a text, newest first, in visible teams only.

    Substring over title and body, unlike `list_issues`, whose `query` is the
    HTTP list's key or title prefix. Filtered after the team read rather than
    through the search index, because the index is a separate table this domain
    holds no grant on. The fan-out is bounded by the result limit, so a broad query
    costs one short page per visible team rather than a scan. Archived issues are
    found too unless `include_archived` is false, as the app's search finds them,
    and so are issues awaiting triage.
    """
    query = str(call.optional("query", "") or "").strip().lower()
    team_id = call.optional("team_id")
    wanted = _build_filter(call, include_archived=True, include_triage=True)

    if team_id:
        require_team_reader(call.repositories, call.context, str(team_id))
        teams = [str(team_id)]
    else:
        teams = visible_team_ids(call.repositories, call.context)

    categories: dict[str, str] = {}
    if wanted.needs_categories:
        for candidate in teams:
            for row in call.repositories.team_config.list_statuses(call.context.workspace_id, candidate):
                categories[row.status_id] = row.category

    found: list[Issue] = []
    for candidate in teams:
        page = call.repositories.issues.list_for_team(call.context.workspace_id, candidate, limit=MAX_RESULTS)
        for item in page.items:
            issue = as_issue(item)
            if query and query not in issue.title.lower() and query not in (issue.body or "").lower():
                continue
            if not wanted.matches(issue, categories):
                continue
            found.append(issue)

    found.sort(key=lambda row: row.updated_at, reverse=True)
    wanted_count = limit(call.optional("limit"))
    return {"issues": [summary_json(current(call.repositories.teams, issue)) for issue in found[:wanted_count]]}


def _get_issue(call: ToolCall) -> Any:
    """One issue by its id or its key."""
    return _answer(call, issue_ref(call, call.require("issue_id")))


def _create_issue(call: ToolCall) -> Any:
    """Create an issue through the route's own create path."""
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
    payload["assignee_id"] = resolve_user(call, call.optional("assignee_id"))
    payload["parent_id"] = issue_id_ref(call, call.optional("parent_id"))
    if payload.get("status_id"):
        payload["status_id"] = _status_ref(call, str(payload["team_id"]), str(payload["status_id"]))
    created = create_issue(call.repositories, call.context, IssueCreate.model_validate(payload))
    return _answer(call, created)


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
    }


def _add_comment(call: ToolCall) -> Any:
    """Add a comment, or a reply to a top level comment, through the route's path."""
    issue = issue_ref(call, call.require("issue_id"))
    parent = call.optional("parent_comment_id")
    created = create_comment(
        call.repositories,
        call.context,
        issue.issue_id,
        str(call.require("body")),
        parent_comment_id=str(parent) if parent else None,
    )
    return _comment_json(created)


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


def _subscribe_to_issue(call: ToolCall) -> Any:
    """Follow an issue as the caller, idempotently."""
    issue = issue_ref(call, call.require("issue_id"))
    return _subscribers_json(subscribe(call.repositories, call.context, issue.issue_id))


def _unsubscribe_from_issue(call: ToolCall) -> Any:
    """Stop following an issue as the caller, idempotently."""
    issue = issue_ref(call, call.require("issue_id"))
    return _subscribers_json(unsubscribe(call.repositories, call.context, issue.issue_id))


def _status_ref(call: ToolCall, team: str, value: str) -> str:
    """A status id from its id or its name within one team, else the value unchanged.

    `team` may be a team id, key prefix or name. A team the caller cannot see
    leaves the value as given, so the shared write path answers it as it would.
    """
    try:
        team_id = team_id_ref(call, team)
    except ToolError:
        return value
    statuses = call.repositories.team_config.list_statuses(call.context.workspace_id, team_id)
    return _by_name(statuses, "status_id", value)


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


def _bulk_names(call: ToolCall, patch: dict[str, Any], team_id: str | None) -> None:
    """Resolve status, label, cycle, project and milestone names in a bulk patch, in place.

    Names resolve only against the selection's single team and the projects on it,
    because a name means a different row in each team and one patch carries one id.
    """
    workspace_id = call.context.workspace_id
    if team_id is None:
        return
    if patch.get("status_id"):
        statuses = call.repositories.team_config.list_statuses(workspace_id, team_id)
        patch["status_id"] = _by_name(statuses, "status_id", str(patch["status_id"]))
    labels = None
    for name in ("add_label_ids", "remove_label_ids"):
        if patch.get(name):
            labels = labels or call.repositories.team_config.list_labels(workspace_id, team_id)
            patch[name] = [_by_name(labels, "label_id", str(item)) for item in patch[name]]
    if patch.get("cycle_id"):
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
    _bulk_names(call, patch, _selection_team(call, issue_ids))
    body: dict[str, Any] = {"issue_ids": issue_ids, "patch": patch}
    if call.optional("only_if_estimate") is not None:
        body["only_if_estimate"] = str(call.arguments["only_if_estimate"])
    payload = IssueBulkUpdate.model_validate(body)
    stored, skipped = bulk_update_issues(call.repositories, call.context, payload)
    return {"issues": [summary_json(current(call.repositories.teams, row)) for row in stored], "skipped": skipped}


ISSUE_REF = "The issue's id, or its key such as ABC-123"

ISSUE_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_issues",
        description=(
            "One page of issues this credential can see, with the issue list filters, a sort and a cursor. "
            "Every filter takes one value or a list, ORed. Answers issue summaries and next_cursor."
        ),
        scopes=("issues:read",),
        schema=object_schema(
            {
                **_filter_properties(),
                "query": string("A key or title prefix, such as ABC-12 or 'Fix login'"),
                "include_archived": {"type": "boolean", "description": "Include archived issues, default false"},
                "sort": enum(SORTS, "The order, defaulting to updated_desc"),
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
                "sort": enum(SORTS, "The order, defaulting to updated_desc"),
                **page_properties(),
            }
        ),
        handler=_list_my_issues,
    ),
    Tool(
        name="search_issues",
        description=(
            "Search issues whose title or body contains a text, with the issue list filters. "
            "Answers summaries, newest first."
        ),
        scopes=("issues:read",),
        schema=object_schema(
            {
                "query": string("Text to match against the title and body"),
                **_filter_properties(),
                "include_archived": {"type": "boolean", "description": "Include archived issues, default true"},
                "limit": {"type": "integer", "minimum": 1, "maximum": MAX_RESULTS},
            }
        ),
        handler=_search_issues,
    ),
    Tool(
        name="get_issue",
        description="Read one issue in full, by its id or its key such as ABC-123.",
        scopes=("issues:read",),
        schema=object_schema({"issue_id": string(ISSUE_REF)}, required=("issue_id",)),
        handler=_get_issue,
    ),
    Tool(
        name="create_issue",
        description=(
            "Create an issue in a team, allocating its key. The status defaults to the team's first. "
            "parent_id makes it a sub-issue; cycle_id, project_id and project_milestone_id place it."
        ),
        scopes=("issues:write",),
        schema=object_schema(
            {
                "team_id": string("The team to create it in"),
                "title": string("The issue title"),
                "body": string("The issue body, in Markdown"),
                "status_id": string("The starting status, by id or name"),
                "priority": enum(PRIORITIES, "The priority, defaulting to none"),
                "assignee_id": string("Who to assign it to; 'me' is the caller"),
                "label_ids": string_list("Labels of the same team"),
                "estimate": string("The estimate, in the team's scale"),
                "start_date": string("Start date, YYYY-MM-DD"),
                "due_date": string("Due date, YYYY-MM-DD"),
                "parent_id": string("The parent issue's id or key, in the same team"),
                "cycle_id": string("A cycle of the same team"),
                "project_id": string("A project the team is on"),
                "project_milestone_id": string("A milestone of that project"),
            },
            required=("team_id", "title"),
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
                "status_id": string("A new status of the same team, by id or name"),
                "priority": enum(PRIORITIES, "A new priority"),
                "assignee_id": nullable("A new assignee, 'me' for the caller, or null to unassign"),
                "label_ids": string_list("The full new label set"),
                "estimate": nullable("A new estimate in the team's scale, or null"),
                "start_date": nullable("A new start date, YYYY-MM-DD, or null"),
                "due_date": nullable("A new due date, YYYY-MM-DD, or null"),
                "parent_id": nullable("A parent issue's id or key in the same team, or null to detach"),
                "cycle_id": nullable("A cycle of the same team, or null"),
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
            },
            required=("issue_id", "body"),
        ),
        handler=_add_comment,
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
        description="Follow an issue as the caller, to be notified of its changes. Idempotent.",
        scopes=("issues:write",),
        schema=object_schema({"issue_id": string(ISSUE_REF)}, required=("issue_id",)),
        handler=_subscribe_to_issue,
    ),
    Tool(
        name="unsubscribe_from_issue",
        description="Stop following an issue as the caller. Idempotent.",
        scopes=("issues:write",),
        schema=object_schema({"issue_id": string(ISSUE_REF)}, required=("issue_id",)),
        handler=_unsubscribe_from_issue,
    ),
    Tool(
        name="bulk_update_issues",
        description=(
            f"Apply one change to up to {BULK_MAX_ISSUES} issues at once: status, assignee, priority, labels added "
            "or removed, project, milestone, cycle, estimate, or archived. All or nothing: one refused issue "
            "changes none. Status, label, cycle, project and milestone accept names when the issues share a team. "
            "Answers the written issues and the ids skipped."
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
                "status_id": string("A status of the issues' team, by id or name"),
                "assignee_id": nullable("An assignee: 'me', an email or a user id, or null to unassign"),
                "priority": enum(PRIORITIES, "A new priority"),
                "add_label_ids": string_list("Labels to add, by id or name; other labels are kept"),
                "remove_label_ids": string_list("Labels to remove, by id or name"),
                "project_id": nullable("A project the team is on, by id or name, or null to remove"),
                "project_milestone_id": nullable("A milestone of the project, by id or name, or null"),
                "cycle_id": nullable("A cycle of the team, by id or name, or null to remove"),
                "estimate": nullable("An estimate in the team's scale, or null"),
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
