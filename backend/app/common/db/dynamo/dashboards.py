"""Dashboard rows of the `views` table: insight widgets laid out on one page.

A dashboard keeps its widgets on its own row, in order, so one read draws the
page and a reorder is one write. Scope lives in the sort key the way a saved
view's does, under a `dashboard#` prefix no saved view uses, so the view
listings and the view walk never meet a dashboard.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Iterator, Literal, Mapping, Optional

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository, new_ulid

from app.common.db.dynamo.base import as_item, utc_now

DashboardScope = Literal["personal", "team", "workspace"]

DASHBOARD_SCOPES: tuple[str, ...] = ("personal", "team", "workspace")

WidgetKind = Literal["chart", "table", "metric"]

WIDGET_KINDS: tuple[str, ...] = ("chart", "table", "metric")

WidgetSource = Literal["workspace", "team", "view"]

WIDGET_SOURCES: tuple[str, ...] = ("workspace", "team", "view")

WidgetSize = Literal["half", "full"]

WIDGET_SIZES: tuple[str, ...] = ("half", "full")

DASHBOARD_PREFIX = "dashboard#"
"""The sort key prefix every dashboard row shares and no other row of the table uses."""

WORKSPACE_DASHBOARD_PREFIX = "dashboard#workspace#"
"""The sort key prefix every workspace dashboard shares."""


def new_dashboard_id() -> str:
    """A fresh dashboard id, time sortable so a listing reads in creation order."""
    return new_ulid()


def new_widget_id() -> str:
    """A fresh widget id, unique within its dashboard."""
    return new_ulid()


def personal_dashboard_prefix(owner_id: str) -> str:
    """The sort key prefix of one member's own dashboards."""
    return f"dashboard#user#{owner_id}#"


def team_dashboard_prefix(team_id: str) -> str:
    """The sort key prefix of one team's dashboards."""
    return f"dashboard#team#{team_id}#"


def dashboard_key_for(scope: str, dashboard_id: str, *, owner_id: str, team_id: Optional[str]) -> str:
    """The sort key a dashboard takes in one scope, which is what decides who reads it."""
    if scope == "team" and team_id:
        return f"{team_dashboard_prefix(team_id)}{dashboard_id}"
    if scope == "workspace":
        return f"{WORKSPACE_DASHBOARD_PREFIX}{dashboard_id}"
    return f"{personal_dashboard_prefix(owner_id)}{dashboard_id}"


class DashboardWidget(BaseModel):
    """One insight on a dashboard: where its issues come from, its own filter and how it is drawn."""

    widget_id: str = Field(default_factory=new_widget_id)
    kind: str = "chart"
    title: Optional[str] = None
    source: str = "workspace"
    team_id: Optional[str] = None
    view_id: Optional[str] = None
    include_sub_teams: bool = False
    filter: dict[str, Any] = Field(default_factory=dict)
    group_by: str = "status"
    segment_by: Optional[str] = None
    measure: str = "count"
    size: str = "half"


class Dashboard(BaseModel):
    """One dashboard: its name, scope, owner, a filter every widget shares and its widgets in order."""

    workspace_id: str
    view_key: str
    dashboard_id: str = Field(default_factory=new_dashboard_id)
    name: str
    description: Optional[str] = None
    icon: Optional[str] = None
    team_id: Optional[str] = None
    owner_id: str
    filter: dict[str, Any] = Field(default_factory=dict)
    widgets: list[DashboardWidget] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    @property
    def scope(self) -> DashboardScope:
        """Personal, team or workspace, read from the sort key so the two never disagree."""
        if self.view_key.startswith(WORKSPACE_DASHBOARD_PREFIX):
            return "workspace"
        if self.team_id:
            return "team"
        return "personal"


class DashboardRows:
    """The dashboard reads and writes of the `views` table, mixed into its repository."""

    _repository: Repository

    def get_dashboard(self, workspace_id: str, view_key: str) -> Dashboard | None:
        """One dashboard by its full sort key, or `None`."""
        if not workspace_id or not view_key.startswith(DASHBOARD_PREFIX):
            return None
        item = self._repository.get({"workspace_id": workspace_id, "view_key": view_key})
        return Dashboard.model_validate(dict(item)) if item is not None else None

    def find_dashboard(
        self, workspace_id: str, dashboard_id: str, owner_id: str, team_ids: list[str], *, workspace_shared: bool
    ) -> Dashboard | None:
        """One dashboard by id, looked for only under the keys this caller may read."""
        if not workspace_id or not dashboard_id:
            return None
        candidates = [dashboard_key_for("personal", dashboard_id, owner_id=owner_id, team_id=None)]
        if workspace_shared:
            candidates.append(dashboard_key_for("workspace", dashboard_id, owner_id=owner_id, team_id=None))
        candidates.extend(
            dashboard_key_for("team", dashboard_id, owner_id=owner_id, team_id=team_id) for team_id in team_ids
        )
        for view_key in candidates:
            found = self.get_dashboard(workspace_id, view_key)
            if found is not None:
                return found
        return None

    def create_dashboard(self, dashboard: Dashboard) -> Dashboard:
        """Store a new dashboard, raising `ConditionFailed` when the key is taken."""
        self._repository.put(as_item(dashboard), condition=Attr("view_key").not_exists())
        return dashboard

    def update_dashboard(self, workspace_id: str, view_key: str, **attributes: Any) -> Dashboard | None:
        """Apply `attributes` to one dashboard, or `None` when it is gone."""
        values: dict[str, Any] = {
            name: (as_item(value) if isinstance(value, BaseModel) else value) for name, value in attributes.items()
        }
        if "widgets" in values:
            values["widgets"] = [
                as_item(widget) if isinstance(widget, BaseModel) else widget for widget in values["widgets"]
            ]
        values["updated_at"] = utc_now().isoformat()
        key = {"workspace_id": workspace_id, "view_key": view_key}
        try:
            item = self._repository.set_attributes(key, values, condition=Attr("dashboard_id").exists())
        except ConditionFailed:
            return None
        return Dashboard.model_validate(dict(item)) if item is not None else None

    def delete_dashboard(self, workspace_id: str, view_key: str) -> bool:
        """Remove one dashboard, reporting whether one was there."""
        if self.get_dashboard(workspace_id, view_key) is None:
            return False
        self._repository.delete({"workspace_id": workspace_id, "view_key": view_key})
        return True

    def list_personal_dashboards(self, workspace_id: str, owner_id: str, *, limit: int = 200) -> list[Dashboard]:
        """Every dashboard one member keeps for themselves, oldest first."""
        return self._dashboards(workspace_id, personal_dashboard_prefix(owner_id), limit)

    def list_team_dashboards(self, workspace_id: str, team_id: str, *, limit: int = 200) -> list[Dashboard]:
        """Every dashboard of one team, oldest first."""
        return self._dashboards(workspace_id, team_dashboard_prefix(team_id), limit)

    def list_workspace_dashboards(self, workspace_id: str, *, limit: int = 200) -> list[Dashboard]:
        """Every dashboard shared with the whole workspace, oldest first."""
        return self._dashboards(workspace_id, WORKSPACE_DASHBOARD_PREFIX, limit)

    def delete_team_dashboards(self, workspace_id: str, team_id: str) -> int:
        """Remove every dashboard of one team, for the team purge, answering how many went."""
        return self._delete_under(workspace_id, team_dashboard_prefix(team_id))

    def delete_personal_dashboards(self, workspace_id: str, owner_id: str) -> int:
        """Remove every dashboard one member keeps for themselves, for the account purge."""
        return self._delete_under(workspace_id, personal_dashboard_prefix(owner_id))

    def _delete_under(self, workspace_id: str, prefix: str) -> int:
        """Remove every dashboard under one sort key prefix, answering how many went."""
        removed = 0
        while rows := self._dashboards(workspace_id, prefix, 200):
            for row in rows:
                self._repository.delete({"workspace_id": workspace_id, "view_key": row.view_key})
                removed += 1
        return removed

    def iter_dashboards(self, workspace_id: str) -> Iterator[Dashboard]:
        """Every dashboard of one workspace, a page at a time."""
        if not workspace_id:
            return
        query = Key("workspace_id").eq(workspace_id) & Key("view_key").begins_with(DASHBOARD_PREFIX)
        for item in self._repository.iter_query(query):
            yield Dashboard.model_validate(dict(item))

    def _dashboards(self, workspace_id: str, prefix: str, limit: int) -> list[Dashboard]:
        """Every dashboard under one sort key prefix, in creation order."""
        if not workspace_id or not prefix:
            return []
        items: list[Mapping[str, Any]] = list(
            self._repository.iter_query(
                Key("workspace_id").eq(workspace_id) & Key("view_key").begins_with(prefix),
                max_items=limit,
            )
        )
        rows = [Dashboard.model_validate(dict(item)) for item in items]
        return sorted(rows, key=lambda row: (row.created_at, row.dashboard_id))
