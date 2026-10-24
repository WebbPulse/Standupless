"""Saved project views: a named projects page arrangement and filter, beside the issue views.

The properties worth holding are that a project view's filter is judged by the
projects page's keys rather than the issue list's, that its arrangement reads back
whole, that listings can be narrowed to one kind, and that every view saved before
project views existed still reads as an issue view.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.views import SavedView, personal_view_key
from tests.domains.helpers import MEMBER, sign_in
from tests.domains.views.conftest import TEAM


def _create(client: TestClient, workspace: str, **payload: Any) -> Any:
    """Post one view through the route, answering the raw response."""
    body: "dict[str, Any]" = {"name": "Roadmap"}
    body.update(payload)
    return client.post(f"/api/workspaces/{workspace}/views", json=body)


def test_a_project_view_keeps_its_filter_and_arrangement(client: TestClient, workspace: str) -> None:
    """The projects filter and arrangement round trip, with the issue display fields left at rest."""
    sign_in(client, MEMBER)

    response = _create(
        client,
        workspace,
        entity="projects",
        team_id=TEAM,
        filter={"team_id": TEAM, "status": ["planned", "in_progress"], "lead_id": "none", "sub_teams": False},
        projects_display={"layout": "timeline", "group": "lead", "order": "name", "closed": "month", "zoom": "quarter"},
    )

    assert response.status_code == 201, response.text
    view = response.json()
    assert view["entity"] == "projects"
    assert view["scope"] == "team"
    assert view["filter"] == {
        "team_id": TEAM,
        "status": ["planned", "in_progress"],
        "lead_id": "none",
        "sub_teams": "false",
    }
    assert view["projects_display"] == {
        "layout": "timeline",
        "group": "lead",
        "order": "name",
        "closed": "month",
        "zoom": "quarter",
    }
    read = client.get(f"/api/workspaces/{workspace}/views/{view['view_id']}")
    assert read.json()["projects_display"] == view["projects_display"]


def test_a_project_view_without_an_arrangement_takes_the_default(client: TestClient, workspace: str) -> None:
    """A project view saved with no arrangement opens as the projects page does."""
    sign_in(client, MEMBER)

    view = _create(client, workspace, entity="projects").json()

    assert view["projects_display"] == {
        "layout": "list",
        "group": "status",
        "order": "target",
        "closed": "all",
        "zoom": "month",
    }


def test_a_project_view_refuses_issue_filter_keys_and_unknown_statuses(client: TestClient, workspace: str) -> None:
    """The projects page's keys and statuses are the whole set, so anything else is `INVALID_FILTER`."""
    sign_in(client, MEMBER)

    for bad in ({"assignee_id": "me"}, {"status": ["shipping"]}, {"team_id": ["a", "b"]}, {"sub_teams": "maybe"}):
        response = _create(client, workspace, entity="projects", filter=bad)
        assert response.status_code == 422, bad
        assert response.json()["error_code"] == "INVALID_FILTER"


def test_an_issue_view_refuses_a_projects_arrangement_and_project_keys(client: TestClient, workspace: str) -> None:
    """An issue view takes neither a projects arrangement nor the projects page's filter keys."""
    sign_in(client, MEMBER)

    arranged = _create(client, workspace, projects_display={"layout": "board"})
    filtered = _create(client, workspace, filter={"lead_id": "none"})

    assert arranged.status_code == 422
    assert filtered.status_code == 422
    assert filtered.json()["error_code"] == "INVALID_FILTER"


def test_a_project_view_patch_moves_the_arrangement_and_filter(client: TestClient, workspace: str) -> None:
    """A patch replaces the arrangement and is judged by the projects keys."""
    sign_in(client, MEMBER)
    view = _create(client, workspace, entity="projects").json()
    url = f"/api/workspaces/{workspace}/views/{view['view_id']}"

    moved = client.patch(
        url, json={"projects_display": {"layout": "board", "group": "health"}, "filter": {"status": "paused"}}
    )
    bad = client.patch(url, json={"filter": {"priority": "high"}})
    cleared = client.patch(url, json={"projects_display": None})

    assert moved.status_code == 200, moved.text
    assert moved.json()["projects_display"]["layout"] == "board"
    assert moved.json()["projects_display"]["group"] == "health"
    assert moved.json()["projects_display"]["order"] == "target"
    assert moved.json()["filter"] == {"status": "paused"}
    assert bad.status_code == 422
    assert bad.json()["error_code"] == "INVALID_FILTER"
    assert cleared.status_code == 422


def test_an_issue_view_patch_refuses_a_projects_arrangement(client: TestClient, workspace: str) -> None:
    """Only a project view keeps a projects arrangement."""
    sign_in(client, MEMBER)
    view = _create(client, workspace).json()

    response = client.patch(
        f"/api/workspaces/{workspace}/views/{view['view_id']}", json={"projects_display": {"layout": "board"}}
    )

    assert view["entity"] == "issues"
    assert view["projects_display"] is None
    assert response.status_code == 422


def test_the_listing_narrows_to_one_kind(client: TestClient, workspace: str) -> None:
    """`entity` keeps only issue views or only project views, and no `entity` keeps both."""
    sign_in(client, MEMBER)
    _create(client, workspace, name="Bugs")
    _create(client, workspace, name="Roadmap", entity="projects")
    url = f"/api/workspaces/{workspace}/views"

    everything = client.get(url, params={"scope": "all"}).json()["views"]
    projects = client.get(url, params={"scope": "all", "entity": "projects"}).json()["views"]
    issues = client.get(url, params={"scope": "all", "entity": "issues"}).json()["views"]

    assert [row["name"] for row in everything] == ["Bugs", "Roadmap"]
    assert [row["name"] for row in projects] == ["Roadmap"]
    assert [row["name"] for row in issues] == ["Bugs"]


def test_a_view_saved_before_project_views_reads_as_an_issue_view(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A stored row with no `entity` is an issue view with no projects arrangement."""
    sign_in(client, MEMBER)
    repositories.views.create(
        SavedView(
            workspace_id=workspace,
            view_key=personal_view_key(MEMBER, "01OLDVIEW"),
            view_id="01OLDVIEW",
            name="Old",
            owner_id=MEMBER,
        )
    )

    view = client.get(f"/api/workspaces/{workspace}/views/01OLDVIEW").json()
    issues = client.get(f"/api/workspaces/{workspace}/views", params={"entity": "issues"}).json()["views"]

    assert (view["entity"], view["projects_display"]) == ("issues", None)
    assert [row["view_id"] for row in issues] == ["01OLDVIEW"]


def test_a_retired_arrangement_choice_reads_as_the_default(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A stored choice the projects page no longer offers falls back field by field."""
    sign_in(client, MEMBER)
    repositories.views.create(
        SavedView(
            workspace_id=workspace,
            view_key=personal_view_key(MEMBER, "01PROJVIEW"),
            view_id="01PROJVIEW",
            name="Retired",
            entity="projects",
            projects_display={"layout": "gallery", "group": "lead"},
            owner_id=MEMBER,
        )
    )

    view = client.get(f"/api/workspaces/{workspace}/views/01PROJVIEW").json()

    assert view["projects_display"]["layout"] == "list"
    assert view["projects_display"]["group"] == "lead"


def test_insights_and_share_links_refuse_a_project_view(client: TestClient, workspace: str) -> None:
    """A project view lists no issues, so there is nothing to count or share."""
    sign_in(client, MEMBER)
    view = _create(client, workspace, entity="projects", team_id=TEAM).json()

    counted = client.get(f"/api/workspaces/{workspace}/views/insights", params={"view_id": view["view_id"]})
    shared = client.post(
        f"/api/workspaces/{workspace}/share-links", json={"target_type": "view", "target_id": view["view_id"]}
    )

    assert counted.status_code == 422
    assert shared.status_code == 422


def test_a_project_view_can_be_a_favorite(client: TestClient, workspace: str) -> None:
    """A project view stars like any other view."""
    sign_in(client, MEMBER)
    view = _create(client, workspace, entity="projects").json()

    starred = client.put(f"/api/workspaces/{workspace}/views/{view['view_id']}/favorite")

    assert starred.status_code == 200, starred.text
    assert starred.json()["favorite"] is True
