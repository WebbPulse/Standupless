"""Bulk member actions on the workspace members list, against real tables in moto.

One request applies one action to several members. Each member goes through the
single-member path, so the rules a single change obeys hold per member, a member
the caller may not change is skipped with the reason, and every change is audited
as a single change is.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.audit import AuditQuery

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import (
    ADMIN,
    GUEST,
    MEMBER,
    OUTSIDER,
    OWNER,
    add_member,
    add_team_member,
    make_team,
    make_user,
    make_workspace,
    sign_in,
)

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

SECOND_OWNER = "01JB00000000000000000OWNR2"

SECOND_MEMBER = "01JB00000000000000000MEM02"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client carrying every domain, as the deployed gateway reaches them."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(list(DOMAINS.values()))
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A workspace with two owners, an admin, two members, a guest and one team the first member admins."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, SECOND_OWNER, "owner")
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, SECOND_MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    for user_id, name in (
        (OWNER, "Olive"),
        (SECOND_OWNER, "Otto"),
        (ADMIN, "Adam"),
        (MEMBER, "Mo"),
        (SECOND_MEMBER, "Mia"),
        (GUEST, "Gus"),
    ):
        make_user(repositories, user_id, f"{user_id.lower()}@example.com", name)
    make_team(repositories, WORKSPACE, TEAM, "ABC")
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "admin")
    return WORKSPACE


def bulk(client: TestClient, action: str, user_ids: list[str], **extra: Any) -> Any:
    """Call the bulk members route with one action."""
    return client.post(
        f"/api/workspaces/{WORKSPACE}/members/bulk",
        json={"action": action, "user_ids": user_ids, **extra},
    )


def outcomes(response: Any) -> dict[str, str]:
    """Each named member's outcome, by user id."""
    return {result["user_id"]: result["outcome"] for result in response.json()["results"]}


def test_an_admin_changes_several_roles_in_one_request(client: TestClient, repositories: Any, workspace: str) -> None:
    """Every named member takes the role, and each change is audited on its own."""
    sign_in(client, ADMIN)

    response = bulk(client, "change_role", [MEMBER, SECOND_MEMBER], role="admin")

    assert response.status_code == 200
    body = response.json()
    assert body["changed"] == 2 and body["skipped"] == 0
    assert [result["member"]["role"] for result in body["results"]] == ["admin", "admin"]
    assert repositories.memberships.get(WORKSPACE, MEMBER).role == "admin"
    events = repositories.audit.list_events(WORKSPACE, AuditQuery(action="member.role_changed")).events
    assert sorted(event.target.id for event in events) == sorted([MEMBER, SECOND_MEMBER])


def test_a_member_already_holding_the_role_is_unchanged(client: TestClient, workspace: str) -> None:
    """Restating a role is reported as unchanged rather than as a change."""
    sign_in(client, ADMIN)

    response = bulk(client, "change_role", [MEMBER, GUEST], role="guest")

    assert outcomes(response) == {MEMBER: "changed", GUEST: "unchanged"}
    assert response.json()["unchanged"] == 1


def test_the_caller_is_skipped_with_a_reason(client: TestClient, repositories: Any, workspace: str) -> None:
    """A bulk action is for other people, so the caller's own row is left alone and named."""
    sign_in(client, ADMIN)

    response = bulk(client, "suspend", [ADMIN, MEMBER])

    [own, other] = response.json()["results"]
    assert own["outcome"] == "skipped" and own["error_code"] == "SELF"
    assert other["outcome"] == "changed"
    assert not repositories.memberships.get(WORKSPACE, ADMIN).is_suspended


def test_an_admin_cannot_touch_an_owner(client: TestClient, repositories: Any, workspace: str) -> None:
    """The owner-only rule holds per member: the owner is skipped and the member still changes."""
    sign_in(client, ADMIN)

    response = bulk(client, "remove", [OWNER, MEMBER])

    body = response.json()
    assert outcomes(response) == {OWNER: "skipped", MEMBER: "changed"}
    assert body["results"][0]["error_code"] == "FORBIDDEN"
    assert repositories.memberships.get(WORKSPACE, OWNER) is not None
    assert repositories.memberships.get(WORKSPACE, MEMBER) is None


def test_an_owner_demotes_every_other_owner(client: TestClient, repositories: Any, workspace: str) -> None:
    """An owner may change other owners in bulk, and as the caller is never touched an owner always stays."""
    sign_in(client, OWNER)

    response = bulk(client, "change_role", [OWNER, SECOND_OWNER, MEMBER], role="member")

    assert outcomes(response) == {OWNER: "skipped", SECOND_OWNER: "changed", MEMBER: "unchanged"}
    assert repositories.memberships.count_owners(WORKSPACE) == 1
    assert repositories.memberships.get(WORKSPACE, OWNER).role == "owner"


def test_an_admin_granting_ownership_is_skipped_per_member(client: TestClient, workspace: str) -> None:
    """Only an owner grants ownership, so an admin's bulk promotion skips every member with the reason."""
    sign_in(client, ADMIN)

    response = bulk(client, "change_role", [MEMBER, SECOND_MEMBER], role="owner")

    body = response.json()
    assert body["skipped"] == 2 and body["changed"] == 0
    assert {result["error_code"] for result in body["results"]} == {"FORBIDDEN"}


def test_suspend_and_reactivate_report_what_changed(client: TestClient, repositories: Any, workspace: str) -> None:
    """An already suspended member is unchanged by a suspend, and an active one by a reactivate."""
    sign_in(client, ADMIN)
    repositories.memberships.set_suspended(WORKSPACE, MEMBER, suspended_by=ADMIN)

    suspended = bulk(client, "suspend", [MEMBER, SECOND_MEMBER])
    assert outcomes(suspended) == {MEMBER: "unchanged", SECOND_MEMBER: "changed"}

    reactivated = bulk(client, "reactivate", [MEMBER, SECOND_MEMBER, GUEST])
    assert outcomes(reactivated) == {MEMBER: "changed", SECOND_MEMBER: "changed", GUEST: "unchanged"}
    events = repositories.audit.list_events(WORKSPACE, AuditQuery(action="member.reactivated")).events
    assert sorted(event.target.id for event in events) == sorted([MEMBER, SECOND_MEMBER])


def test_removing_several_members_audits_each(client: TestClient, repositories: Any, workspace: str) -> None:
    """Each removed member gets its own audit event, and their team rows go with them."""
    sign_in(client, ADMIN)

    response = bulk(client, "remove", [MEMBER, GUEST])

    assert response.json()["changed"] == 2
    assert repositories.memberships.get_team_membership(WORKSPACE, TEAM, MEMBER) is None
    events = repositories.audit.list_events(WORKSPACE, AuditQuery(action="member.removed")).events
    assert sorted(event.target.id for event in events) == sorted([MEMBER, GUEST])


def test_an_unknown_member_is_skipped_as_not_found(client: TestClient, workspace: str) -> None:
    """Someone outside the workspace is skipped with the single route's 404 error."""
    sign_in(client, ADMIN)

    response = bulk(client, "suspend", [OUTSIDER, MEMBER])

    [missing, found] = response.json()["results"]
    assert missing["outcome"] == "skipped" and missing["error_code"] == "NOT_FOUND"
    assert found["outcome"] == "changed"


def test_adding_several_members_to_a_team(client: TestClient, repositories: Any, workspace: str) -> None:
    """New members join as team members, an existing team admin keeps their role, and the caller may add themselves."""
    sign_in(client, ADMIN)

    response = bulk(client, "add_to_team", [MEMBER, SECOND_MEMBER, ADMIN], team_id=TEAM)

    assert outcomes(response) == {MEMBER: "unchanged", SECOND_MEMBER: "changed", ADMIN: "changed"}
    assert repositories.memberships.get_team_membership(WORKSPACE, TEAM, MEMBER).role == "admin"
    assert repositories.memberships.get_team_membership(WORKSPACE, TEAM, SECOND_MEMBER).role == "member"
    events = repositories.audit.list_events(WORKSPACE, AuditQuery(action="team_member.added")).events
    assert sorted(event.target.id for event in events) == sorted([SECOND_MEMBER, ADMIN])


def test_adding_to_an_unknown_team_fails_the_request(client: TestClient, workspace: str) -> None:
    """The team is checked once, before any member, so a bad team changes nobody."""
    sign_in(client, ADMIN)

    response = bulk(client, "add_to_team", [MEMBER], team_id="01JB000000000000000000NOPE")

    assert response.status_code == 404


def test_a_member_cannot_act_in_bulk(client: TestClient, workspace: str) -> None:
    """Bulk member actions are workspace admin work, even for a team admin."""
    sign_in(client, MEMBER)

    assert bulk(client, "add_to_team", [SECOND_MEMBER], team_id=TEAM).status_code == 403
    assert bulk(client, "remove", [SECOND_MEMBER]).status_code == 403


@pytest.mark.parametrize(
    "body",
    [
        {"action": "change_role", "user_ids": [MEMBER]},
        {"action": "add_to_team", "user_ids": [MEMBER]},
        {"action": "suspend", "user_ids": [MEMBER], "role": "admin"},
        {"action": "suspend", "user_ids": []},
        {"action": "suspend", "user_ids": [" "]},
        {"action": "promote", "user_ids": [MEMBER]},
    ],
)
def test_a_malformed_body_is_refused(client: TestClient, workspace: str, body: dict[str, Any]) -> None:
    """A missing role or team, an argument the action does not take, or no members is a 422."""
    sign_in(client, ADMIN)

    response = client.post(f"/api/workspaces/{WORKSPACE}/members/bulk", json=body)

    assert response.status_code == 422


def test_repeated_ids_are_acted_on_once(client: TestClient, repositories: Any, workspace: str) -> None:
    """A repeated id answers one result and writes one audit event."""
    sign_in(client, ADMIN)

    response = bulk(client, "suspend", [MEMBER, MEMBER])

    assert len(response.json()["results"]) == 1
    events = repositories.audit.list_events(WORKSPACE, AuditQuery(action="member.suspended")).events
    assert [event.target.id for event in events] == [MEMBER]
