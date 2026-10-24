"""The MCP tools for saved views, notifications and the inbox.

Saved view writes run the view routes' own `app.common.saved_views` path: a
personal view is its owner's alone, a team view needs team membership to create
and its owner or a team admin to change or delete. The inbox tools run the inbox
routes' `app.common.inbox` path, which builds the partition from the credential's
own user, so no argument can reach another member's notifications. The issue
reminder tools run `app.common.issue_reminders` the same way, so a reminder is
always the caller's own.
"""

from __future__ import annotations

from typing import Any, Optional, get_args

from fastapi import HTTPException

from app.common.api.dependencies.authz import Capability, check_capability
from app.common.api.schemas.projects_display import PROJECTS_COLUMNS, PROJECTS_DISPLAY_FIELDS
from app.common.api.schemas.views import (
    COMPLETED_WINDOWS,
    VIEW_ENTITIES,
    VISIBLE_PROPERTIES,
    GroupByField,
    InboxClearRequest,
    InboxReadRequest,
    InboxSnoozeRequest,
    InboxUnreadRequest,
    IssueReminderWrite,
    LayoutField,
    SortField,
    ViewColorField,
    ViewCreate,
    ViewRead,
    ViewUpdate,
)
from app.common.db.dynamo.views import SavedView
from app.common.inbox import (
    INBOX_KINDS,
    clear_notifications,
    delete_notification,
    list_notifications,
    mark_read,
    mark_unread,
    snooze,
)
from app.common.issue_reminders import cancel_reminder, list_reminders, set_reminder
from app.common.saved_views import (
    create_saved_view,
    delete_saved_view,
    load_visible_view,
    readable_views,
    update_saved_view,
)
from app.domains.integrations.mcp.toolkit import (
    NOT_VISIBLE,
    Tool,
    ToolCall,
    enum,
    filter_values,
    issue_ref,
    limit,
    object_schema,
    one_or_many,
    page_properties,
    string,
    team_id_ref,
)
from app.domains.integrations.mcp.transport import ToolError

SORTS: tuple[str, ...] = get_args(SortField)

LAYOUTS: tuple[str, ...] = get_args(LayoutField)

GROUPINGS: tuple[str, ...] = get_args(GroupByField)

VIEW_COLORS: tuple[str, ...] = get_args(ViewColorField)

VIEW_FIELDS: tuple[str, ...] = (
    "name",
    "filter",
    "sort",
    "group_by",
    "sub_group_by",
    "ordering",
    "ordering_reversed",
    "visible_properties",
    "layout",
    "show_sub_issues",
    "show_completed",
    "completed_window",
    "show_archived",
    "projects_display",
    "icon",
    "color",
    "description",
)

CLEARABLE_VIEW_FIELDS: tuple[str, ...] = (
    "group_by",
    "sub_group_by",
    "ordering",
    "visible_properties",
    "icon",
    "color",
    "description",
)
"""The view fields an update clears by passing null."""


def _projects_display() -> dict[str, Any]:
    """The projects arrangement a project view keeps, each field one of the projects page's choices."""
    return {
        "type": "object",
        "properties": {
            **{field: {"type": "string", "enum": list(choices)} for field, choices in PROJECTS_DISPLAY_FIELDS.items()},
            "columns": {
                "type": "array",
                "items": {"type": "string", "enum": list(PROJECTS_COLUMNS)},
                "description": "The properties shown beside the name; an empty list shows the name alone",
            },
        },
        "additionalProperties": False,
        "description": (
            "Project views only: layout (list, board, timeline), group and its direction, rows (a second "
            "grouping inside each group), order, closed (all, fortnight by default, month or none: which "
            "completed projects show, canceled ones only under all), "
            "lead_team (lead keeps only projects the filtered team leads), empty (show or hide empty board "
            "columns), the timeline zoom and the shown properties; a missing field takes the default"
        ),
    }


def _boolean(description: str) -> dict[str, Any]:
    """A boolean property carrying its description."""
    return {"type": "boolean", "description": description}


def _grouping(description: str, *, clearable: bool = False) -> dict[str, Any]:
    """A grouping property, taking null too where an update may clear it."""
    kind: Any = ["string", "null"] if clearable else "string"
    values: list[Any] = [*GROUPINGS, None] if clearable else list(GROUPINGS)
    return {"type": kind, "enum": values, "description": description}


def _view_properties(*, clearable: bool) -> dict[str, Any]:
    """The saved view fields create and update share."""
    ordering = enum(SORTS, "Manual ordering mode within groups")
    properties_list: dict[str, Any] = {
        "type": "array",
        "items": {"type": "string", "enum": list(VISIBLE_PROPERTIES)},
        "description": "Row properties to show, in order",
    }
    if clearable:
        ordering = {"type": ["string", "null"], "enum": [*SORTS, None], "description": "Ordering, null clears it"}
        properties_list = {**properties_list, "type": ["array", "null"], "description": "Row properties, null resets"}
    return {
        "name": string("The view name, up to 80 characters"),
        "filter": {
            "type": "object",
            "description": (
                "The issue filter, keyed as list_issues takes it (team_id, team_id_in, status_id, "
                "status_category, assignee_id, creator_id, subscriber_id, label_id, label_id_all, priority, "
                "parent_id, cycle_id, project_id, project_milestone_id, estimate, sla_status, has_relation, "
                "due_before, due_after, created_after, created_before, updated_after, updated_before, "
                "completed_after, completed_before, customer_id, content, q and their _not forms, plus is_blocked, "
                "is_blocking and has_sub_issues as true or false). Values are ids or lists of ids; assignee_id, "
                "creator_id and subscriber_id may be 'me'. match is all (default) or any, and groups is a list "
                "of condition objects with these same keys and their own match, each counting as one condition, "
                "and a group may hold groups of its own, two levels at most. A project view's filter instead "
                "takes team_id, status (project statuses such as planned or in_progress), lead_id (user ids, "
                "'none' for no lead), customer_id and customer_id_not (customer ids, 'none' for no customer "
                "request), and sub_teams, is_blocked and is_blocking, each as true or false."
            ),
        },
        "sort": enum(SORTS, "Sort order"),
        "layout": enum(LAYOUTS, "list or board"),
        "group_by": _grouping("Group rows by this property", clearable=clearable),
        "sub_group_by": _grouping("Sub group within each group, needs group_by", clearable=clearable),
        "ordering": ordering,
        "ordering_reversed": _boolean("Reverse the sort direction, keeping issues without the value last"),
        "visible_properties": properties_list,
        "show_sub_issues": _boolean("Show sub-issues"),
        "show_completed": _boolean("Show completed issues, all of them or none"),
        "completed_window": enum(
            COMPLETED_WINDOWS,
            "Completed and cancelled issues to show: all, past_week, past_month or none; wins over show_completed",
        ),
        "show_archived": _boolean("Show archived issues"),
        "projects_display": _projects_display(),
        "icon": {"type": ["string", "null"] if clearable else "string", "description": "Icon name for the view"},
        "color": {
            "type": ["string", "null"] if clearable else "string",
            "enum": [*VIEW_COLORS, None] if clearable else list(VIEW_COLORS),
            "description": "Icon color",
        },
        "description": {
            "type": ["string", "null"] if clearable else "string",
            "description": "A short description, up to 500 characters",
        },
    }


def _flag(call: ToolCall, name: str) -> bool:
    """One boolean argument, false when absent, refusing anything that is not a boolean."""
    value = call.optional(name, False)
    if not isinstance(value, bool):
        raise ToolError(f"{name} must be true or false")
    return value


def _workspace_member(call: ToolCall) -> None:
    """Hold the capability every view and inbox route declares."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_READ)


def _view_json(view: SavedView) -> dict[str, Any]:
    """One saved view as the view routes answer it."""
    return ViewRead.from_row(view).model_dump(mode="json")


def view_ref(call: ToolCall, value: Any) -> SavedView:
    """One readable saved view named by its id or its exact name.

    A name resolves only when exactly one readable view carries it, so an agent
    never edits the wrong one of two views that happen to share a name.
    """
    reference = str(value).strip()
    if not reference:
        raise ToolError("view_id is required")
    try:
        return load_visible_view(call.repositories, call.context, reference)
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
    folded = reference.casefold()
    rows = readable_views(call.repositories, call.context, "all", None)
    named = [row for row in rows if row.name.casefold() == folded]
    if len(named) > 1:
        raise ToolError(f"More than one view is named {reference}; pass its view_id")
    if not named:
        raise ToolError(NOT_VISIBLE)
    return named[0]


def _view_fields(call: ToolCall) -> dict[str, Any]:
    """The view fields this call named, nulls kept so an update can clear them."""
    return {name: call.arguments[name] for name in VIEW_FIELDS if call.present(name)}


def _create_view(call: ToolCall) -> Any:
    """Save a new view, personal unless a team is named, as the view route does."""
    _workspace_member(call)
    fields = _view_fields(call)
    if call.present("entity"):
        fields["entity"] = call.arguments["entity"]
    team = call.optional("team_id")
    if team is not None:
        fields["team_id"] = team_id_ref(call, team)
    elif _flag(call, "shared"):
        fields["shared"] = True
    if fields.get("layout"):
        fields["kind"] = fields["layout"]
    payload = ViewCreate.model_validate(fields)
    return _view_json(create_saved_view(call.repositories, call.context, payload))


def _update_view(call: ToolCall) -> Any:
    """Change the named fields of a view the caller owns, or of a team view they administer."""
    _workspace_member(call)
    view = view_ref(call, call.require("view_id"))
    fields = _view_fields(call)
    for name in fields:
        if fields[name] is None and name not in CLEARABLE_VIEW_FIELDS:
            raise ToolError(f"{name} cannot be null")
    if call.present("shared"):
        fields["shared"] = _flag(call, "shared")
    payload = ViewUpdate.model_validate(fields)
    return _view_json(update_saved_view(call.repositories, call.context, view.view_id, payload))


def _delete_view(call: ToolCall) -> Any:
    """Delete a view the caller owns, or a team view they administer."""
    _workspace_member(call)
    view = view_ref(call, call.require("view_id"))
    removed = delete_saved_view(call.repositories, call.context, view.view_id)
    return {"deleted": True, "view_id": removed.view_id, "name": removed.name}


def _ids(call: ToolCall) -> Optional[list[str]]:
    """The notification ids argument as a list, whichever shape the agent sent."""
    return filter_values(call.require("notification_ids"))


def _list_notifications(call: ToolCall) -> Any:
    """One page of the caller's inbox, newest first, with the unread badge count."""
    _workspace_member(call)
    items, next_cursor = list_notifications(
        call.repositories,
        call.context,
        unread=_flag(call, "unread"),
        snoozed=_flag(call, "snoozed"),
        include_snoozed=_flag(call, "include_snoozed"),
        kinds=filter_values(call.optional("kinds")) or [],
        cursor=call.optional("cursor"),
        limit=limit(call.optional("limit")),
    )
    return {
        "notifications": [row.model_dump(mode="json") for row in items],
        "next_cursor": next_cursor,
        "unread_count": call.repositories.inbox.unread_count(call.context.workspace_id, call.context.user_id),
    }


def _mark_read(call: ToolCall) -> Any:
    """Mark some of the caller's notifications read."""
    _workspace_member(call)
    payload = InboxReadRequest.model_validate({"notification_ids": _ids(call)})
    return {"updated": mark_read(call.repositories, call.context, payload)}


def _mark_all_read(call: ToolCall) -> Any:
    """Mark every one of the caller's notifications read."""
    _workspace_member(call)
    return {"updated": mark_read(call.repositories, call.context, InboxReadRequest(all=True))}


def _mark_unread(call: ToolCall) -> Any:
    """Mark some of the caller's notifications unread again, ending any snooze."""
    _workspace_member(call)
    payload = InboxUnreadRequest.model_validate({"notification_ids": _ids(call)})
    return {"updated": mark_unread(call.repositories, call.context, payload)}


def _snooze(call: ToolCall) -> Any:
    """Hide some of the caller's notifications until a moment, when they return unread."""
    _workspace_member(call)
    payload = InboxSnoozeRequest.model_validate({"notification_ids": _ids(call), "until": call.require("until")})
    return {"updated": snooze(call.repositories, call.context, payload), "until": payload.until.isoformat()}


def _delete_notification(call: ToolCall) -> Any:
    """Delete one of the caller's own notifications."""
    _workspace_member(call)
    notification_id = str(call.require("notification_id"))
    delete_notification(call.repositories, call.context, notification_id)
    return {"deleted": True, "notification_id": notification_id}


def _clear_notifications(call: ToolCall) -> Any:
    """Delete the caller's own notifications in bulk, the read ones or all of them."""
    _workspace_member(call)
    payload = InboxClearRequest(
        read_only=_flag(call, "read_only"),
        include_snoozed=_flag(call, "include_snoozed"),
        kinds=filter_values(call.optional("kinds")) or [],
    )
    return {"deleted": clear_notifications(call.repositories, call.context, payload)}


def _set_issue_reminder(call: ToolCall) -> Any:
    """Remind the caller about one issue at a moment, replacing any reminder already set on it."""
    _workspace_member(call)
    issue = issue_ref(call, call.require("issue_id"))
    payload = IssueReminderWrite.model_validate({"remind_at": call.require("remind_at")})
    return set_reminder(call.repositories, call.context, issue.issue_id, payload).model_dump(mode="json")


def _list_issue_reminders(call: ToolCall) -> Any:
    """The caller's pending issue reminders, soonest first, or the one on one issue."""
    _workspace_member(call)
    reference = call.optional("issue_id")
    issue_id = issue_ref(call, reference).issue_id if reference else None
    items = list_reminders(call.repositories, call.context, issue_id)
    return {"reminders": [item.model_dump(mode="json") for item in items]}


def _cancel_issue_reminder(call: ToolCall) -> Any:
    """Cancel the caller's pending reminder on one issue."""
    _workspace_member(call)
    issue = issue_ref(call, call.require("issue_id"))
    cancel_reminder(call.repositories, call.context, issue.issue_id)
    return {"cancelled": True, "issue_id": issue.issue_id}


ISSUE_REF = string("The issue: its issue_id, or its key such as ENG-12")

VIEW_REF = string("The view: its view_id, or its exact name when only one readable view has it")

NOTIFICATION_IDS = one_or_many("One notification_id or a list of up to 100, as list_notifications answers them")

VIEW_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="create_view",
        description=(
            "Save a view: personal by default, shared on a team with team_id (team: id, key such as ENG, "
            "or name; needs team membership), or shared with the workspace with shared=true. Stores an issue "
            "filter, sort, layout and display settings, or with entity=projects a projects filter and "
            "projects_display."
        ),
        scopes=("views:write",),
        schema=object_schema(
            {
                **_view_properties(clearable=False),
                "entity": enum(VIEW_ENTITIES, "What the view lists, issues (the default) or projects"),
                "team_id": string("Share on this team: id, key or name"),
                "shared": _boolean("Share with the whole workspace when no team is named"),
            },
            required=("name",),
        ),
        handler=_create_view,
    ),
    Tool(
        name="update_view",
        description=(
            "Change a saved view's name, filter, sort, layout, grouping or display settings. Only named fields "
            "change. shared=true moves a view without a team to the whole workspace, shared=false back to you. "
            "Your own views, any view on a team you administer, or any workspace view if you are an admin."
        ),
        scopes=("views:write",),
        schema=object_schema(
            {
                "view_id": VIEW_REF,
                **_view_properties(clearable=True),
                "shared": _boolean("Share a view without a team with the whole workspace, or false to make it yours"),
            },
            required=("view_id",),
        ),
        handler=_update_view,
    ),
    Tool(
        name="delete_view",
        description=(
            "Permanently delete a saved view: its filter and display settings are lost for everyone who uses it. "
            "Your own views, or any view on a team you administer. Issues are untouched."
        ),
        scopes=("views:write",),
        schema=object_schema({"view_id": VIEW_REF}, required=("view_id",)),
        handler=_delete_view,
        destructive=True,
    ),
    Tool(
        name="list_notifications",
        description=(
            "The caller's inbox, newest first, with the unread count. unread=true lists only unread, "
            "snoozed=true only snoozed ones (not both). Snoozed notifications are hidden until they return "
            "unless include_snoozed=true. kinds keeps only those kinds. Each row's summary says who changed "
            "what, such as 'Olive moved to Done', and new_value holds the status a change moved to."
        ),
        scopes=("notifications:read",),
        schema=object_schema(
            {
                "unread": _boolean("Only unread notifications"),
                "snoozed": _boolean("Only snoozed notifications"),
                "include_snoozed": _boolean("Keep snoozed notifications in the list"),
                "kinds": one_or_many("One notification kind or a list, ORed: " + ", ".join(INBOX_KINDS)),
                **page_properties(),
            }
        ),
        handler=_list_notifications,
    ),
    Tool(
        name="mark_notification_read",
        description="Mark one or more of your notifications read. Answers how many changed; unknown ids change none.",
        scopes=("notifications:write",),
        schema=object_schema({"notification_ids": NOTIFICATION_IDS}, required=("notification_ids",)),
        handler=_mark_read,
    ),
    Tool(
        name="mark_notification_unread",
        description="Mark one or more of your notifications unread again, ending any snooze. Answers how many changed.",
        scopes=("notifications:write",),
        schema=object_schema({"notification_ids": NOTIFICATION_IDS}, required=("notification_ids",)),
        handler=_mark_unread,
    ),
    Tool(
        name="mark_all_notifications_read",
        description="Mark every notification in your inbox read. Answers how many changed.",
        scopes=("notifications:write",),
        schema=object_schema({}),
        handler=_mark_all_read,
    ),
    Tool(
        name="snooze_notification",
        description=(
            "Hide one or more of your notifications until a moment, when they return unread. until is an "
            "ISO 8601 time with a timezone, such as 2026-10-01T09:00:00Z, at least a minute out and within 90 days."
        ),
        scopes=("notifications:write",),
        schema=object_schema(
            {"notification_ids": NOTIFICATION_IDS, "until": string("When they return, ISO 8601 with a timezone")},
            required=("notification_ids", "until"),
        ),
        handler=_snooze,
    ),
    Tool(
        name="delete_notification",
        description="Permanently delete one of your notifications from your inbox. The issue itself is untouched.",
        scopes=("notifications:write",),
        schema=object_schema(
            {"notification_id": string("The notification_id to delete")}, required=("notification_id",)
        ),
        handler=_delete_notification,
        destructive=True,
    ),
    Tool(
        name="delete_all_notifications",
        description=(
            "Permanently delete your notifications in bulk. read_only=true deletes only read ones; otherwise "
            "every one goes except those still snoozed, unless include_snoozed=true. kinds keeps to those kinds. "
            "Answers how many were deleted. Issues are untouched."
        ),
        scopes=("notifications:write",),
        schema=object_schema(
            {
                "read_only": _boolean("Only notifications already read"),
                "include_snoozed": _boolean("Also delete notifications still snoozed"),
                "kinds": one_or_many("One notification kind or a list, ORed: " + ", ".join(INBOX_KINDS)),
            }
        ),
        handler=_clear_notifications,
        destructive=True,
    ),
    Tool(
        name="set_issue_reminder",
        description=(
            "Remind yourself about an issue: at remind_at a reminder notification for it lands in your inbox, "
            "and by email when your reminder emails are on. remind_at is an ISO 8601 time with a timezone, "
            "such as 2026-10-01T09:00:00-07:00, at least a minute out and within 365 days. One reminder per "
            "issue; setting another replaces it. Only you see it."
        ),
        scopes=("notifications:write",),
        schema=object_schema(
            {"issue_id": ISSUE_REF, "remind_at": string("When to be reminded, ISO 8601 with a timezone")},
            required=("issue_id", "remind_at"),
        ),
        handler=_set_issue_reminder,
    ),
    Tool(
        name="list_issue_reminders",
        description="Your pending issue reminders, soonest first, or only the one on issue_id when it is given.",
        scopes=("notifications:read",),
        schema=object_schema({"issue_id": ISSUE_REF}),
        handler=_list_issue_reminders,
    ),
    Tool(
        name="cancel_issue_reminder",
        description="Cancel your pending reminder on an issue. Errors when no reminder is pending on it.",
        scopes=("notifications:write",),
        schema=object_schema({"issue_id": ISSUE_REF}, required=("issue_id",)),
        handler=_cancel_issue_reminder,
    ),
)
