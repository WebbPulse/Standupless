"""Team membership and privacy in the workspace audit log.

Adding someone to a team, changing their role, removing them, joining, leaving and
turning privacy on or off each leave an entry naming the person and the team, and
a write that changes nothing leaves none.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.audit import AuditEvent, AuditQuery

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_member, make_team, make_user, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

MEMBERS = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/members"


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
    """A Business workspace with one open team and a named admin and member."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    repositories.workspaces.set_billing(WORKSPACE, plan="business")
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    make_user(repositories, ADMIN, "admin@example.com", "Adam Admin")
    make_user(repositories, MEMBER, "member@example.com", "Mo Member")
    make_team(repositories, WORKSPACE, TEAM, "SEC")
    return WORKSPACE


def logged(repositories: Any, action: str) -> list[AuditEvent]:
    """The workspace's audit entries of one kind, newest first."""
    return repositories.audit.list_events(WORKSPACE, AuditQuery(action=action)).events


def test_an_admin_adding_changing_and_removing_a_member_is_recorded(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Each step names the person and the team, and restating a role records nothing."""
    sign_in(client, ADMIN)
    assert client.put(f"{MEMBERS}/{ADMIN}", json={"role": "admin"}).status_code == 200
    assert client.put(f"{MEMBERS}/{MEMBER}", json={"role": "member"}).status_code == 200
    assert client.put(f"{MEMBERS}/{MEMBER}", json={"role": "member"}).status_code == 200
    assert client.put(f"{MEMBERS}/{MEMBER}", json={"role": "admin"}).status_code == 200
    assert client.delete(f"{MEMBERS}/{MEMBER}").status_code == 204

    added = {row.target.id: row for row in logged(repositories, "team_member.added")}
    [changed] = logged(repositories, "team_member.role_changed")
    [removed] = logged(repositories, "team_member.removed")
    assert sorted(added) == sorted([ADMIN, MEMBER])
    assert added[MEMBER].actor.id == ADMIN and added[MEMBER].target.label == "Mo Member"
    assert added[MEMBER].after == {"team_id": TEAM, "team": "Sec", "role": "member"}
    assert changed.before is not None and changed.before["role"] == "member"
    assert changed.after is not None and changed.after["role"] == "admin"
    assert removed.before == {"team_id": TEAM, "team": "Sec", "role": "admin"}


def test_joining_and_leaving_are_recorded_as_the_member(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A member joining an open team and leaving it is the actor and the target of both entries."""
    sign_in(client, MEMBER)
    assert client.post(f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/join").status_code == 200
    assert client.post(f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/join").status_code == 200
    assert client.post(f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/leave").status_code == 204

    [joined] = logged(repositories, "team_member.joined")
    [left] = logged(repositories, "team_member.left")
    assert (joined.actor.id, joined.target.id) == (MEMBER, MEMBER)
    assert left.before is not None and left.before["role"] == "member"


def test_turning_privacy_on_and_off_is_recorded(client: TestClient, workspace: str, repositories: Any) -> None:
    """Each flip leaves one entry with before and after, and a patch that keeps it leaves none."""
    sign_in(client, ADMIN)
    team = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}"
    assert client.patch(team, json={"private": True}).status_code == 200
    assert client.patch(team, json={"private": True}).status_code == 200
    assert client.patch(team, json={"private": False}).status_code == 200

    rows = logged(repositories, "team.privacy_changed")
    assert sorted((row.before["private"], row.after["private"]) for row in rows if row.before and row.after) == [
        (False, True),
        (True, False),
    ]
    assert all(row.target.id == TEAM and row.actor.id == ADMIN for row in rows)
