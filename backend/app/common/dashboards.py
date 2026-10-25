"""Dashboard reads and writes, shared by the dashboard routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and who may read or change a dashboard is decided once. Visibility follows
scope the way a saved view's does: a personal dashboard is its owner's alone, a
team dashboard is read by whoever can see the team, and a workspace dashboard by
every member but a guest. Changing one is its owner's call, a team admin's for a
team dashboard and a workspace admin's for a team or workspace one.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, Sequence

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common import audit
from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.dashboards import (
    DASHBOARD_WIDGETS_MAX,
    DashboardCreate,
    DashboardMove,
    DashboardRead,
    DashboardUpdate,
    WidgetCreate,
    WidgetUpdate,
)
from app.common.api.schemas.insights import InsightsRead
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.dashboards import Dashboard, DashboardWidget, dashboard_key_for, new_dashboard_id
from app.common.insights import combined_insights
from app.common.issue_rules import (
    not_found,
    require_team_member,
    require_team_reader,
    team_role,
    unprocessable,
    visible_team_ids,
)
from app.common.saved_views import FORBIDDEN, check_filter, load_visible_view, require_issue_view

CLEARABLE: frozenset[str] = frozenset({"title", "segment_by", "team_id", "view_id"})
"""The widget fields a null clears rather than leaves alone."""

LISTING_SCOPES: tuple[str, ...] = ("all", "personal", "team", "workspace")
"""Which dashboards a listing may narrow to."""


def forbidden() -> HTTPException:
    """The 403 a caller gets for a dashboard they can read but not change."""
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=FORBIDDEN)


def can_edit(repositories: Repositories, context: AuthzContext, dashboard: Dashboard) -> bool:
    """Whether the caller may change one dashboard they can read."""
    if dashboard.owner_id == context.user_id:
        return True
    if dashboard.scope == "workspace":
        return context.is_workspace_admin
    if dashboard.scope == "team" and dashboard.team_id:
        return context.is_workspace_admin or team_role(repositories, context, dashboard.team_id) == "admin"
    return False


def require_dashboard_writer(repositories: Repositories, context: AuthzContext, dashboard: Dashboard) -> None:
    """Hold that the caller may change one dashboard, or 403."""
    if not can_edit(repositories, context, dashboard):
        raise forbidden()


def dashboard_read(repositories: Repositories, context: AuthzContext, dashboard: Dashboard) -> DashboardRead:
    """One dashboard as the caller reads it, with whether they may change it."""
    return DashboardRead.from_row(dashboard, can_edit=can_edit(repositories, context, dashboard))


def readable_dashboards(
    repositories: Repositories, context: AuthzContext, scope: str = "all", team_id: Optional[str] = None
) -> list[Dashboard]:
    """The dashboards the caller may read, narrowed by scope and team, personal ones first and each in name order.

    A team narrows to that team's dashboards and the caller's own; workspace
    dashboards are left out for a guest and whenever a team is named.
    """
    if scope not in LISTING_SCOPES:
        raise unprocessable(f"scope must be one of: {', '.join(LISTING_SCOPES)}")
    workspace_id = context.workspace_id
    personal: list[Dashboard] = []
    shared: list[Dashboard] = []
    if scope in ("all", "personal"):
        personal = repositories.views.list_personal_dashboards(workspace_id, context.user_id)
    if scope in ("all", "team"):
        if team_id:
            require_team_reader(repositories, context, team_id)
            teams = [team_id]
        else:
            teams = visible_team_ids(repositories, context)
        for candidate in teams:
            shared.extend(repositories.views.list_team_dashboards(workspace_id, candidate))
    if scope in ("all", "workspace") and not context.is_guest and not team_id:
        shared.extend(repositories.views.list_workspace_dashboards(workspace_id))
    return [*_by_name(personal), *_by_name(shared)]


def _by_name(rows: Sequence[Dashboard]) -> list[Dashboard]:
    """Dashboards in name order, ties broken by id."""
    return sorted(rows, key=lambda row: (row.name.lower(), row.dashboard_id))


def load_dashboard(repositories: Repositories, context: AuthzContext, dashboard_id: str) -> Dashboard:
    """One dashboard the caller may read, or a 404 that looks the same as an absent one."""
    found = repositories.views.find_dashboard(
        context.workspace_id,
        dashboard_id,
        context.user_id,
        visible_team_ids(repositories, context),
        workspace_shared=not context.is_guest,
    )
    if found is None:
        raise not_found()
    return found


def _require_scope_writer(
    repositories: Repositories, context: AuthzContext, scope: str, team_id: Optional[str]
) -> None:
    """Hold that the caller may file a dashboard in one scope: a team they write in, or the workspace if not a guest."""
    if scope == "team":
        if not team_id:
            raise unprocessable("A team dashboard needs team_id")
        require_team_member(repositories, context, team_id)
    elif team_id:
        raise unprocessable("team_id applies only to a team dashboard")
    if scope == "workspace" and context.is_guest:
        raise forbidden()


def widget_scope(
    repositories: Repositories, context: AuthzContext, widget: DashboardWidget
) -> tuple[Optional[str], Optional[str]]:
    """The team and view one widget reads, held to what the caller may read.

    A team source needs a team the caller can see and a view source an issue
    view they can read; a workspace source reads every team they can see.
    """
    if widget.source == "team":
        if not widget.team_id:
            raise unprocessable("A team widget needs team_id")
        require_team_reader(repositories, context, widget.team_id)
        return widget.team_id, None
    if widget.source == "view":
        if not widget.view_id:
            raise unprocessable("A view widget needs view_id")
        require_issue_view(load_visible_view(repositories, context, widget.view_id))
        return None, widget.view_id
    return None, None


def build_widget(repositories: Repositories, context: AuthzContext, payload: WidgetCreate) -> DashboardWidget:
    """A widget checked against what the caller may read, its source fields kept only where they apply."""
    widget = DashboardWidget(**payload.model_dump())
    return _checked_widget(repositories, context, widget)


def _checked_widget(repositories: Repositories, context: AuthzContext, widget: DashboardWidget) -> DashboardWidget:
    """Refuse a widget whose filter could not run or whose team or view the caller cannot read."""
    check_filter(widget.filter)
    if widget.segment_by is not None and widget.segment_by == widget.group_by:
        raise unprocessable("segment_by must differ from group_by")
    widget_scope(repositories, context, widget)
    if widget.source == "workspace":
        return widget.model_copy(update={"team_id": None, "view_id": None, "include_sub_teams": False})
    if widget.source == "team":
        return widget.model_copy(update={"view_id": None})
    return widget.model_copy(update={"team_id": None, "include_sub_teams": False})


def create_dashboard(repositories: Repositories, context: AuthzContext, payload: DashboardCreate) -> Dashboard:
    """Save a new dashboard owned by the caller, in the scope it names, with any widgets it brings."""
    _require_scope_writer(repositories, context, payload.scope, payload.team_id)
    check_filter(payload.filter)
    widgets = [build_widget(repositories, context, widget) for widget in payload.widgets]
    dashboard_id = new_dashboard_id()
    dashboard = Dashboard(
        workspace_id=context.workspace_id,
        view_key=dashboard_key_for(payload.scope, dashboard_id, owner_id=context.user_id, team_id=payload.team_id),
        dashboard_id=dashboard_id,
        name=payload.name,
        description=payload.description,
        icon=payload.icon,
        team_id=payload.team_id if payload.scope == "team" else None,
        owner_id=context.user_id,
        filter=dict(payload.filter),
        widgets=widgets,
    )
    try:
        repositories.views.create_dashboard(dashboard)
    except ConditionFailed as exc:
        raise unprocessable("That dashboard already exists") from exc
    audit.record(
        repositories,
        context,
        "dashboard.created",
        target_type="dashboard",
        target_id=dashboard.dashboard_id,
        target_label=dashboard.name,
        after=_where(dashboard),
    )
    return dashboard


def _where(dashboard: Dashboard) -> dict[str, Any]:
    """A dashboard's scope and team, as an audit event's before or after."""
    return {"scope": dashboard.scope, **({"team_id": dashboard.team_id} if dashboard.team_id else {})}


def _save(repositories: Repositories, context: AuthzContext, dashboard: Dashboard, **changes: Any) -> Dashboard:
    """Write the named fields of one dashboard, a 404 when it went in the meantime."""
    updated = repositories.views.update_dashboard(context.workspace_id, dashboard.view_key, **changes)
    if updated is None:
        raise not_found()
    return updated


def update_dashboard(
    repositories: Repositories, context: AuthzContext, dashboard_id: str, payload: DashboardUpdate
) -> Dashboard:
    """Change a dashboard's name, description, icon, shared filter or owner."""
    dashboard = load_dashboard(repositories, context, dashboard_id)
    require_dashboard_writer(repositories, context, dashboard)
    changes = payload.model_dump(exclude_unset=True)
    if "name" in changes and changes["name"] is None:
        raise unprocessable("name cannot be null")
    if "filter" in changes:
        if changes["filter"] is None:
            changes["filter"] = {}
        check_filter(changes["filter"])
    if changes.get("icon") == "":
        changes["icon"] = None
    owner = changes.pop("owner_id", None)
    if owner is not None and owner != dashboard.owner_id:
        _check_new_owner(repositories, context, dashboard, owner)
        changes["owner_id"] = owner
    if not changes:
        return dashboard
    updated = _save(repositories, context, dashboard, **changes)
    if "owner_id" in changes:
        audit.record(
            repositories,
            context,
            "dashboard.owner_changed",
            target_type="dashboard",
            target_id=updated.dashboard_id,
            target_label=updated.name,
            before={"owner_id": dashboard.owner_id},
            after={"owner_id": updated.owner_id},
        )
    return updated


def _check_new_owner(repositories: Repositories, context: AuthzContext, dashboard: Dashboard, owner: str) -> None:
    """Hold that a dashboard may pass to this member: a shared one, to someone who can read it."""
    if dashboard.scope == "personal":
        raise unprocessable("Move a personal dashboard to a team or the workspace before changing its owner")
    membership = repositories.memberships.get(context.workspace_id, owner)
    if membership is None:
        raise unprocessable("The new owner must be a member of this workspace")
    if membership.role == "guest":
        team = dashboard.team_id
        if team is None or repositories.memberships.get_team_membership(context.workspace_id, team, owner) is None:
            raise unprocessable("The new owner cannot read this dashboard")
    if dashboard.team_id and repositories.memberships.is_private_team(context.workspace_id, dashboard.team_id):
        if repositories.memberships.get_team_membership(context.workspace_id, dashboard.team_id, owner) is None:
            raise unprocessable("The new owner cannot read this dashboard")


def move_dashboard(
    repositories: Repositories, context: AuthzContext, dashboard_id: str, payload: DashboardMove
) -> Dashboard:
    """Move a dashboard between its owner, a team and the whole workspace, keeping its id.

    The scope lives in the sort key, so the row is written under its new key and
    the old one removed. Only the owner may take a dashboard back to personal, so
    nobody else's dashboard disappears into theirs.
    """
    dashboard = load_dashboard(repositories, context, dashboard_id)
    require_dashboard_writer(repositories, context, dashboard)
    team_id = payload.team_id if payload.scope == "team" else None
    _require_scope_writer(repositories, context, payload.scope, payload.team_id)
    if payload.scope == dashboard.scope and team_id == dashboard.team_id:
        return dashboard
    if payload.scope == "personal" and dashboard.owner_id != context.user_id:
        raise forbidden()
    moved = dashboard.model_copy(
        update={
            "view_key": dashboard_key_for(
                payload.scope, dashboard.dashboard_id, owner_id=dashboard.owner_id, team_id=team_id
            ),
            "team_id": team_id,
            "updated_at": utc_now(),
        }
    )
    repositories.views.create_dashboard(moved)
    repositories.views.delete_dashboard(context.workspace_id, dashboard.view_key)
    audit.record(
        repositories,
        context,
        "dashboard.moved",
        target_type="dashboard",
        target_id=moved.dashboard_id,
        target_label=moved.name,
        before=_where(dashboard),
        after=_where(moved),
    )
    return moved


def delete_dashboard(repositories: Repositories, context: AuthzContext, dashboard_id: str) -> Dashboard:
    """Remove a dashboard the caller may change, answering the row removed."""
    dashboard = load_dashboard(repositories, context, dashboard_id)
    require_dashboard_writer(repositories, context, dashboard)
    repositories.views.delete_dashboard(context.workspace_id, dashboard.view_key)
    audit.record(
        repositories,
        context,
        "dashboard.deleted",
        target_type="dashboard",
        target_id=dashboard.dashboard_id,
        target_label=dashboard.name,
        before=_where(dashboard),
    )
    return dashboard


def add_widget(
    repositories: Repositories, context: AuthzContext, dashboard_id: str, payload: WidgetCreate
) -> tuple[Dashboard, DashboardWidget]:
    """Append one widget to a dashboard the caller may change, answering both."""
    dashboard = load_dashboard(repositories, context, dashboard_id)
    require_dashboard_writer(repositories, context, dashboard)
    if len(dashboard.widgets) >= DASHBOARD_WIDGETS_MAX:
        raise unprocessable(f"A dashboard holds at most {DASHBOARD_WIDGETS_MAX} widgets")
    widget = build_widget(repositories, context, payload)
    updated = _save(repositories, context, dashboard, widgets=[*dashboard.widgets, widget])
    return updated, widget


def _widget(dashboard: Dashboard, widget_id: str) -> DashboardWidget:
    """One widget of a dashboard by id, or a 404."""
    for widget in dashboard.widgets:
        if widget.widget_id == widget_id:
            return widget
    raise not_found()


def update_widget(
    repositories: Repositories, context: AuthzContext, dashboard_id: str, widget_id: str, payload: WidgetUpdate
) -> tuple[Dashboard, DashboardWidget]:
    """Change the named fields of one widget, answering the dashboard and the widget as they now stand."""
    dashboard = load_dashboard(repositories, context, dashboard_id)
    require_dashboard_writer(repositories, context, dashboard)
    current = _widget(dashboard, widget_id)
    changes = payload.model_dump(exclude_unset=True)
    for name in ("kind", "source", "group_by", "measure", "size", "include_sub_teams"):
        if name in changes and changes[name] is None:
            raise unprocessable(f"{name} cannot be null")
    if "filter" in changes and changes["filter"] is None:
        changes["filter"] = {}
    if changes.get("title") == "":
        changes["title"] = None
    widget = _checked_widget(repositories, context, current.model_copy(update=changes))
    widgets = [widget if row.widget_id == widget_id else row for row in dashboard.widgets]
    return _save(repositories, context, dashboard, widgets=widgets), widget


def delete_widget(repositories: Repositories, context: AuthzContext, dashboard_id: str, widget_id: str) -> Dashboard:
    """Take one widget off a dashboard, answering the dashboard."""
    dashboard = load_dashboard(repositories, context, dashboard_id)
    require_dashboard_writer(repositories, context, dashboard)
    _widget(dashboard, widget_id)
    return _save(
        repositories, context, dashboard, widgets=[row for row in dashboard.widgets if row.widget_id != widget_id]
    )


def reorder_widgets(
    repositories: Repositories, context: AuthzContext, dashboard_id: str, widget_ids: Sequence[str]
) -> Dashboard:
    """Lay a dashboard's widgets out in the order given, which must name each widget exactly once."""
    dashboard = load_dashboard(repositories, context, dashboard_id)
    require_dashboard_writer(repositories, context, dashboard)
    current = {widget.widget_id: widget for widget in dashboard.widgets}
    if len(widget_ids) != len(set(widget_ids)) or set(widget_ids) != set(current):
        raise unprocessable("widget_ids must name every widget of the dashboard exactly once")
    return _save(repositories, context, dashboard, widgets=[current[widget_id] for widget_id in widget_ids])


def widget_insights(
    repositories: Repositories, context: AuthzContext, dashboard: Dashboard, widget: DashboardWidget
) -> InsightsRead:
    """One widget's breakdown, its own filter and the dashboard's both applied, read with the caller's visibility."""
    team_id, view_id = widget_scope(repositories, context, widget)
    return combined_insights(
        repositories,
        context,
        team_id=team_id,
        view_id=view_id,
        stored_filters=[widget.filter, dashboard.filter],
        group_by=widget.group_by,
        segment_by=widget.segment_by,
        measure=widget.measure,
        include_sub_teams=widget.include_sub_teams,
    )


def dashboard_data(
    repositories: Repositories, context: AuthzContext, dashboard: Dashboard
) -> tuple[dict[str, InsightsRead], dict[str, str]]:
    """Every widget's breakdown, and for each widget that cannot be drawn for this caller, why not."""
    data: dict[str, InsightsRead] = {}
    errors: dict[str, str] = {}
    for widget in dashboard.widgets:
        try:
            data[widget.widget_id] = widget_insights(repositories, context, dashboard, widget)
        except HTTPException as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
            errors[widget.widget_id] = str(detail.get("message", "Not available"))
    return data, errors


def replace_widgets(
    repositories: Repositories, context: AuthzContext, dashboard_id: str, widgets: Sequence[Mapping[str, Any]]
) -> Dashboard:
    """Set a dashboard's whole widget list in one write, in the order given.

    A widget naming one of the dashboard's `widget_id`s keeps that id and moves
    only the fields it names; any other is a new widget. Widgets left out are
    removed.
    """
    dashboard = load_dashboard(repositories, context, dashboard_id)
    require_dashboard_writer(repositories, context, dashboard)
    if len(widgets) > DASHBOARD_WIDGETS_MAX:
        raise unprocessable(f"A dashboard holds at most {DASHBOARD_WIDGETS_MAX} widgets")
    current = {widget.widget_id: widget for widget in dashboard.widgets}
    built: list[DashboardWidget] = []
    seen: set[str] = set()
    for item in widgets:
        fields = dict(item)
        widget_id = fields.pop("widget_id", None)
        if widget_id in current and widget_id not in seen:
            seen.add(widget_id)
            changes = WidgetUpdate.model_validate(fields).model_dump(exclude_unset=True)
            changes = {name: value for name, value in changes.items() if value is not None or name in CLEARABLE}
            built.append(_checked_widget(repositories, context, current[widget_id].model_copy(update=changes)))
        else:
            built.append(build_widget(repositories, context, WidgetCreate.model_validate(fields)))
    return _save(repositories, context, dashboard, widgets=built)
