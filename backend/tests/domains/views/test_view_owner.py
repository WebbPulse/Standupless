"""Handing a saved view to a new owner through the view patch.

The rule held here is that only the owner or a workspace admin may hand a view
over, only a team or workspace view can change hands, the new owner must be a
member who can read it, and every handover is audited.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_team_member, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM


def create_view(client: TestClient, workspace: str, **payload: Any) -> "dict[str, Any]":
    """Save one view through the route, failing loudly on a refusal."""
    body: "dict[str, Any]" = {"name": "Handover"}
    body.update(payload)
    response = client.post(f"/api/workspaces/{workspace}/views", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def view_path(workspace: str, view: "dict[str, Any]") -> str:
    """The route of one saved view."""
    return f"/api/workspaces/{workspace}/views/{view['view_id']}"


def events(repositories: Any, workspace: str) -> "list[Any]":
    """The audit events recording a view owner change."""
    return [row for row in repositories.audit.list_events(workspace).events if row.action == "view.owner_changed"]


def test_the_owner_hands_a_workspace_view_to_another_member(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """The new owner reads back on the view, and the change is audited."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, shared=True)

    response = client.patch(view_path(workspace, view), json={"owner_id": OWNER})

    assert response.status_code == 200, response.text
    assert response.json()["owner_id"] == OWNER
    assert response.json()["view_id"] == view["view_id"]
    [event] = events(repositories, workspace)
    assert event.target.id == view["view_id"]
    assert event.before["owner_id"] == MEMBER
    assert event.after["owner_id"] == OWNER


def test_a_workspace_admin_changes_the_owner_of_a_view_they_do_not_own(client: TestClient, workspace: str) -> None:
    """An admin may reassign any shared view."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, team_id=TEAM)

    sign_in(client, ADMIN)
    response = client.patch(view_path(workspace, view), json={"owner_id": ADMIN})

    assert response.status_code == 200, response.text
    assert response.json()["owner_id"] == ADMIN


def test_a_team_admin_who_is_not_the_owner_cannot_change_it(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A team admin may edit a team view but not hand it to someone else."""
    sign_in(client, OWNER)
    view = create_view(client, workspace, team_id=TEAM)
    add_team_member(repositories, workspace, TEAM, MEMBER, "admin")

    sign_in(client, MEMBER)
    assert client.patch(view_path(workspace, view), json={"name": "Renamed"}).status_code == 200
    response = client.patch(view_path(workspace, view), json={"owner_id": MEMBER})

    assert response.status_code == 403
    assert events(repositories, workspace) == []


def test_a_personal_view_must_be_shared_before_it_changes_hands(client: TestClient, workspace: str) -> None:
    """A personal view is refused, and sharing it in the same patch lets it pass."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace)

    refused = client.patch(view_path(workspace, view), json={"owner_id": OWNER})
    moved = client.patch(view_path(workspace, view), json={"owner_id": OWNER, "shared": True})

    assert refused.status_code == 422
    assert moved.status_code == 200, moved.text
    assert (moved.json()["owner_id"], moved.json()["scope"]) == (OWNER, "workspace")


def test_the_new_owner_must_be_a_member_who_can_read_the_view(client: TestClient, workspace: str) -> None:
    """Someone outside the workspace, or a guest outside the view's team, is refused."""
    sign_in(client, OWNER)
    wide = create_view(client, workspace, shared=True)
    other = create_view(client, workspace, team_id=OTHER_TEAM)
    own_team = create_view(client, workspace, team_id=TEAM)

    nobody = client.patch(view_path(workspace, wide), json={"owner_id": "01JBNOBODY0000000000000000"})
    guest_wide = client.patch(view_path(workspace, wide), json={"owner_id": GUEST})
    guest_other = client.patch(view_path(workspace, other), json={"owner_id": GUEST})
    guest_team = client.patch(view_path(workspace, own_team), json={"owner_id": GUEST})

    assert (nobody.status_code, guest_wide.status_code, guest_other.status_code) == (422, 422, 422)
    assert guest_team.status_code == 200, guest_team.text
    assert guest_team.json()["owner_id"] == GUEST


def test_naming_the_current_owner_changes_nothing(client: TestClient, workspace: str, repositories: Any) -> None:
    """Handing a view to the person who already owns it is not a change to audit."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, shared=True)

    response = client.patch(view_path(workspace, view), json={"owner_id": MEMBER})

    assert response.status_code == 200, response.text
    assert events(repositories, workspace) == []
