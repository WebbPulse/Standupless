"""Dashboard routes: insight widgets from several teams and views laid out on one page.

Served under `/views` so the gateway's existing views prefix routes them, and
registered before the saved view routes so `dashboards` is never read as a view
id. The rules live in `app.common.dashboards`, shared with the MCP tools.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Path, Query, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.dashboards import (
    DashboardCreate,
    DashboardList,
    DashboardMove,
    DashboardRead,
    DashboardUpdate,
    WidgetCreate,
    WidgetOrder,
    WidgetUpdate,
)
from app.common.api.schemas.insights import InsightsRead
from app.common.dashboards import (
    add_widget,
    create_dashboard,
    dashboard_read,
    delete_dashboard,
    delete_widget,
    load_dashboard,
    move_dashboard,
    readable_dashboards,
    reorder_widgets,
    update_dashboard,
    update_widget,
    widget_insights,
)
from app.common.issue_rules import not_found

router = APIRouter()

READER = Depends(require(Capability.WORKSPACE_READ))


@router.get("/{workspace_id}/views/dashboards", response_model=DashboardList)
def list_dashboards(
    workspace_id: str = Path(..., min_length=1),
    scope: str = Query("all"),
    team_id: Optional[str] = Query(None),
    context: AuthzContext = READER,
    repositories: Repositories = Depends(get_repositories),
) -> DashboardList:
    """The dashboards the caller may read: their own first, then team and workspace ones.

    `scope` narrows to `personal`, `team` or `workspace`, and `team_id` to one
    team's dashboards alongside the caller's own.
    """
    rows = readable_dashboards(repositories, context, scope, team_id)
    return DashboardList(dashboards=[dashboard_read(repositories, context, row) for row in rows])


@router.post("/{workspace_id}/views/dashboards", response_model=DashboardRead, status_code=status.HTTP_201_CREATED)
def post_dashboard(
    payload: DashboardCreate,
    workspace_id: str = Path(..., min_length=1),
    context: AuthzContext = READER,
    repositories: Repositories = Depends(get_repositories),
) -> DashboardRead:
    """Create a dashboard owned by the caller: personal, for a team they write in, or for the workspace."""
    return dashboard_read(repositories, context, create_dashboard(repositories, context, payload))


@router.get("/{workspace_id}/views/dashboards/{dashboard_id}", response_model=DashboardRead)
def get_dashboard(
    workspace_id: str = Path(..., min_length=1),
    dashboard_id: str = Path(..., min_length=1),
    context: AuthzContext = READER,
    repositories: Repositories = Depends(get_repositories),
) -> DashboardRead:
    """One dashboard the caller may read, with its widgets in order."""
    return dashboard_read(repositories, context, load_dashboard(repositories, context, dashboard_id))


@router.patch("/{workspace_id}/views/dashboards/{dashboard_id}", response_model=DashboardRead)
def patch_dashboard(
    payload: DashboardUpdate,
    workspace_id: str = Path(..., min_length=1),
    dashboard_id: str = Path(..., min_length=1),
    context: AuthzContext = READER,
    repositories: Repositories = Depends(get_repositories),
) -> DashboardRead:
    """Change a dashboard's name, description, icon, shared filter or owner."""
    return dashboard_read(repositories, context, update_dashboard(repositories, context, dashboard_id, payload))


@router.delete("/{workspace_id}/views/dashboards/{dashboard_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_dashboard(
    workspace_id: str = Path(..., min_length=1),
    dashboard_id: str = Path(..., min_length=1),
    context: AuthzContext = READER,
    repositories: Repositories = Depends(get_repositories),
) -> Response:
    """Delete a dashboard, the owner's call or an admin's for a shared one."""
    delete_dashboard(repositories, context, dashboard_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{workspace_id}/views/dashboards/{dashboard_id}/move", response_model=DashboardRead)
def post_dashboard_move(
    payload: DashboardMove,
    workspace_id: str = Path(..., min_length=1),
    dashboard_id: str = Path(..., min_length=1),
    context: AuthzContext = READER,
    repositories: Repositories = Depends(get_repositories),
) -> DashboardRead:
    """Move a dashboard to its owner, a team or the whole workspace, keeping its id."""
    return dashboard_read(repositories, context, move_dashboard(repositories, context, dashboard_id, payload))


@router.post(
    "/{workspace_id}/views/dashboards/{dashboard_id}/widgets",
    response_model=DashboardRead,
    status_code=status.HTTP_201_CREATED,
)
def post_widget(
    payload: WidgetCreate,
    workspace_id: str = Path(..., min_length=1),
    dashboard_id: str = Path(..., min_length=1),
    context: AuthzContext = READER,
    repositories: Repositories = Depends(get_repositories),
) -> DashboardRead:
    """Add a widget at the end of a dashboard, answering the dashboard."""
    dashboard, _ = add_widget(repositories, context, dashboard_id, payload)
    return dashboard_read(repositories, context, dashboard)


@router.put("/{workspace_id}/views/dashboards/{dashboard_id}/widgets/order", response_model=DashboardRead)
def put_widget_order(
    payload: WidgetOrder,
    workspace_id: str = Path(..., min_length=1),
    dashboard_id: str = Path(..., min_length=1),
    context: AuthzContext = READER,
    repositories: Repositories = Depends(get_repositories),
) -> DashboardRead:
    """Rearrange a dashboard's widgets; the order names every widget once."""
    return dashboard_read(repositories, context, reorder_widgets(repositories, context, dashboard_id, payload.widget_ids))


@router.patch("/{workspace_id}/views/dashboards/{dashboard_id}/widgets/{widget_id}", response_model=DashboardRead)
def patch_widget(
    payload: WidgetUpdate,
    workspace_id: str = Path(..., min_length=1),
    dashboard_id: str = Path(..., min_length=1),
    widget_id: str = Path(..., min_length=1),
    context: AuthzContext = READER,
    repositories: Repositories = Depends(get_repositories),
) -> DashboardRead:
    """Change one widget's source, filter, measure, grouping or look, answering the dashboard."""
    dashboard, _ = update_widget(repositories, context, dashboard_id, widget_id, payload)
    return dashboard_read(repositories, context, dashboard)


@router.delete("/{workspace_id}/views/dashboards/{dashboard_id}/widgets/{widget_id}", response_model=DashboardRead)
def remove_widget(
    workspace_id: str = Path(..., min_length=1),
    dashboard_id: str = Path(..., min_length=1),
    widget_id: str = Path(..., min_length=1),
    context: AuthzContext = READER,
    repositories: Repositories = Depends(get_repositories),
) -> DashboardRead:
    """Take one widget off a dashboard, answering the dashboard."""
    return dashboard_read(repositories, context, delete_widget(repositories, context, dashboard_id, widget_id))


@router.get(
    "/{workspace_id}/views/dashboards/{dashboard_id}/widgets/{widget_id}/insights", response_model=InsightsRead
)
def get_widget_insights(
    workspace_id: str = Path(..., min_length=1),
    dashboard_id: str = Path(..., min_length=1),
    widget_id: str = Path(..., min_length=1),
    context: AuthzContext = READER,
    repositories: Repositories = Depends(get_repositories),
) -> InsightsRead:
    """One widget's data: its breakdown with its own filter and the dashboard's applied.

    Read with the caller's visibility, so a workspace widget counts only the
    teams they can see and a widget over a view they cannot read is a 404.
    """
    dashboard = load_dashboard(repositories, context, dashboard_id)
    for widget in dashboard.widgets:
        if widget.widget_id == widget_id:
            return widget_insights(repositories, context, dashboard, widget)
    raise not_found()
