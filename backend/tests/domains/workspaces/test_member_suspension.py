"""Suspending and reactivating workspace members, against real tables in moto.

A suspended member keeps their role, teams and history but holds no access to the
workspace on any credential, leaves billable seats, pickers and notifications, and
gets everything back unchanged on reactivation.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from webbpulse.audit import AuditQuery

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
    make_user,
    make_workspace,
    sign_in,
    sign_out,
)

WORKSPACE = "01JB00000000000000000000WS"

OTHER_WORKSPACE = "01JB0000000000000000000WS2"

TEAM = "01JB000000000000000000PRJ1"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client carrying every domain, so a suspension is tried on more than the workspaces routes."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(list(DOMAINS.values()))
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A workspace with an owner, an admin, a member on one team and a guest."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    for user_id, name in ((OWNER, "Olive"), (ADMIN, "Adam"), (MEMBER, "Mo"), (GUEST, "Gus")):
        make_user(repositories, user_id, f"{user_id.lower()}@example.com", name)
    make_team(repositories, WORKSPACE, TEAM, "ABC")
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "admin")
    return WORKSPACE


def suspend(client: TestClient, user_id: str) -> Any:
    """Call the suspend route for one member."""
    return client.post(f"/api/workspaces/{WORKSPACE}/members/{user_id}/suspend")


def reactivate(client: TestClient, user_id: str) -> Any:
    """Call the reactivate route for one member."""
    return client.post(f"/api/workspaces/{WORKSPACE}/members/{user_id}/reactivate")


def test_an_admin_suspends_a_member_who_keeps_role_and_teams(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """The membership stays with its role and team rows, stamped with who suspended it."""
    sign_in(client, ADMIN)

    response = suspend(client, MEMBER)

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "suspended"
    assert body["role"] == "member"
    assert body["suspended_by"] == ADMIN
    assert body["suspended_at"]
    row = repositories.memberships.get(WORKSPACE, MEMBER)
    assert row.is_suspended and row.role == "member"
    assert repositories.memberships.get_team_membership(WORKSPACE, TEAM, MEMBER).role == "admin"


def test_a_suspended_member_is_refused_on_their_next_request(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """The session no longer reaches the workspace, answered as a workspace they are not in."""
    sign_in(client, MEMBER)
    assert client.get(f"/api/workspaces/{WORKSPACE}/members").status_code == 200

    repositories.memberships.set_suspended(WORKSPACE, MEMBER, suspended_by=ADMIN)

    assert client.get(f"/api/workspaces/{WORKSPACE}/members").status_code == 404
    assert client.get(f"/api/workspaces/{WORKSPACE}/teams").status_code == 404


def test_a_suspended_members_api_key_stops_working(client: TestClient, repositories: Any, workspace: str) -> None:
    """A personal key resolves through the same membership, so it fails the same way."""
    from webbpulse.identity.api_keys import mint as mint_key

    secret = mint_key(
        user_id=MEMBER,
        tenant_id=WORKSPACE,
        scopes=("members:read",),
        name="Suspension key",
        store=repositories.api_keys,
        created_by=MEMBER,
    ).plaintext
    sign_out(client)
    client.headers["authorization"] = f"Bearer {secret}"
    assert client.get(f"/api/workspaces/{WORKSPACE}/members").status_code == 200

    repositories.memberships.set_suspended(WORKSPACE, MEMBER, suspended_by=ADMIN)

    assert client.get(f"/api/workspaces/{WORKSPACE}/members").status_code == 404


def test_other_workspaces_are_unaffected(client: TestClient, repositories: Any, workspace: str) -> None:
    """Suspension is per workspace: the same person keeps every other membership."""
    make_workspace(repositories, OTHER_WORKSPACE, "other", MEMBER)
    repositories.memberships.set_suspended(WORKSPACE, MEMBER, suspended_by=ADMIN)
    sign_in(client, MEMBER)

    assert client.get(f"/api/workspaces/{OTHER_WORKSPACE}/members").status_code == 200
    listed = [row["id"] for row in client.get("/api/workspaces").json()["workspaces"]]
    assert listed == [OTHER_WORKSPACE]


def test_reactivating_restores_the_same_access(client: TestClient, repositories: Any, workspace: str) -> None:
    """Reactivation clears the suspension and leaves role and teams as they were."""
    sign_in(client, ADMIN)
    suspend(client, MEMBER)

    response = reactivate(client, MEMBER)

    assert response.status_code == 200
    assert response.json()["status"] == "active"
    assert response.json()["suspended_at"] is None
    row = repositories.memberships.get(WORKSPACE, MEMBER)
    assert not row.is_suspended and row.role == "member"
    assert repositories.memberships.get_team_membership(WORKSPACE, TEAM, MEMBER).role == "admin"
    sign_in(client, MEMBER)
    assert client.get(f"/api/workspaces/{WORKSPACE}/members").status_code == 200


def test_both_actions_are_audited(client: TestClient, repositories: Any, workspace: str) -> None:
    """Suspending and reactivating each write one event naming the member."""
    sign_in(client, ADMIN)
    suspend(client, MEMBER)
    reactivate(client, MEMBER)
    reactivate(client, MEMBER)

    [suspended] = repositories.audit.list_events(WORKSPACE, AuditQuery(action="member.suspended")).events
    [reactivated] = repositories.audit.list_events(WORKSPACE, AuditQuery(action="member.reactivated")).events
    assert suspended.actor.id == ADMIN and suspended.target.id == MEMBER
    assert reactivated.after == {"status": "active"}


def test_a_member_cannot_suspend_anyone(client: TestClient, repositories: Any, workspace: str) -> None:
    """Suspension is admin work."""
    sign_in(client, MEMBER)

    assert suspend(client, GUEST).status_code == 403
    assert not repositories.memberships.get(WORKSPACE, GUEST).is_suspended


def test_an_admin_cannot_suspend_themselves(client: TestClient, repositories: Any, workspace: str) -> None:
    """Suspending yourself would lock you out with nobody asked."""
    sign_in(client, ADMIN)

    assert suspend(client, ADMIN).status_code == 409
    assert not repositories.memberships.get(WORKSPACE, ADMIN).is_suspended


def test_an_admin_cannot_suspend_an_owner(client: TestClient, repositories: Any, workspace: str) -> None:
    """Acting on an owner is owner work, as a role change or a removal is."""
    sign_in(client, ADMIN)

    assert suspend(client, OWNER).status_code == 403
    assert not repositories.memberships.get(WORKSPACE, OWNER).is_suspended


def test_the_last_active_owner_cannot_be_suspended(client: TestClient, repositories: Any, workspace: str) -> None:
    """An owner suspends a co-owner, but never the one owner left active."""
    add_member(repositories, WORKSPACE, MEMBER, "owner")
    sign_in(client, OWNER)
    assert suspend(client, MEMBER).status_code == 200

    assert repositories.memberships.count_owners(WORKSPACE) == 1
    assert client.delete(f"/api/workspaces/{WORKSPACE}/members/{OWNER}").status_code == 409


def test_suspending_twice_is_a_conflict(client: TestClient, repositories: Any, workspace: str) -> None:
    """The first suspension's actor and time stay."""
    sign_in(client, ADMIN)
    suspend(client, MEMBER)

    assert suspend(client, MEMBER).status_code == 409
    assert repositories.memberships.get(WORKSPACE, MEMBER).suspended_by == ADMIN


def test_the_members_list_carries_status_and_filters_on_it(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """Active and suspended by default, one status on request, invites only when asked."""
    sign_in(client, OWNER)
    suspend(client, MEMBER)
    client.post(f"/api/workspaces/{WORKSPACE}/invites", json={"email": "new@example.com", "role": "member"})

    default = {
        row["user_id"]: row["status"] for row in client.get(f"/api/workspaces/{WORKSPACE}/members").json()["members"]
    }
    assert default[MEMBER] == "suspended"
    assert default[OWNER] == "active"
    assert "invited" not in default.values()

    suspended = client.get(f"/api/workspaces/{WORKSPACE}/members", params={"status": "suspended"}).json()["members"]
    assert [row["user_id"] for row in suspended] == [MEMBER]

    invited = client.get(f"/api/workspaces/{WORKSPACE}/members", params={"status": "invited"}).json()["members"]
    assert [row["email"] for row in invited] == ["new@example.com"]
    assert invited[0]["invite_id"] == invited[0]["user_id"]

    assert client.get(f"/api/workspaces/{WORKSPACE}/members", params={"status": "gone"}).status_code == 422


def test_a_member_sees_no_invited_rows(client: TestClient, repositories: Any, workspace: str) -> None:
    """The invites list is admin only, so the members list keeps invites from everyone else."""
    sign_in(client, OWNER)
    client.post(f"/api/workspaces/{WORKSPACE}/invites", json={"email": "new@example.com", "role": "member"})
    sign_in(client, MEMBER)

    invited = client.get(f"/api/workspaces/{WORKSPACE}/members", params={"status": "invited"}).json()["members"]
    assert invited == []


def test_a_suspended_member_holds_no_billable_seat(repositories: Any, workspace: str) -> None:
    """Seats count active members only, so suspending frees one and reactivating takes it back."""
    from app.common.billing import seat_count

    assert seat_count(repositories, WORKSPACE) == 3
    repositories.memberships.set_suspended(WORKSPACE, MEMBER, suspended_by=ADMIN)
    assert seat_count(repositories, WORKSPACE) == 2
    repositories.memberships.clear_suspended(WORKSPACE, MEMBER)
    assert seat_count(repositories, WORKSPACE) == 3


def test_a_suspended_member_cannot_take_new_work_or_notifications(repositories: Any, workspace: str) -> None:
    """New assignment is refused, and the notification gates leave them out."""
    from app.common.issue_rules import check_assignee
    from app.common.team_privacy import person_can_see_team
    from app.domains.views.consumers.notify import can_receive_workspace_subject

    repositories.memberships.set_suspended(WORKSPACE, MEMBER, suspended_by=ADMIN)

    with pytest.raises(HTTPException) as refused:
        check_assignee(repositories, WORKSPACE, TEAM, MEMBER)
    assert refused.value.status_code == 422
    assert not person_can_see_team(repositories, WORKSPACE, TEAM, MEMBER)
    assert not can_receive_workspace_subject(repositories, WORKSPACE, MEMBER)
    assert repositories.memberships.suspended_user_ids(WORKSPACE) == frozenset({MEMBER})
