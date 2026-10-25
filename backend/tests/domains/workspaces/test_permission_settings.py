"""Workspace permission settings: who may invite members and who may create teams.

Covers both defaults, an admin changing each setting with an audit row, the role
ceiling on a member's invite, revoking one's own invite, and the team route
honouring the team creation setting.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_member, make_user, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

INVITES = f"/api/workspaces/{WORKSPACE}/invites"

TEAMS = f"/api/workspaces/{WORKSPACE}/teams"


def app_client(repositories: Any, domain: str) -> Iterator[TestClient]:
    """A client for one domain's application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS[domain])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the workspaces application."""
    yield from app_client(repositories, "workspaces")


@pytest.fixture
def teams_client(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application."""
    yield from app_client(repositories, "teams")


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A Business workspace with one member of each role."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    repositories.workspaces.set_billing(WORKSPACE, plan="business")
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    for user_id, name in ((OWNER, "Olive Owner"), (ADMIN, "Adam Admin"), (MEMBER, "Mo Member"), (GUEST, "Gus Guest")):
        make_user(repositories, user_id, f"{user_id.lower()}@example.com", name)
    return WORKSPACE


def allow_members(repositories: Any, **fields: str) -> None:
    """Set permission fields directly, skipping the route."""
    repositories.workspaces.set_permissions(WORKSPACE, **fields)


def invite(client: TestClient, email: str, role: str = "member") -> Any:
    """Post one invite as whoever is signed in."""
    return client.post(INVITES, json={"email": email, "role": role})


def test_the_defaults_keep_invites_to_admins_and_let_members_create_teams(
    client: TestClient, teams_client: TestClient, workspace: str
) -> None:
    sign_in(client, MEMBER)
    read = client.get(f"/api/workspaces/{WORKSPACE}").json()

    assert read["invite_permission"] == "admins"
    assert read["team_creation_permission"] == "members"
    refused = invite(client, "new@example.com")
    assert refused.status_code == 403
    assert "Only workspace admins can invite" in refused.json()["message"]
    sign_in(teams_client, MEMBER)
    assert teams_client.post(TEAMS, json={"name": "Platform", "key_prefix": "PLT"}).status_code == 201


def test_an_admin_changes_both_settings_and_the_change_is_audited(client: TestClient, workspace: str) -> None:
    sign_in(client, ADMIN)
    response = client.patch(
        f"/api/workspaces/{WORKSPACE}", json={"invite_permission": "members", "team_creation_permission": "admins"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["invite_permission"] == "members"
    assert response.json()["team_creation_permission"] == "admins"
    [row] = client.get(f"/api/workspaces/{WORKSPACE}/audit-log", params={"event": "workspace.updated"}).json()["events"]
    assert row["before"] == {"invite_permission": "admins", "team_creation_permission": "members"}
    assert row["after"] == {"invite_permission": "members", "team_creation_permission": "admins"}


def test_a_member_cannot_change_the_settings_and_a_bad_value_is_refused(client: TestClient, workspace: str) -> None:
    sign_in(client, MEMBER)
    assert client.patch(f"/api/workspaces/{WORKSPACE}", json={"invite_permission": "members"}).status_code == 403

    sign_in(client, ADMIN)
    assert client.patch(f"/api/workspaces/{WORKSPACE}", json={"invite_permission": "everyone"}).status_code == 422


def test_a_member_invites_at_member_or_guest_but_never_admin(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    allow_members(repositories, invite_permission="members")
    sign_in(client, MEMBER)

    assert invite(client, "one@example.com", "member").status_code == 201
    assert invite(client, "two@example.com", "guest").status_code == 201
    as_admin = invite(client, "three@example.com", "admin")
    assert as_admin.status_code == 403
    assert "as an admin" in as_admin.json()["message"]
    assert invite(client, "four@example.com", "owner").status_code in (403, 422)
    assert client.get(INVITES).status_code == 403
    assert sorted(row.email for row in repositories.invites.list_for_workspace(WORKSPACE)) == [
        "one@example.com",
        "two@example.com",
    ]


def test_a_guest_never_invites(client: TestClient, repositories: Any, workspace: str) -> None:
    allow_members(repositories, invite_permission="members")
    sign_in(client, GUEST)

    assert invite(client, "new@example.com").status_code == 403


def test_a_member_revokes_their_own_invite_but_not_another(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    allow_members(repositories, invite_permission="members")
    sign_in(client, ADMIN)
    theirs = invite(client, "admins@example.com").json()["invite_id"]
    sign_in(client, MEMBER)
    mine = invite(client, "mine@example.com").json()["invite_id"]

    refused = client.delete(f"{INVITES}/{theirs}")
    assert refused.status_code == 403
    assert "someone else sent" in refused.json()["message"]
    assert client.delete(f"{INVITES}/{mine}").status_code == 204
    assert [row.invite_id for row in repositories.invites.list_for_workspace(WORKSPACE)] == [theirs]


def test_an_admin_still_revokes_any_invite(client: TestClient, repositories: Any, workspace: str) -> None:
    allow_members(repositories, invite_permission="members")
    sign_in(client, MEMBER)
    sent = invite(client, "mine@example.com").json()["invite_id"]

    sign_in(client, ADMIN)
    assert client.delete(f"{INVITES}/{sent}").status_code == 204
    assert repositories.invites.list_for_workspace(WORKSPACE) == []


def test_admins_only_team_creation_refuses_a_member_and_allows_an_admin(
    teams_client: TestClient, repositories: Any, workspace: str
) -> None:
    allow_members(repositories, team_creation_permission="admins")

    sign_in(teams_client, MEMBER)
    refused = teams_client.post(TEAMS, json={"name": "Platform", "key_prefix": "PLT"})
    assert refused.status_code == 403
    assert "Only workspace admins can create teams" in refused.json()["message"]
    sign_in(teams_client, GUEST)
    assert teams_client.post(TEAMS, json={"name": "Guests", "key_prefix": "GST"}).status_code == 403
    sign_in(teams_client, ADMIN)
    assert teams_client.post(TEAMS, json={"name": "Platform", "key_prefix": "PLT"}).status_code == 201


def test_a_guest_cannot_create_a_team_under_the_default(teams_client: TestClient, workspace: str) -> None:
    sign_in(teams_client, GUEST)

    assert teams_client.post(TEAMS, json={"name": "Guests", "key_prefix": "GST"}).status_code == 403
