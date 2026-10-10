"""Saved view composer routes: workspace sharing, favorites, the view's look and the new filters.

Workspace views widen who may read a view without a team, so the property held
here is that every member but a guest reads one, only its owner or a workspace
admin changes one, and a guest can neither create nor find one. Favorites are a
member's own, so a star never shows to anyone else.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM, seed_issue


def create_view(client: TestClient, workspace: str, **payload: Any) -> "dict[str, Any]":
    """Save one view through the route, failing loudly on a refusal."""
    body: "dict[str, Any]" = {"name": "A view"}
    body.update(payload)
    response = client.post(f"/api/workspaces/{workspace}/views", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def listed(client: TestClient, workspace: str, scope: str = "all") -> "dict[str, dict[str, Any]]":
    """The caller's view listing for one scope, keyed by view id."""
    response = client.get(f"/api/workspaces/{workspace}/views", params={"scope": scope})
    assert response.status_code == 200, response.text
    return {row["view_id"]: row for row in response.json()["views"]}


def test_a_shared_view_with_no_team_is_a_workspace_view(client: TestClient, workspace: str) -> None:
    """Sharing without a team files the view under the whole workspace."""
    sign_in(client, MEMBER)

    view = create_view(client, workspace, name="Everyone", shared=True)

    assert view["scope"] == "workspace"
    assert view["team_id"] is None


def test_a_workspace_view_is_read_by_every_member_but_a_guest(client: TestClient, workspace: str) -> None:
    """Members find it in their listing and by id; a guest finds it in neither."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, name="Everyone", shared=True)

    sign_in(client, ADMIN)
    assert view["view_id"] in listed(client, workspace, "workspace")
    assert view["view_id"] in listed(client, workspace, "all")
    assert view["view_id"] not in listed(client, workspace, "mine")

    sign_in(client, GUEST)
    assert view["view_id"] not in listed(client, workspace, "all")
    response = client.get(f"/api/workspaces/{workspace}/views/{view['view_id']}")
    assert response.status_code == 404


def test_a_guest_cannot_share_a_view_with_the_workspace(client: TestClient, workspace: str) -> None:
    """A guest sees part of the workspace, so cannot publish to all of it."""
    sign_in(client, GUEST)

    response = client.post(f"/api/workspaces/{workspace}/views", json={"name": "Mine", "shared": True})

    assert response.status_code == 403


def test_a_workspace_view_is_changed_by_its_owner_or_a_workspace_admin(client: TestClient, workspace: str) -> None:
    """Another member reads it but may not rename it; an admin may."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, name="Everyone", shared=True)
    path = f"/api/workspaces/{workspace}/views/{view['view_id']}"

    sign_in(client, OWNER)
    assert client.patch(path, json={"name": "Renamed"}).status_code == 200

    sign_in(client, ADMIN)
    assert client.delete(path).status_code == 204


def test_a_plain_member_cannot_change_someone_elses_workspace_view(client: TestClient, workspace: str) -> None:
    """Reading a shared view is not the right to change it."""
    sign_in(client, ADMIN)
    view = create_view(client, workspace, name="Everyone", shared=True)

    sign_in(client, MEMBER)
    response = client.patch(f"/api/workspaces/{workspace}/views/{view['view_id']}", json={"name": "Mine now"})

    assert response.status_code == 403


def test_a_view_keeps_its_icon_color_and_description(client: TestClient, workspace: str) -> None:
    """The look and description round trip, and a patch may clear them."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, icon="bug", color="red", description="Open bugs")

    assert (view["icon"], view["color"], view["description"]) == ("bug", "red", "Open bugs")

    response = client.patch(
        f"/api/workspaces/{workspace}/views/{view['view_id']}",
        json={"color": "blue", "description": None},
    )
    assert response.status_code == 200
    body = response.json()
    assert (body["icon"], body["color"], body["description"]) == ("bug", "blue", None)


def test_a_color_outside_the_palette_is_refused(client: TestClient, workspace: str) -> None:
    """A fixed palette, so every theme renders the color it is given."""
    sign_in(client, MEMBER)

    response = client.post(f"/api/workspaces/{workspace}/views", json={"name": "Odd", "color": "#123456"})

    assert response.status_code == 422


def test_favorites_are_the_callers_own(client: TestClient, workspace: str) -> None:
    """A star marks the view for its member alone, and unstarring is idempotent."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, name="Ours", team_id=TEAM)
    path = f"/api/workspaces/{workspace}/views/{view['view_id']}/favorite"

    starred = client.put(path)
    assert starred.status_code == 200
    assert starred.json()["favorite"] is True
    assert client.put(path).status_code == 200
    assert listed(client, workspace)[view["view_id"]]["favorite"] is True
    read = client.get(f"/api/workspaces/{workspace}/views/{view['view_id']}")
    assert read.json()["favorite"] is True

    sign_in(client, OWNER)
    assert listed(client, workspace)[view["view_id"]]["favorite"] is False

    sign_in(client, MEMBER)
    assert client.delete(path).json()["favorite"] is False
    assert client.delete(path).status_code == 200
    assert listed(client, workspace)[view["view_id"]]["favorite"] is False


def test_a_view_one_cannot_read_cannot_be_starred(client: TestClient, workspace: str) -> None:
    """Starring goes through the same visibility as reading."""
    sign_in(client, OWNER)
    view = create_view(client, workspace, name="Other", team_id=OTHER_TEAM)

    sign_in(client, GUEST)
    response = client.put(f"/api/workspaces/{workspace}/views/{view['view_id']}/favorite")

    assert response.status_code == 404


def test_deleting_a_view_drops_it_from_the_deleters_favorites(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A deleted view does not linger as a dangling star."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, name="Short lived")
    client.put(f"/api/workspaces/{workspace}/views/{view['view_id']}/favorite")

    client.delete(f"/api/workspaces/{workspace}/views/{view['view_id']}")

    assert repositories.views.favorites(workspace, MEMBER) == []


def test_new_filter_keys_save_and_scalar_ones_refuse_a_list(client: TestClient, workspace: str) -> None:
    """Team and date filters are part of the saved filter set, dates taken once."""
    sign_in(client, MEMBER)

    view = create_view(
        client,
        workspace,
        filter={"team_id_in": [TEAM], "team_id_not": OTHER_TEAM, "created_after": "2026-10-01"},
    )
    assert view["filter"]["team_id_in"] == [TEAM]

    response = client.post(
        f"/api/workspaces/{workspace}/views",
        json={"name": "Bad", "filter": {"updated_before": ["2026-10-01", "2026-10-02"]}},
    )
    assert response.status_code == 422
    assert response.json()["error_code"] == "INVALID_FILTER"


def test_insights_honour_team_filters_of_a_saved_view(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """A workspace view naming none of the teams counts no issues, read server side."""
    sign_in(issues_client, OWNER)
    seed_issue(issues_client, workspace, title="In team")
    seed_issue(issues_client, workspace, title="Elsewhere", team_id=OTHER_TEAM)

    sign_in(client, OWNER)
    everything = create_view(client, workspace, name="All", shared=True)
    only_team = create_view(client, workspace, name="Team", shared=True, filter={"team_id_in": [TEAM]})
    not_team = create_view(client, workspace, name="Not team", shared=True, filter={"team_id_not": [TEAM]})

    def total(view: "dict[str, Any]") -> int:
        """The issue count the view selects."""
        response = client.get(f"/api/workspaces/{workspace}/views/insights", params={"view_id": view["view_id"]})
        assert response.status_code == 200, response.text
        return response.json()["issue_count"]

    assert total(everything) == 2
    assert total(only_team) == 1
    assert total(not_team) == 1
