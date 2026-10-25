"""Request and response schemas for dashboards, shared by the dashboard routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and a tool that builds a dashboard must validate exactly what the route
validates. Widget filters take a saved view's filter keys, so a widget means
what a view with the same filter would list.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, StrictBool

from app.common.api.schemas.insights import InsightDimension, InsightMeasure, InsightsRead
from app.common.db.dynamo.dashboards import Dashboard, DashboardWidget

DASHBOARD_NAME_MAX = 80

DASHBOARD_DESCRIPTION_MAX = 500

DASHBOARD_ICON_MAX = 32

WIDGET_TITLE_MAX = 80

DASHBOARD_WIDGETS_MAX = 24
"""The most widgets one dashboard holds, so drawing the page stays a bounded fan out."""

DashboardScopeField = Literal["personal", "team", "workspace"]

WidgetKindField = Literal["chart", "table", "metric"]

WidgetSourceField = Literal["workspace", "team", "view"]

WidgetSizeField = Literal["half", "full"]


class WidgetCreate(BaseModel):
    """The body that adds one widget: its source, its own filter and how it is measured and drawn."""

    kind: WidgetKindField = "chart"
    title: Optional[str] = Field(default=None, max_length=WIDGET_TITLE_MAX)
    source: WidgetSourceField = "workspace"
    team_id: Optional[str] = None
    view_id: Optional[str] = None
    include_sub_teams: StrictBool = False
    filter: dict[str, Any] = Field(default_factory=dict)
    group_by: InsightDimension = "status"
    segment_by: Optional[InsightDimension] = None
    measure: InsightMeasure = "count"
    size: WidgetSizeField = "half"


class WidgetUpdate(BaseModel):
    """The widget fields a patch may move, each optional; a source change names its team or view again."""

    kind: Optional[WidgetKindField] = None
    title: Optional[str] = Field(default=None, max_length=WIDGET_TITLE_MAX)
    source: Optional[WidgetSourceField] = None
    team_id: Optional[str] = None
    view_id: Optional[str] = None
    include_sub_teams: Optional[StrictBool] = None
    filter: Optional[dict[str, Any]] = None
    group_by: Optional[InsightDimension] = None
    segment_by: Optional[InsightDimension] = None
    measure: Optional[InsightMeasure] = None
    size: Optional[WidgetSizeField] = None


class WidgetOrder(BaseModel):
    """Every widget id of a dashboard in the order they should be drawn."""

    widget_ids: list[str] = Field(max_length=DASHBOARD_WIDGETS_MAX)


class DashboardCreate(BaseModel):
    """The body a dashboard create takes; the owner is the caller and a team scope names its team."""

    name: str = Field(min_length=1, max_length=DASHBOARD_NAME_MAX)
    description: Optional[str] = Field(default=None, max_length=DASHBOARD_DESCRIPTION_MAX)
    icon: Optional[str] = Field(default=None, min_length=1, max_length=DASHBOARD_ICON_MAX)
    scope: DashboardScopeField = "personal"
    team_id: Optional[str] = None
    filter: dict[str, Any] = Field(default_factory=dict)
    widgets: list[WidgetCreate] = Field(default_factory=list, max_length=DASHBOARD_WIDGETS_MAX)


class DashboardUpdate(BaseModel):
    """The dashboard fields a patch may move: its name, description, icon, shared filter and owner."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=DASHBOARD_NAME_MAX)
    description: Optional[str] = Field(default=None, max_length=DASHBOARD_DESCRIPTION_MAX)
    icon: Optional[str] = Field(default=None, max_length=DASHBOARD_ICON_MAX)
    filter: Optional[dict[str, Any]] = None
    owner_id: Optional[str] = None


class DashboardMove(BaseModel):
    """Where a dashboard moves: personal to its owner, a team, or the whole workspace."""

    scope: DashboardScopeField
    team_id: Optional[str] = None


class WidgetRead(BaseModel):
    """One widget as the API answers it."""

    widget_id: str
    kind: WidgetKindField
    title: Optional[str] = None
    source: WidgetSourceField
    team_id: Optional[str] = None
    view_id: Optional[str] = None
    include_sub_teams: bool = False
    filter: dict[str, Any] = Field(default_factory=dict)
    group_by: InsightDimension
    segment_by: Optional[InsightDimension] = None
    measure: InsightMeasure
    size: WidgetSizeField

    @classmethod
    def from_row(cls, row: DashboardWidget) -> "WidgetRead":
        """The stored widget as its response."""
        return cls.model_validate(row.model_dump())


class DashboardRead(BaseModel):
    """One dashboard as the API answers it, with whether the caller may change it."""

    id: str
    name: str
    description: Optional[str] = None
    icon: Optional[str] = None
    scope: DashboardScopeField
    team_id: Optional[str] = None
    owner_id: str
    filter: dict[str, Any] = Field(default_factory=dict)
    widgets: list[WidgetRead] = Field(default_factory=list)
    can_edit: bool = False
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row: Dashboard, *, can_edit: bool) -> "DashboardRead":
        """The stored dashboard as its response."""
        return cls(
            id=row.dashboard_id,
            name=row.name,
            description=row.description,
            icon=row.icon,
            scope=row.scope,
            team_id=row.team_id,
            owner_id=row.owner_id,
            filter=dict(row.filter),
            widgets=[WidgetRead.from_row(widget) for widget in row.widgets],
            can_edit=can_edit,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )


class DashboardList(BaseModel):
    """The dashboards a caller may read, personal ones first, then team and workspace ones."""

    dashboards: list[DashboardRead]


class WidgetInsights(BaseModel):
    """One widget's data: its breakdown with the dashboard filter and its own applied."""

    widget_id: str
    insights: InsightsRead


class DashboardData(BaseModel):
    """Every widget's data at once, keyed by widget id; a widget that cannot be drawn carries its error."""

    dashboard_id: str
    widgets: list[WidgetInsights]
    errors: dict[str, str] = Field(default_factory=dict)
