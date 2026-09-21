"""Saved view routes: listing by scope, creating, patching and deleting.

The property worth holding is that scope is derived rather than asserted. A caller
sends a team or does not, and everything else about who may read or change the
view follows from that plus the authorization context, so there is no field a
caller can set to widen their own reach.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM


def create_view(client: TestClient, workspace: str, **payload: Any) -> "dict[str, Any]":
    """Save one view through the route, failing loudly on a refusal."""
    body: "dict[str, Any]" = {"name": "My view"}
    body.update(payload)
    response = client.post(f"/api/workspaces/{workspace}/views", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def test_a_view_with_no_team_is_personal(client: TestClient, workspace: str) -> None:
    """Scope comes from the absence of a team, not from the payload."""
    sign_in(client, MEMBER)

    view = create_view(client, workspace, name="Just mine")

    assert view["scope"] == "personal"
    assert view["team_id"] is None
    assert view["owner_id"] == MEMBER


def test_a_view_naming_a_team_is_a_team_view(client: TestClient, workspace: str) -> None:
    """Naming a team shares the view with everyone who can read that team."""
    sign_in(client, MEMBER)

    view = create_view(client, workspace, name="Team board", team_id=TEAM)

    assert view["scope"] == "team"
    assert view["team_id"] == TEAM


def test_another_members_personal_view_is_not_found(client: TestClient, workspace: str) -> None:
    """A personal view is invisible to everyone else, including an admin."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, name="Private")

    sign_in(client, ADMIN)
    response = client.get(f"/api/workspaces/{workspace}/views/{view['view_id']}")

    assert response.status_code == 404
    assert response.json()["error_code"] == "NOT_FOUND"


def test_a_guest_cannot_read_a_view_of_a_team_they_are_outside(client: TestClient, workspace: str) -> None:
    """The view of an invisible team is not found rather than refused."""
    sign_in(client, OWNER)
    view = create_view(client, workspace, name="Other team", team_id=OTHER_TEAM)

    sign_in(client, GUEST)
    response = client.get(f"/api/workspaces/{workspace}/views/{view['view_id']}")

    assert response.status_code == 404


def test_a_guest_reads_a_view_of_the_team_they_are_in(client: TestClient, workspace: str) -> None:
    """Team membership is what makes a shared view readable."""
    sign_in(client, OWNER)
    view = create_view(client, workspace, name="Our team", team_id=TEAM)

    sign_in(client, GUEST)
    response = client.get(f"/api/workspaces/{workspace}/views/{view['view_id']}")

    assert response.status_code == 200
    assert response.json()["view_id"] == view["view_id"]


def test_a_guest_cannot_save_a_view_on_a_team_they_are_outside(client: TestClient, workspace: str) -> None:
    """Creating a shared view needs membership in the team it is shared with."""
    sign_in(client, GUEST)

    response = client.post(
        f"/api/workspaces/{workspace}/views",
        json={"name": "Sneaky", "team_id": OTHER_TEAM},
    )

    assert response.status_code == 404


def test_a_reader_cannot_change_another_members_team_view(client: TestClient, workspace: str) -> None:
    """Readable is not writable: a found view the caller may not change is a 403.

    The guest can read this view because they are in the team, which is what
    makes the refusal a 403 rather than the 404 an invisible view would get.
    """
    sign_in(client, MEMBER)
    view = create_view(client, workspace, name="Mine to keep", team_id=TEAM)

    sign_in(client, GUEST)
    assert client.get(f"/api/workspaces/{workspace}/views/{view['view_id']}").status_code == 200

    response = client.patch(
        f"/api/workspaces/{workspace}/views/{view['view_id']}",
        json={"name": "Taken over"},
    )

    assert response.status_code == 403
    assert response.json()["error_code"] == "FORBIDDEN"


def test_a_team_admin_may_change_a_team_view_they_do_not_own(client: TestClient, workspace: str) -> None:
    """A shared view is the team's, so its admins may curate it."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, name="Draft", team_id=TEAM)

    sign_in(client, ADMIN)
    response = client.patch(
        f"/api/workspaces/{workspace}/views/{view['view_id']}",
        json={"name": "Curated"},
    )

    assert response.status_code == 200
    assert response.json()["name"] == "Curated"


def test_the_owner_may_change_their_own_personal_view(client: TestClient, workspace: str) -> None:
    """The ordinary case: a member curates what they saved."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, name="Before")

    response = client.patch(
        f"/api/workspaces/{workspace}/views/{view['view_id']}",
        json={"name": "After", "sort": "created_desc"},
    )

    assert response.status_code == 200
    assert response.json()["name"] == "After"
    assert response.json()["sort"] == "created_desc"


def test_a_patch_may_clear_the_grouping(client: TestClient, workspace: str) -> None:
    """`group_by` is nullable, so sending null is how a view is ungrouped."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, name="Grouped", group_by="assignee")
    assert view["group_by"] == "assignee"

    response = client.patch(
        f"/api/workspaces/{workspace}/views/{view['view_id']}",
        json={"group_by": None},
    )

    assert response.status_code == 200
    assert response.json()["group_by"] is None


def test_an_unknown_filter_key_is_rejected(client: TestClient, workspace: str) -> None:
    """The filter is a fixed set of keys, so a typo fails rather than matching all."""
    sign_in(client, MEMBER)

    response = client.post(
        f"/api/workspaces/{workspace}/views",
        json={"name": "Typo", "filter": {"assigne_id": MEMBER}},
    )

    assert response.status_code == 422
    assert response.json()["error_code"] == "INVALID_FILTER"


def test_a_known_filter_key_is_kept(client: TestClient, workspace: str) -> None:
    """A stored filter round trips, because running one is the issue list's job."""
    sign_in(client, MEMBER)

    view = create_view(client, workspace, name="Mine open", filter={"assignee_id": "me", "priority": "high"})

    assert view["filter"] == {"assignee_id": "me", "priority": "high"}


def test_listing_mine_leaves_out_team_views(client: TestClient, workspace: str) -> None:
    """The default scope is the caller's own saved views."""
    sign_in(client, MEMBER)
    create_view(client, workspace, name="Personal")
    create_view(client, workspace, name="Shared", team_id=TEAM)

    response = client.get(f"/api/workspaces/{workspace}/views")

    assert response.status_code == 200
    assert [row["name"] for row in response.json()["views"]] == ["Personal"]


def test_listing_all_merges_personal_and_visible_team_views(client: TestClient, workspace: str) -> None:
    """`all` is what the caller may read, built rather than filtered."""
    sign_in(client, OWNER)
    create_view(client, workspace, name="Owner shared", team_id=OTHER_TEAM)

    sign_in(client, GUEST)
    create_view(client, workspace, name="Guest personal")
    create_view(client, workspace, name="Guest shared", team_id=TEAM)

    response = client.get(f"/api/workspaces/{workspace}/views", params={"scope": "all"})

    assert response.status_code == 200
    assert [row["name"] for row in response.json()["views"]] == ["Guest personal", "Guest shared"]


def test_listing_team_views_of_an_invisible_team_is_not_found(client: TestClient, workspace: str) -> None:
    """Naming a team a guest is outside of is a 404, not an empty list."""
    sign_in(client, GUEST)

    response = client.get(
        f"/api/workspaces/{workspace}/views",
        params={"scope": "team", "team_id": OTHER_TEAM},
    )

    assert response.status_code == 404


def test_deleting_a_view_removes_it(client: TestClient, workspace: str) -> None:
    """Delete answers 204 and the view stops being readable."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, name="Temporary")

    assert client.delete(f"/api/workspaces/{workspace}/views/{view['view_id']}").status_code == 204
    assert client.get(f"/api/workspaces/{workspace}/views/{view['view_id']}").status_code == 404


def test_a_non_member_sees_no_views_at_all(client: TestClient, workspace: str) -> None:
    """Someone outside the workspace gets the same answer as for a missing one."""
    sign_in(client, "01JB000000000000000000OUTS")

    response = client.get(f"/api/workspaces/{workspace}/views")

    assert response.status_code == 404
