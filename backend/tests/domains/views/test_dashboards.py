"""Dashboard routes: scope, visibility, widgets, moves, ownership and widget data.

The properties worth holding are that a dashboard is read by exactly who its
scope admits, that changing it is its owner's or an admin's call, that moving it
keeps its id, and that a widget's numbers are the insights breakdown with its own
filter and the dashboard's both applied.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM, seed_issue

pytestmark = pytest.mark.usefixtures("business_plan")


def base(workspace: str) -> str:
    """The dashboards collection path."""
    return f"/api/workspaces/{workspace}/views/dashboards"


def create(client: TestClient, workspace: str, **payload: Any) -> "dict[str, Any]":
    """Create one dashboard, failing loudly on a refusal."""
    body: "dict[str, Any]" = {"name": "Delivery"}
    body.update(payload)
    response = client.post(base(workspace), json=body)
    assert response.status_code == 201, response.text
    return response.json()


def names(client: TestClient, workspace: str, **params: Any) -> "list[str]":
    """The names of the dashboards one caller lists, in listing order."""
    response = client.get(base(workspace), params=params)
    assert response.status_code == 200, response.text
    return [row["name"] for row in response.json()["dashboards"]]


def events(repositories: Any, workspace: str, action: str) -> "list[Any]":
    """The audit events of one action."""
    return [row for row in repositories.audit.list_events(workspace).events if row.action == action]


def test_a_new_dashboard_is_personal_and_owned_by_its_creator(client: TestClient, workspace: str) -> None:
    """With no scope a dashboard is the caller's alone, editable by them."""
    sign_in(client, MEMBER)
    body = create(client, workspace, description="Weekly look", filter={"priority": "high"})

    assert body["scope"] == "personal"
    assert body["owner_id"] == MEMBER
    assert body["team_id"] is None
    assert body["filter"] == {"priority": "high"}
    assert body["widgets"] == []
    assert body["can_edit"] is True
    assert client.get(f"{base(workspace)}/{body['id']}").json()["name"] == "Delivery"


def test_personal_dashboards_are_private_to_their_owner(client: TestClient, workspace: str) -> None:
    """Another member, even an admin, neither lists nor reads someone's personal dashboard."""
    sign_in(client, MEMBER)
    body = create(client, workspace, name="Mine")

    sign_in(client, ADMIN)
    assert "Mine" not in names(client, workspace)
    assert client.get(f"{base(workspace)}/{body['id']}").status_code == 404


def test_listing_puts_personal_first_then_shared_in_name_order(client: TestClient, workspace: str) -> None:
    """Personal dashboards head the list; team and workspace ones follow by name."""
    sign_in(client, OWNER)
    create(client, workspace, name="Zed personal")
    create(client, workspace, name="Beta shared", scope="workspace")
    create(client, workspace, name="Alpha team", scope="team", team_id=TEAM)

    assert names(client, workspace) == ["Zed personal", "Alpha team", "Beta shared"]
    assert names(client, workspace, scope="personal") == ["Zed personal"]
    assert names(client, workspace, scope="workspace") == ["Beta shared"]
    assert names(client, workspace, scope="team", team_id=TEAM) == ["Alpha team"]


def test_a_guest_sees_only_their_teams_dashboards(client: TestClient, workspace: str) -> None:
    """A guest reads dashboards of a team they are on, never other teams' or the workspace's."""
    sign_in(client, OWNER)
    mine = create(client, workspace, name="On my team", scope="team", team_id=TEAM)
    other = create(client, workspace, name="Elsewhere", scope="team", team_id=OTHER_TEAM)
    wide = create(client, workspace, name="Everyone", scope="workspace")

    sign_in(client, GUEST)
    assert names(client, workspace) == ["On my team"]
    assert client.get(f"{base(workspace)}/{mine['id']}").status_code == 200
    assert client.get(f"{base(workspace)}/{other['id']}").status_code == 404
    assert client.get(f"{base(workspace)}/{wide['id']}").status_code == 404


def test_a_guest_cannot_create_a_workspace_dashboard(client: TestClient, workspace: str) -> None:
    """Workspace dashboards are for members; a guest is refused rather than silently scoped down."""
    sign_in(client, GUEST)

    response = client.post(base(workspace), json={"name": "Wide", "scope": "workspace"})

    assert response.status_code == 403


def test_a_private_teams_dashboards_are_skipped_for_outsiders(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A member outside a private team neither lists nor opens its dashboards."""
    sign_in(client, OWNER)
    body = create(client, workspace, name="Secret", scope="team", team_id=OTHER_TEAM)
    repositories.memberships.set_team_private(workspace, OTHER_TEAM, True)

    sign_in(client, MEMBER)
    assert "Secret" not in names(client, workspace)
    assert client.get(f"{base(workspace)}/{body['id']}").status_code == 404


def test_team_scope_needs_a_team_and_other_scopes_refuse_one(client: TestClient, workspace: str) -> None:
    """team_id is required for a team dashboard and meaningless elsewhere."""
    sign_in(client, OWNER)

    assert client.post(base(workspace), json={"name": "A", "scope": "team"}).status_code == 422
    assert client.post(base(workspace), json={"name": "B", "team_id": TEAM}).status_code == 422


def test_only_the_owner_or_an_admin_changes_a_shared_dashboard(client: TestClient, workspace: str) -> None:
    """A member can read a workspace dashboard but not rename it; a workspace admin can."""
    sign_in(client, OWNER)
    body = create(client, workspace, name="Shared", scope="workspace")
    path = f"{base(workspace)}/{body['id']}"

    sign_in(client, MEMBER)
    assert client.get(path).json()["can_edit"] is False
    assert client.patch(path, json={"name": "Hijacked"}).status_code == 403
    assert client.delete(path).status_code == 403

    sign_in(client, ADMIN)
    renamed = client.patch(path, json={"name": "Renamed", "filter": {"priority": "urgent"}})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "Renamed"
    assert renamed.json()["filter"] == {"priority": "urgent"}


def test_a_bad_filter_is_refused(client: TestClient, workspace: str) -> None:
    """An unknown filter field is a 422 on the dashboard and on a widget."""
    sign_in(client, OWNER)

    assert client.post(base(workspace), json={"name": "Typo", "filter": {"assigne_id": MEMBER}}).status_code == 422
    body = create(client, workspace)
    response = client.post(f"{base(workspace)}/{body['id']}/widgets", json={"filter": {"assigne_id": MEMBER}})
    assert response.status_code == 422


def test_widgets_are_added_changed_reordered_and_removed(client: TestClient, workspace: str) -> None:
    """Widget writes answer the dashboard with its widgets in order."""
    sign_in(client, OWNER)
    body = create(client, workspace)
    path = f"{base(workspace)}/{body['id']}"

    first = client.post(f"{path}/widgets", json={"kind": "metric", "title": "Open"})
    assert first.status_code == 201, first.text
    second = client.post(f"{path}/widgets", json={"kind": "table", "source": "team", "team_id": TEAM})
    widgets = second.json()["widgets"]
    assert [widget["kind"] for widget in widgets] == ["metric", "table"]
    one, two = widgets[0]["widget_id"], widgets[1]["widget_id"]

    changed = client.patch(f"{path}/widgets/{one}", json={"group_by": "priority", "size": "full"})
    assert changed.status_code == 200, changed.text
    assert changed.json()["widgets"][0]["group_by"] == "priority"
    assert changed.json()["widgets"][0]["size"] == "full"

    reordered = client.put(f"{path}/widgets/order", json={"widget_ids": [two, one]})
    assert [widget["widget_id"] for widget in reordered.json()["widgets"]] == [two, one]
    assert client.put(f"{path}/widgets/order", json={"widget_ids": [two]}).status_code == 422
    assert client.put(f"{path}/widgets/order", json={"widget_ids": [two, two]}).status_code == 422

    removed = client.delete(f"{path}/widgets/{two}")
    assert [widget["widget_id"] for widget in removed.json()["widgets"]] == [one]
    assert client.delete(f"{path}/widgets/{two}").status_code == 404


def test_a_widget_over_a_team_the_caller_cannot_see_is_refused(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A guest cannot point a widget at a team they are outside."""
    sign_in(client, GUEST)
    body = create(client, workspace, scope="team", team_id=TEAM)

    response = client.post(f"{base(workspace)}/{body['id']}/widgets", json={"source": "team", "team_id": OTHER_TEAM})

    assert response.status_code == 404


def test_segment_must_differ_from_group(client: TestClient, workspace: str) -> None:
    """Segmenting a breakdown by its own dimension is refused."""
    sign_in(client, OWNER)
    body = create(client, workspace)

    response = client.post(
        f"{base(workspace)}/{body['id']}/widgets", json={"group_by": "priority", "segment_by": "priority"}
    )

    assert response.status_code == 422


def test_widget_data_applies_both_the_widget_and_dashboard_filters(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """A widget counts only issues matching its own filter and the dashboard's together."""
    sign_in(issues_client, OWNER)
    seed_issue(issues_client, workspace, title="Both", priority="high", assignee_id=MEMBER)
    seed_issue(issues_client, workspace, title="Widget only", priority="high")
    seed_issue(issues_client, workspace, title="Dashboard only", priority="low", assignee_id=MEMBER)
    seed_issue(issues_client, workspace, title="Elsewhere", team_id=OTHER_TEAM, priority="high", assignee_id=MEMBER)

    sign_in(client, OWNER)
    body = create(client, workspace, filter={"assignee_id": MEMBER})
    path = f"{base(workspace)}/{body['id']}"
    widget = client.post(
        f"{path}/widgets", json={"source": "team", "team_id": TEAM, "filter": {"priority": "high"}}
    ).json()["widgets"][0]

    response = client.get(f"{path}/widgets/{widget['widget_id']}/insights")

    assert response.status_code == 200, response.text
    assert response.json()["total"] == 1
    assert response.json()["issue_count"] == 1


def test_a_workspace_widget_counts_every_team_the_caller_sees(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """A workspace source spans teams; a guest's copy counts only their own team."""
    sign_in(issues_client, OWNER)
    seed_issue(issues_client, workspace, title="Here")
    seed_issue(issues_client, workspace, title="There", team_id=OTHER_TEAM)

    sign_in(client, OWNER)
    body = create(client, workspace, scope="team", team_id=TEAM)
    path = f"{base(workspace)}/{body['id']}"
    widget = client.post(f"{path}/widgets", json={"source": "workspace"}).json()["widgets"][0]

    assert client.get(f"{path}/widgets/{widget['widget_id']}/insights").json()["total"] == 2

    sign_in(client, GUEST)
    assert client.get(f"{path}/widgets/{widget['widget_id']}/insights").json()["total"] == 1


def test_a_view_widget_reads_the_saved_view(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """A view source narrows to the view's filter."""
    sign_in(issues_client, OWNER)
    seed_issue(issues_client, workspace, title="Urgent", priority="urgent")
    seed_issue(issues_client, workspace, title="Calm", priority="low")

    sign_in(client, OWNER)
    view = client.post(
        f"/api/workspaces/{workspace}/views",
        json={"name": "Urgent", "team_id": TEAM, "filter": {"priority": "urgent"}},
    )
    assert view.status_code == 201, view.text
    body = create(client, workspace)
    path = f"{base(workspace)}/{body['id']}"
    added = client.post(f"{path}/widgets", json={"source": "view", "view_id": view.json()["view_id"]})
    assert added.status_code == 201, added.text
    widget = added.json()["widgets"][0]

    assert client.get(f"{path}/widgets/{widget['widget_id']}/insights").json()["total"] == 1


def test_moving_keeps_the_id_and_changes_who_reads_it(client: TestClient, workspace: str, repositories: Any) -> None:
    """A personal dashboard moved to the workspace keeps its id and becomes readable by members."""
    sign_in(client, OWNER)
    body = create(client, workspace, name="Promoted")
    path = f"{base(workspace)}/{body['id']}"

    moved = client.post(f"{path}/move", json={"scope": "workspace"})

    assert moved.status_code == 200, moved.text
    assert moved.json()["id"] == body["id"]
    assert moved.json()["scope"] == "workspace"
    sign_in(client, MEMBER)
    assert client.get(path).status_code == 200
    [event] = events(repositories, workspace, "dashboard.moved")
    assert event.target.id == body["id"]
    assert event.before["scope"] == "personal"
    assert event.after["scope"] == "workspace"


def test_only_the_owner_takes_a_dashboard_back_to_personal(client: TestClient, workspace: str) -> None:
    """An admin may move a shared dashboard between teams but not into someone's personal list."""
    sign_in(client, OWNER)
    body = create(client, workspace, scope="team", team_id=TEAM)
    path = f"{base(workspace)}/{body['id']}"

    sign_in(client, ADMIN)
    assert client.post(f"{path}/move", json={"scope": "personal"}).status_code == 403
    moved = client.post(f"{path}/move", json={"scope": "team", "team_id": OTHER_TEAM})
    assert moved.status_code == 200, moved.text
    assert moved.json()["team_id"] == OTHER_TEAM

    sign_in(client, OWNER)
    back = client.post(f"{path}/move", json={"scope": "personal"})
    assert back.status_code == 200, back.text
    assert back.json()["scope"] == "personal"


def test_ownership_passes_on_a_shared_dashboard(client: TestClient, workspace: str, repositories: Any) -> None:
    """A shared dashboard's owner can hand it to another member, and the change is audited."""
    sign_in(client, OWNER)
    body = create(client, workspace, scope="workspace")
    path = f"{base(workspace)}/{body['id']}"

    changed = client.patch(path, json={"owner_id": MEMBER})

    assert changed.status_code == 200, changed.text
    assert changed.json()["owner_id"] == MEMBER
    [event] = events(repositories, workspace, "dashboard.owner_changed")
    assert event.before["owner_id"] == OWNER
    assert event.after["owner_id"] == MEMBER
    sign_in(client, MEMBER)
    assert client.get(path).json()["can_edit"] is True


def test_ownership_rules_refuse_a_personal_dashboard_and_a_reader_who_cannot_see_it(
    client: TestClient, workspace: str
) -> None:
    """A personal dashboard moves first; a guest cannot own a workspace dashboard."""
    sign_in(client, OWNER)
    personal = create(client, workspace)
    wide = create(client, workspace, scope="workspace")

    assert client.patch(f"{base(workspace)}/{personal['id']}", json={"owner_id": MEMBER}).status_code == 422
    assert client.patch(f"{base(workspace)}/{wide['id']}", json={"owner_id": GUEST}).status_code == 422
    assert (
        client.patch(f"{base(workspace)}/{wide['id']}", json={"owner_id": "01JBNOBODY0000000000000000"}).status_code
        == 422
    )


def test_create_and_delete_are_audited(client: TestClient, workspace: str, repositories: Any) -> None:
    """Creating and deleting a dashboard each leave one audit event naming it."""
    sign_in(client, OWNER)
    body = create(client, workspace, name="Short lived", scope="team", team_id=TEAM)

    assert client.delete(f"{base(workspace)}/{body['id']}").status_code == 204
    assert client.get(f"{base(workspace)}/{body['id']}").status_code == 404

    [created] = events(repositories, workspace, "dashboard.created")
    [deleted] = events(repositories, workspace, "dashboard.deleted")
    assert created.target.id == deleted.target.id == body["id"]
    assert created.after == {"scope": "team", "team_id": TEAM}
    assert deleted.before == {"scope": "team", "team_id": TEAM}


def test_dashboards_never_show_up_as_saved_views(client: TestClient, workspace: str) -> None:
    """Dashboards share the views table but not the saved view listing."""
    sign_in(client, OWNER)
    create(client, workspace, name="Not a view", scope="workspace")

    response = client.get(f"/api/workspaces/{workspace}/views")

    assert response.status_code == 200, response.text
    assert "Not a view" not in [row["name"] for row in response.json()["views"]]
