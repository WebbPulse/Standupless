"""The dashboard MCP tools: create, read with data, update, move and delete.

Each tool runs the dashboard route's own `app.common.dashboards` path, so these
hold the MCP-only pieces: team and view references resolved inside widgets, a
name standing in for an id, the whole widget list replaced in one call, and
per-widget data with errors for widgets the caller cannot read.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import GUEST, MEMBER, OWNER
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM, seed_issue
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

READ_WRITE = ("views:read", "views:write", "issues:read")


def test_a_dashboard_is_created_with_widgets_named_by_team_key(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A team key inside a widget resolves to the team's id, and team_id alone makes a team dashboard."""
    secret = mint_for(repositories, MEMBER, READ_WRITE)

    body = answer(
        tool(
            client,
            secret,
            "create_dashboard",
            {"name": "Delivery", "team_id": "ABC", "widgets": [{"kind": "metric", "source": "team", "team_id": "ABC"}]},
        )
    )

    assert body["scope"] == "team"
    assert body["team_id"] == TEAM
    assert [widget["team_id"] for widget in body["widgets"]] == [TEAM]
    listed = answer(tool(client, secret, "list_dashboards", {}))
    assert [(row["name"], row["widget_count"]) for row in listed["dashboards"]] == [("Delivery", 1)]


def test_get_by_name_includes_each_widgets_data(client: TestClient, repositories: Any, workspace: str) -> None:
    """include_data answers every widget's breakdown keyed by widget id."""
    seed_issue(repositories, workspace, TEAM, "01JB0000000000000000000IS1", "ABC", 1)
    seed_issue(repositories, workspace, TEAM, "01JB0000000000000000000IS2", "ABC", 2)
    secret = mint_for(repositories, OWNER, READ_WRITE)
    created = answer(
        tool(client, secret, "create_dashboard", {"name": "Overview", "widgets": [{"source": "team", "team_id": TEAM}]})
    )

    body = answer(tool(client, secret, "get_dashboard", {"dashboard_id": "Overview", "include_data": True}))

    widget_id = created["widgets"][0]["widget_id"]
    assert body["id"] == created["id"]
    assert body["data"][widget_id]["total"] == 2
    assert body["errors"] == {}


def test_a_widget_the_reader_cannot_see_is_reported_not_fatal(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A guest reading a team dashboard with a widget over another team gets an error for that widget alone."""
    owner = mint_for(repositories, OWNER, READ_WRITE)
    created = answer(
        tool(
            client,
            owner,
            "create_dashboard",
            {
                "name": "Mixed",
                "scope": "team",
                "team_id": TEAM,
                "widgets": [{"source": "team", "team_id": TEAM}, {"source": "team", "team_id": OTHER_TEAM}],
            },
        )
    )
    guest = mint_for(repositories, GUEST, READ_WRITE)

    body = answer(tool(client, guest, "get_dashboard", {"dashboard_id": created["id"], "include_data": True}))

    first, second = (widget["widget_id"] for widget in created["widgets"])
    assert first in body["data"]
    assert second in body["errors"]


def test_update_replaces_the_widget_list_and_moves_the_dashboard(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A kept widget id keeps its widget, a new entry is added, an omitted one goes, and scope moves it."""
    secret = mint_for(repositories, OWNER, READ_WRITE)
    created = answer(
        tool(
            client,
            secret,
            "create_dashboard",
            {"name": "Board", "widgets": [{"kind": "metric"}, {"kind": "table"}]},
        )
    )
    keep, drop = (widget["widget_id"] for widget in created["widgets"])

    body = answer(
        tool(
            client,
            secret,
            "update_dashboard",
            {
                "dashboard_id": created["id"],
                "name": "Renamed",
                "scope": "workspace",
                "widgets": [{"kind": "chart", "group_by": "priority"}, {"widget_id": keep, "title": "Kept"}],
            },
        )
    )

    assert body["name"] == "Renamed"
    assert body["scope"] == "workspace"
    assert [widget["kind"] for widget in body["widgets"]] == ["chart", "metric"]
    assert body["widgets"][1]["widget_id"] == keep
    assert body["widgets"][1]["title"] == "Kept"
    assert drop not in [widget["widget_id"] for widget in body["widgets"]]


def test_another_members_personal_dashboard_is_not_visible(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A personal dashboard reads as absent to anyone but its owner."""
    owner = mint_for(repositories, OWNER, READ_WRITE)
    created = answer(tool(client, owner, "create_dashboard", {"name": "Private"}))
    member = mint_for(repositories, MEMBER, READ_WRITE)

    refusal(tool(client, member, "get_dashboard", {"dashboard_id": created["id"]}))
    refusal(tool(client, member, "delete_dashboard", {"dashboard_id": created["id"]}))


def test_delete_removes_the_dashboard(client: TestClient, repositories: Any, workspace: str) -> None:
    """Deleting answers the removed dashboard and leaves nothing to list."""
    secret = mint_for(repositories, OWNER, READ_WRITE)
    created = answer(tool(client, secret, "create_dashboard", {"name": "Gone"}))

    body = answer(tool(client, secret, "delete_dashboard", {"dashboard_id": created["id"]}))

    assert body == {"deleted": True, "dashboard_id": created["id"], "name": "Gone"}
    assert answer(tool(client, secret, "list_dashboards", {}))["dashboards"] == []
