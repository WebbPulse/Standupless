"""The MCP tools for dashboards: insight widgets from several teams and views on one page.

Every tool runs the dashboard routes' own `app.common.dashboards` path, so a
personal dashboard stays its owner's alone, a team or workspace one is changed
by its owner or an admin, and widget data is counted with the caller's own
visibility.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from app.common.api.dependencies.authz import Capability, check_capability
from app.common.api.schemas.dashboards import DashboardCreate, DashboardMove, DashboardUpdate, WidgetCreate
from app.common.api.schemas.insights import INSIGHT_DIMENSIONS, INSIGHT_MEASURES
from app.common.dashboards import (
    LISTING_SCOPES,
    create_dashboard,
    dashboard_data,
    dashboard_read,
    delete_dashboard,
    load_dashboard,
    move_dashboard,
    readable_dashboards,
    replace_widgets,
    update_dashboard,
)
from app.common.db.dynamo.dashboards import DASHBOARD_SCOPES, WIDGET_KINDS, WIDGET_SIZES, WIDGET_SOURCES, Dashboard
from app.common.plan_features import Feature, enforce_feature
from app.domains.integrations.mcp.toolkit import NOT_VISIBLE, Tool, ToolCall, enum, object_schema, string, team_id_ref
from app.domains.integrations.mcp.transport import ToolError
from app.domains.integrations.mcp.view_tools import view_ref

DASHBOARD_REF = string("The dashboard: its id or its exact name")

FILTER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": (
        "An issue filter keyed as a saved view's filter is (status_id, status_category, assignee_id, label_id, "
        "priority, project_id, cycle_id, team_id and the rest, with _not forms, match and groups); "
        "assignee_id, creator_id and subscriber_id may be 'me'"
    ),
}

WIDGET_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "widget_id": string("An existing widget's id, to keep it; leave out for a new widget"),
        "kind": enum(WIDGET_KINDS, "chart (bars), table (rows per group) or metric (one number)"),
        "title": string("The widget title; the measure and grouping when left out"),
        "source": enum(WIDGET_SOURCES, "Where the issues come from: the whole workspace, one team or a saved view"),
        "team_id": string("For a team source: id, key or name"),
        "view_id": string("For a view source: a saved issue view's id or exact name"),
        "include_sub_teams": {"type": "boolean", "description": "For a team source, roll its sub-teams in"},
        "filter": FILTER_SCHEMA,
        "group_by": enum(INSIGHT_DIMENSIONS, "Group by this dimension, status by default"),
        "segment_by": enum(INSIGHT_DIMENSIONS, "Split each group by a second dimension"),
        "measure": enum(INSIGHT_MEASURES, "What to measure, count by default"),
        "size": enum(WIDGET_SIZES, "half or full width"),
    },
    "additionalProperties": False,
}

WIDGETS_SCHEMA: dict[str, Any] = {
    "type": "array",
    "items": WIDGET_SCHEMA,
    "description": "The widgets in display order, at most 24",
}


def _member(call: ToolCall) -> None:
    """Hold the capability every dashboard route declares, in a workspace whose plan includes Insights."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_READ)
    enforce_feature(call.repositories, call.context.workspace_id, Feature.INSIGHTS)


def _json(call: ToolCall, dashboard: Dashboard) -> dict[str, Any]:
    """One dashboard as the dashboard routes answer it."""
    return dashboard_read(call.repositories, call.context, dashboard).model_dump(mode="json")


def dashboard_ref(call: ToolCall, value: Any) -> Dashboard:
    """One readable dashboard named by its id or by an exact name only one readable dashboard carries."""
    reference = str(value).strip()
    if not reference:
        raise ToolError("dashboard_id is required")
    try:
        return load_dashboard(call.repositories, call.context, reference)
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
    folded = reference.casefold()
    named = [row for row in readable_dashboards(call.repositories, call.context) if row.name.casefold() == folded]
    if len(named) > 1:
        raise ToolError(f"More than one dashboard is named {reference}; pass its dashboard_id")
    if not named:
        raise ToolError(NOT_VISIBLE)
    return named[0]


def _widgets(call: ToolCall) -> list[dict[str, Any]]:
    """The widgets argument with each team and view reference resolved to its id."""
    value = call.optional("widgets", [])
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise ToolError("widgets must be a list of widget objects")
    resolved: list[dict[str, Any]] = []
    for item in value:
        widget = dict(item)
        if isinstance(widget.get("team_id"), str) and widget["team_id"].strip():
            widget["team_id"] = team_id_ref(call, widget["team_id"])
        if isinstance(widget.get("view_id"), str) and widget["view_id"].strip():
            widget["view_id"] = view_ref(call, widget["view_id"]).view_id
        resolved.append(widget)
    return resolved


def _list_dashboards(call: ToolCall) -> Any:
    """The dashboards the caller may read, their own first."""
    _member(call)
    scope = str(call.optional("scope", "all"))
    team = call.optional("team_id")
    rows = readable_dashboards(call.repositories, call.context, scope, str(team) if team else None)
    return {
        "dashboards": [
            {
                "id": row.dashboard_id,
                "name": row.name,
                "scope": row.scope,
                "team_id": row.team_id,
                "owner_id": row.owner_id,
                "widget_count": len(row.widgets),
            }
            for row in rows
        ]
    }


def _get_dashboard(call: ToolCall) -> Any:
    """One dashboard with its widgets, and with include_data each widget's breakdown."""
    _member(call)
    dashboard = dashboard_ref(call, call.require("dashboard_id"))
    body = _json(call, dashboard)
    if call.optional("include_data", False) is True:
        data, errors = dashboard_data(call.repositories, call.context, dashboard)
        body["data"] = {widget_id: insights.model_dump(mode="json") for widget_id, insights in data.items()}
        body["errors"] = errors
    return body


def _create_dashboard(call: ToolCall) -> Any:
    """Save a new dashboard owned by the caller."""
    _member(call)
    fields = {
        name: call.arguments[name] for name in ("name", "description", "icon", "scope", "filter") if call.present(name)
    }
    team = call.optional("team_id")
    if team:
        fields["team_id"] = team
        fields.setdefault("scope", "team")
    fields["widgets"] = [WidgetCreate.model_validate(widget) for widget in _widgets(call)]
    payload = DashboardCreate.model_validate(fields)
    return _json(call, create_dashboard(call.repositories, call.context, payload))


def _update_dashboard(call: ToolCall) -> Any:
    """Change a dashboard's fields, move it, hand it to a new owner or replace its widgets."""
    _member(call)
    dashboard = dashboard_ref(call, call.require("dashboard_id"))
    fields = {
        name: call.arguments[name]
        for name in ("name", "description", "icon", "filter", "owner_id")
        if call.present(name)
    }
    if fields.get("owner_id") == "me":
        fields["owner_id"] = call.context.user_id
    if fields:
        dashboard = update_dashboard(
            call.repositories, call.context, dashboard.dashboard_id, DashboardUpdate.model_validate(fields)
        )
    if call.present("scope") or call.present("team_id"):
        team = call.optional("team_id")
        scope = call.optional("scope", "team" if team else dashboard.scope)
        move = DashboardMove.model_validate({"scope": scope, "team_id": team})
        dashboard = move_dashboard(call.repositories, call.context, dashboard.dashboard_id, move)
    if call.present("widgets"):
        dashboard = replace_widgets(call.repositories, call.context, dashboard.dashboard_id, _widgets(call))
    return _json(call, dashboard)


def _delete_dashboard(call: ToolCall) -> Any:
    """Delete a dashboard the caller may change."""
    _member(call)
    dashboard = dashboard_ref(call, call.require("dashboard_id"))
    removed = delete_dashboard(call.repositories, call.context, dashboard.dashboard_id)
    return {"deleted": True, "dashboard_id": removed.dashboard_id, "name": removed.name}


DASHBOARD_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_dashboards",
        description=(
            "List the dashboards you can read: your personal ones first, then team and workspace dashboards. "
            "scope narrows to personal, team or workspace, and team_id (id, key or name) to one team's."
        ),
        scopes=("views:read",),
        schema=object_schema(
            {
                "scope": enum(LISTING_SCOPES, "Which dashboards, all by default"),
                "team_id": string("Only this team's dashboards, plus your own: id, key or name"),
            }
        ),
        handler=_list_dashboards,
    ),
    Tool(
        name="get_dashboard",
        description=(
            "Read one dashboard: its scope, owner, shared filter and widgets in order. With include_data=true "
            "each widget's breakdown is included under data, keyed by widget_id, counted with your visibility; "
            "a widget you cannot read is listed under errors instead."
        ),
        scopes=("views:read", "issues:read"),
        schema=object_schema(
            {
                "dashboard_id": DASHBOARD_REF,
                "include_data": {"type": "boolean", "description": "Include each widget's breakdown"},
            },
            required=("dashboard_id",),
        ),
        handler=_get_dashboard,
    ),
    Tool(
        name="create_dashboard",
        description=(
            "Create a dashboard you own: personal by default, scope=team with team_id (needs team membership) "
            "or scope=workspace. filter applies to every widget on top of each widget's own filter. Each widget "
            "reads the workspace, one team or one saved issue view and draws a chart, table or metric."
        ),
        scopes=("views:write",),
        schema=object_schema(
            {
                "name": string("The dashboard name, up to 80 characters"),
                "description": string("A short description, up to 500 characters"),
                "icon": string("Icon name"),
                "scope": enum(DASHBOARD_SCOPES, "personal (the default), team or workspace"),
                "team_id": string("For a team dashboard: id, key or name"),
                "filter": FILTER_SCHEMA,
                "widgets": WIDGETS_SCHEMA,
            },
            required=("name",),
        ),
        handler=_create_dashboard,
    ),
    Tool(
        name="update_dashboard",
        description=(
            "Change a dashboard: name, description, icon, its shared filter, or owner_id (a workspace member, "
            "'me' for you; personal dashboards move to a team or the workspace first). scope and team_id move "
            "it; only the owner may make it personal. widgets replaces the whole widget list in order: a widget "
            "with an existing widget_id keeps it and changes only the fields named, others are added, and "
            "widgets left out are removed. Your own dashboards, or shared ones you administer."
        ),
        scopes=("views:write",),
        schema=object_schema(
            {
                "dashboard_id": DASHBOARD_REF,
                "name": string("The new name"),
                "description": {"type": ["string", "null"], "description": "A short description, null clears it"},
                "icon": {"type": ["string", "null"], "description": "Icon name, null clears it"},
                "filter": FILTER_SCHEMA,
                "owner_id": string("The new owner's user id, or 'me'"),
                "scope": enum(DASHBOARD_SCOPES, "Move to personal, team or workspace"),
                "team_id": string("Move to this team: id, key or name"),
                "widgets": WIDGETS_SCHEMA,
            },
            required=("dashboard_id",),
        ),
        handler=_update_dashboard,
    ),
    Tool(
        name="delete_dashboard",
        description=(
            "Permanently delete a dashboard and its widgets for everyone who uses it. Issues and saved views "
            "are untouched. Your own dashboards, or shared ones you administer."
        ),
        scopes=("views:write",),
        schema=object_schema({"dashboard_id": DASHBOARD_REF}, required=("dashboard_id",)),
        handler=_delete_dashboard,
        destructive=True,
    ),
)
