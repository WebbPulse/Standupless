"""Private teams on the team routes, against real tables in moto.

A private team is invite only: a workspace member outside it gets the same 404
an absent team gets, on the list and by id, and cannot join it. A workspace
owner or admin outside it still finds it, so they can administer it and add
themselves. Turning privacy on needs the Business plan; turning it off never
does.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import (
    ADMIN,
    GUEST,
    MEMBER,
    OWNER,
    add_member,
    add_team_member,
    make_team,
    make_workspace,
    sign_in,
)

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

INSIDER = "user-insider"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["teams"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A Business workspace with one team, an insider on it, and every role outside it."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    repositories.workspaces.set_billing(WORKSPACE, plan="business")
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    add_member(repositories, WORKSPACE, INSIDER, "member")
    make_team(repositories, WORKSPACE, TEAM, "SEC")
    add_team_member(repositories, WORKSPACE, TEAM, INSIDER, "admin")
    return WORKSPACE


@pytest.fixture
def private_team(repositories: Any, workspace: str) -> str:
    """The workspace's team, made private."""
    repositories.memberships.set_team_private(workspace, TEAM, True)
    return TEAM


def _listed(client: TestClient, workspace: str) -> dict[str, Any]:
    """The caller's team list, keyed by team id."""
    response = client.get(f"/api/workspaces/{workspace}/teams")
    assert response.status_code == 200, response.text
    return {team["id"]: team for team in response.json()["teams"]}


def test_a_new_team_is_open(client: TestClient, workspace: str) -> None:
    """Privacy is opt in, and an open team reads `private: false`."""
    sign_in(client, MEMBER)
    response = client.post(f"/api/workspaces/{workspace}/teams", json={"name": "Apollo", "key_prefix": "APO"})
    assert response.status_code == 201
    assert response.json()["private"] is False


def test_a_team_created_private_is_hidden_from_other_members(client: TestClient, workspace: str) -> None:
    """The creator is its admin and sees it; another member does not."""
    sign_in(client, INSIDER)
    response = client.post(
        f"/api/workspaces/{workspace}/teams", json={"name": "Vault", "key_prefix": "VLT", "private": True}
    )
    assert response.status_code == 201, response.text
    team_id = response.json()["id"]
    assert response.json()["private"] is True
    assert _listed(client, workspace)[team_id]["private"] is True

    sign_in(client, MEMBER)
    assert team_id not in _listed(client, workspace)
    assert client.get(f"/api/workspaces/{workspace}/teams/{team_id}").status_code == 404


def test_private_needs_the_business_plan(client: TestClient, workspace: str, repositories: Any) -> None:
    """On a plan without the feature, create and update both refuse with the plan code."""
    repositories.workspaces.set_billing(workspace, plan="free")
    sign_in(client, INSIDER)

    created = client.post(
        f"/api/workspaces/{workspace}/teams", json={"name": "Vault", "key_prefix": "VLT", "private": True}
    )
    assert created.status_code == 403
    assert created.json()["error_code"] == "PLAN_FEATURE_UNAVAILABLE"
    assert client.get(f"/api/workspaces/{workspace}/teams").json()["teams"][0]["key_prefix"] == "SEC"

    updated = client.patch(f"/api/workspaces/{workspace}/teams/{TEAM}", json={"private": True})
    assert updated.status_code == 403
    assert repositories.memberships.is_private_team(workspace, TEAM) is False


def test_a_downgraded_workspace_can_still_open_a_private_team(
    client: TestClient, workspace: str, private_team: str, repositories: Any
) -> None:
    """Opening is never gated, and a downgrade leaves the team private until someone opens it."""
    repositories.workspaces.set_billing(workspace, plan="free")
    sign_in(client, MEMBER)
    assert private_team not in _listed(client, workspace)

    sign_in(client, INSIDER)
    response = client.patch(f"/api/workspaces/{workspace}/teams/{private_team}", json={"private": False})
    assert response.status_code == 200, response.text
    assert response.json()["private"] is False

    sign_in(client, MEMBER)
    assert private_team in _listed(client, workspace)


def test_a_team_admin_makes_a_team_private(client: TestClient, workspace: str, repositories: Any) -> None:
    """The PATCH writes the marker and the read answers it."""
    sign_in(client, INSIDER)
    response = client.patch(f"/api/workspaces/{workspace}/teams/{TEAM}", json={"private": True})
    assert response.status_code == 200, response.text
    assert response.json()["private"] is True
    assert repositories.memberships.is_private_team(workspace, TEAM) is True
    assert client.get(f"/api/workspaces/{workspace}/teams/{TEAM}").json()["private"] is True


@pytest.mark.parametrize("subject", [MEMBER, GUEST])
def test_a_private_team_is_absent_to_people_outside_it(
    client: TestClient, workspace: str, private_team: str, subject: str
) -> None:
    """A member or guest outside it cannot list, read, or join it."""
    sign_in(client, subject)
    assert private_team not in _listed(client, workspace)
    assert client.get(f"/api/workspaces/{workspace}/teams/{private_team}").status_code == 404
    assert client.get(f"/api/workspaces/{workspace}/teams/{private_team}/members").status_code == 404
    assert client.post(f"/api/workspaces/{workspace}/teams/{private_team}/join").status_code == 404


def test_a_member_added_by_a_team_admin_sees_it(
    client: TestClient, workspace: str, private_team: str, repositories: Any
) -> None:
    """Joining is by invite: a team admin adds the member, who then finds the team."""
    sign_in(client, INSIDER)
    response = client.put(f"/api/workspaces/{workspace}/teams/{private_team}/members/{MEMBER}", json={"role": "member"})
    assert response.status_code in (200, 201), response.text

    sign_in(client, MEMBER)
    listed = _listed(client, workspace)
    assert listed[private_team]["is_member"] is True
    assert client.get(f"/api/workspaces/{workspace}/teams/{private_team}").status_code == 200


@pytest.mark.parametrize("subject", [OWNER, ADMIN])
def test_a_workspace_admin_finds_and_administers_a_private_team(
    client: TestClient, workspace: str, private_team: str, subject: str
) -> None:
    """Owners and admins see it in the list to manage it, and may add themselves."""
    sign_in(client, subject)
    listed = _listed(client, workspace)
    assert listed[private_team]["private"] is True
    assert listed[private_team]["is_member"] is False
    assert client.get(f"/api/workspaces/{workspace}/teams/{private_team}").status_code == 200
    assert (
        client.patch(f"/api/workspaces/{workspace}/teams/{private_team}", json={"name": "Renamed"}).status_code == 200
    )
    assert client.post(f"/api/workspaces/{workspace}/teams/{private_team}/join").status_code == 200
    assert _listed(client, workspace)[private_team]["is_member"] is True


def test_the_final_purge_stage_clears_the_marker(workspace: str, private_team: str, repositories: Any) -> None:
    """The marker outlives the tombstone, so the team stays hidden until the teams stage removes both."""
    from app.common.team_purge import Deadline, PurgeJob
    from app.domains.teams.consumers import purge

    assert repositories.teams.mark_deleting(workspace, private_team) is True
    assert repositories.memberships.is_private_team(workspace, private_team) is True

    purge.step(repositories, PurgeJob(workspace, private_team, "teams"), Deadline(30))

    assert repositories.memberships.is_private_team(workspace, private_team) is False
    assert repositories.memberships.list_private_team_ids(workspace) == ()
