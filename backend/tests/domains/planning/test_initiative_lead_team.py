"""An initiative's lead team: setting it, filtering by it, and the privacy a private team brings.

The properties worth holding are that the lead team round trips and clears, that
it must be a team the caller writes in, that a private lead team hides the
initiative from everyone outside it with the 404 an absent one gets, that a
hidden sub-initiative drops out of its parent's tree while its projects still
roll up, that every change is audited, and that purging the team leaves the
initiative workspace level.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from webbpulse.audit import AuditQuery

from app.domains.planning.consumers.purge import detach_initiatives
from tests.domains.helpers import ADMIN, MEMBER, add_team_member, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, TEAM, WORKSPACE, seed_project


def _base(workspace: str) -> str:
    """The workspace's initiatives collection."""
    return f"/api/workspaces/{workspace}/initiatives"


def _create(client: TestClient, workspace: str, **payload: Any) -> "dict[str, Any]":
    """Create one initiative through the route, failing loudly on a refusal."""
    body: "dict[str, Any]" = {"name": "Expand to Europe"}
    body.update(payload)
    response = client.post(_base(workspace), json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _names(client: TestClient, workspace: str, **params: str) -> list[str]:
    """The names of the initiatives the list answers for the signed-in caller."""
    response = client.get(_base(workspace), params=params)
    assert response.status_code == 200, response.text
    return [row["name"] for row in response.json()["initiatives"]]


def test_the_lead_team_round_trips_filters_and_clears(client: TestClient, workspace: str) -> None:
    """A team set on create reads back, the list filters by it or by none, and null clears it."""
    sign_in(client, MEMBER)
    led = _create(client, workspace, name="Led", team_id=TEAM)
    _create(client, workspace, name="Open")

    assert led["team_id"] == TEAM
    assert _names(client, workspace, team_id=TEAM) == ["Led"]
    assert _names(client, workspace, team_id="none") == ["Open"]
    assert sorted(_names(client, workspace)) == ["Led", "Open"]

    moved = client.patch(f"{_base(workspace)}/{led['initiative_id']}", json={"team_id": OTHER_TEAM})
    assert moved.status_code == 200, moved.text
    assert moved.json()["team_id"] == OTHER_TEAM

    cleared = client.patch(f"{_base(workspace)}/{led['initiative_id']}", json={"team_id": None})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["team_id"] is None
    assert sorted(_names(client, workspace, team_id="none")) == ["Led", "Open"]


def test_an_unknown_team_is_refused(client: TestClient, workspace: str) -> None:
    """A lead team that is not one of the workspace's answers the 404 a hidden team gets."""
    sign_in(client, MEMBER)
    response = client.post(_base(workspace), json={"name": "Nowhere", "team_id": "01JB000000000000000000NOPE"})
    assert response.status_code == 404


def test_a_private_lead_team_hides_the_initiative_from_outsiders(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A workspace admin outside the private team gets a 404 everywhere and an empty list."""
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "member")
    repositories.memberships.set_team_private(WORKSPACE, TEAM, True)
    sign_in(client, MEMBER)
    hidden = _create(client, workspace, name="Secret", team_id=TEAM)
    project_id = seed_project(client, workspace)["project_id"]
    path = f"{_base(workspace)}/{hidden['initiative_id']}"
    assert client.get(path).status_code == 200

    sign_in(client, ADMIN)
    assert _names(client, workspace) == []
    assert client.get(path).status_code == 404
    assert client.patch(path, json={"name": "Seen"}).status_code == 404
    assert client.get(f"{path}/updates").status_code == 404
    assert client.delete(path).status_code == 404
    assert client.post(_base(workspace), json={"name": "Mine", "team_id": TEAM}).status_code == 404
    child = client.post(_base(workspace), json={"name": "Child", "parent_initiative_id": hidden["initiative_id"]})
    assert child.status_code == 422

    sign_in(client, MEMBER)
    target = client.patch(
        f"/api/workspaces/{workspace}/projects/{project_id}", json={"initiative_id": hidden["initiative_id"]}
    )
    assert target.status_code == 200, target.text


def test_a_hidden_sub_initiative_drops_out_of_its_parents_tree(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """The parent lists only the sub-initiatives the caller sees, and a hidden parent leaves no breadcrumb."""
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "member")
    sign_in(client, MEMBER)
    parent = _create(client, workspace, name="Parent")
    secret = _create(client, workspace, name="Secret", team_id=TEAM, parent_initiative_id=parent["initiative_id"])
    leaf = _create(client, workspace, name="Leaf", parent_initiative_id=secret["initiative_id"])
    repositories.memberships.set_team_private(WORKSPACE, TEAM, True)

    sign_in(client, MEMBER)
    seen = client.get(f"{_base(workspace)}/{parent['initiative_id']}").json()
    assert seen["sub_initiative_ids"] == [secret["initiative_id"]]

    sign_in(client, ADMIN)
    outside = client.get(f"{_base(workspace)}/{parent['initiative_id']}").json()
    assert outside["sub_initiative_ids"] == []
    orphan = client.get(f"{_base(workspace)}/{leaf['initiative_id']}").json()
    assert [row["initiative_id"] for row in orphan["ancestors"]] == [parent["initiative_id"]]
    assert orphan["parent_initiative_id"] is None


def test_a_lead_team_change_is_audited(client: TestClient, repositories: Any, workspace: str) -> None:
    """Creating with a team and every later change record the team before and after."""
    sign_in(client, MEMBER)
    created = _create(client, workspace, team_id=TEAM)
    path = f"{_base(workspace)}/{created['initiative_id']}"
    assert client.patch(path, json={"team_id": OTHER_TEAM}).status_code == 200
    assert client.patch(path, json={"name": "Renamed"}).status_code == 200

    events = repositories.audit.list_events(WORKSPACE, AuditQuery(action="initiative.team_changed")).events
    changes = sorted((event.before or {}).get("team_id") or "" for event in events)
    assert changes == ["", TEAM]
    assert {event.target.id for event in events} == {created["initiative_id"]}


def test_purging_the_lead_team_leaves_the_initiative_workspace_level(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """The planning purge clears the team from the initiatives it led and leaves the others alone."""
    sign_in(client, MEMBER)
    led = _create(client, workspace, name="Led", team_id=TEAM)
    other = _create(client, workspace, name="Other", team_id=OTHER_TEAM)

    detach_initiatives(repositories, WORKSPACE, TEAM)

    assert repositories.planning.get_initiative(WORKSPACE, led["initiative_id"]).team_id is None
    assert repositories.planning.get_initiative(WORKSPACE, other["initiative_id"]).team_id == OTHER_TEAM
