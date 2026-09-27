"""The MCP tools that read and write issues, their comments and their relations.

Every write goes through the same `app.common` paths the issue and comment routes
run, so an agent's issue carries the same key allocation, validation, activity rows
and subscriptions as a person's, and a field the route refuses the tool refuses
too. There is no MCP-shaped write path, which is what keeps the two from drifting.

There is no delete tool, and removing a relation is left out for the same reason:
an agent that can create and update but never destroy is a different risk from one
that can do both.
"""

from __future__ import annotations

from typing import Any, cast

from app.common.api.schemas.issues import IssueCreate, IssueUpdate, LinkCreate, LinkRead, SortField
from app.common.comment_writes import comment_page, create_comment
from app.common.db.dynamo.comments import Comment
from app.common.db.dynamo.issues import Issue, as_issue
from app.common.issue_archive import archive_issue, unarchive_issue
from app.common.issue_filters import UnknownStatusCategory, build_issue_filter
from app.common.issue_keys import current
from app.common.issue_links import create_link, list_links
from app.common.issue_rules import require_team_reader, visible_team_ids
from app.common.issue_writes import create_issue, list_issues, update_issue
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
)
from app.domains.integrations.mcp.transport import ToolError

SORTS: tuple[str, ...] = ("updated_desc", "created_desc", "key_asc", "priority_desc", "due_asc", "manual")

LINK_TYPES: tuple[str, ...] = ("blocks", "blocked_by", "relates_to", "duplicate_of")

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
    names = (
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
    )
    values: dict[str, Any] = {name: filter_values(call.optional(name)) for name in names}
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
    found too unless `include_archived` is false, as the app's search finds them.
    """
    query = str(call.optional("query", "") or "").strip().lower()
    team_id = call.optional("team_id")
    wanted = _build_filter(call, include_archived=True)

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
    reference = call.optional("issue_id") or call.optional("issue_key")
    if not reference:
        raise ToolError("Name either issue_id or issue_key")
    return _answer(call, issue_ref(call, reference))


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


def _link_json(link: LinkRead) -> dict[str, Any]:
    """One relation as the tools answer it, the far side named by id and key."""
    return {
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
        schema=object_schema(
            {
                "issue_id": string("The issue's id"),
                "issue_key": string("The issue's key, such as ABC-123"),
            }
        ),
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
                "status_id": string("The starting status"),
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
                "status_id": string("A new status of the same team"),
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
            "The inverse is recorded on the target. Idempotent on the same pair and type."
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
)
