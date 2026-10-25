"""Isolation arguments for the dashboard MCP tools.

The listing takes no id and answers the key's own workspace's dashboards, so it
is in `ANSWERS_AT_HOME`; every other tool names the other workspace's dashboard
or team and must refuse.
"""

from __future__ import annotations

from typing import Any

from app.common.db.dynamo.dashboards import Dashboard, DashboardWidget, dashboard_key_for, new_dashboard_id
from tests.domains.helpers import OWNER

ANSWERS_AT_HOME: frozenset[str] = frozenset({"list_dashboards"})


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """A personal dashboard and a team dashboard for the owner in the other workspace."""
    personal = new_dashboard_id()
    repositories.views.create_dashboard(
        Dashboard(
            workspace_id=workspace_id,
            view_key=dashboard_key_for("personal", personal, owner_id=OWNER, team_id=None),
            dashboard_id=personal,
            name="Classified personal dashboard",
            owner_id=OWNER,
            widgets=[DashboardWidget(source="team", team_id=team_id)],
        )
    )
    shared = new_dashboard_id()
    repositories.views.create_dashboard(
        Dashboard(
            workspace_id=workspace_id,
            view_key=dashboard_key_for("team", shared, owner_id=OWNER, team_id=team_id),
            dashboard_id=shared,
            name="Classified team dashboard",
            team_id=team_id,
            owner_id=OWNER,
        )
    )
    return {"personal_dashboard_id": personal, "team_dashboard_id": shared}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's rows, one set per tool."""
    return {
        "list_dashboards": {},
        "get_dashboard": {"dashboard_id": foreign["personal_dashboard_id"], "include_data": True},
        "create_dashboard": {"name": "Should not land", "scope": "team", "team_id": foreign["team_id"]},
        "update_dashboard": {"dashboard_id": foreign["team_dashboard_id"], "name": "Should not land"},
        "delete_dashboard": {"dashboard_id": foreign["personal_dashboard_id"]},
    }
