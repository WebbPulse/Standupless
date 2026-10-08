"""Approved email domains: joining a workspace without an invite.

An admin approves their own verified email domain, public mail providers are
refused, and anyone whose verified email is on an approved domain can list the
workspace and join it as a member within the plan's member cap. Everything else
answers the same 404, and delegated credentials never join anything.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.memberships import APPROVED_DOMAIN_LIMIT
from app.common.db.dynamo.users import User
from app.common.plan_limits import PREVIEW_FREE_LIMITS, LimitedResource
from tests.domains.helpers import ADMIN, MEMBER, OUTSIDER, OWNER, add_member, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

DOMAINS_PATH = f"/api/workspaces/{WORKSPACE}/approved-domains"

JOIN_PATH = f"/api/workspaces/{WORKSPACE}/join"

JOINABLE_PATH = "/api/workspaces/joinable"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the workspaces application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["workspaces"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


def make_person(repositories: Any, user_id: str, email: str, *, verified: bool = True) -> User:
    """Put in a user row whose email is verified unless told otherwise."""
    return repositories.users.create(User(id=user_id, email=email, email_verified=verified))


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A workspace with an admin on acme.example and a member beside its owner."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    make_person(repositories, OWNER, "owner@acme.example")
    make_person(repositories, ADMIN, "admin@acme.example")
    make_person(repositories, MEMBER, "member@acme.example")
    return WORKSPACE


@pytest.fixture
def approved(repositories: Any, workspace: str) -> str:
    """The workspace approving acme.example."""
    repositories.memberships.add_approved_domain(workspace, "acme.example", added_by=ADMIN)
    return workspace


def test_an_admin_approves_lists_and_removes_their_own_domain(client: TestClient, workspace: str) -> None:
    sign_in(client, ADMIN)
    created = client.post(DOMAINS_PATH, json={"domain": "@ACME.example"})
    assert created.status_code == 201
    assert created.json()["domain"] == "acme.example"
    assert created.json()["added_by"] == ADMIN
    again = client.post(DOMAINS_PATH, json={"domain": "acme.example"})
    assert again.status_code == 201
    listed = client.get(DOMAINS_PATH)
    assert [row["domain"] for row in listed.json()["domains"]] == ["acme.example"]
    assert client.delete(f"{DOMAINS_PATH}/acme.example").status_code == 204
    assert client.get(DOMAINS_PATH).json()["domains"] == []


def test_another_domain_is_refused(client: TestClient, workspace: str) -> None:
    sign_in(client, ADMIN)
    response = client.post(DOMAINS_PATH, json={"domain": "rival.example"})
    assert response.status_code == 403
    assert response.json()["error_code"] == "DOMAIN_NOT_VERIFIED"


def test_an_unverified_admin_cannot_approve_their_domain(client: TestClient, workspace: str, repositories: Any) -> None:
    make_person(repositories, "01JB0000000000000000000UNV", "late@acme.example", verified=False)
    add_member(repositories, WORKSPACE, "01JB0000000000000000000UNV", "admin")
    sign_in(client, "01JB0000000000000000000UNV")
    response = client.post(DOMAINS_PATH, json={"domain": "acme.example"})
    assert response.status_code == 403
    assert response.json()["error_code"] == "DOMAIN_NOT_VERIFIED"


def test_a_public_provider_is_refused(client: TestClient, workspace: str, repositories: Any) -> None:
    make_person(repositories, "01JB0000000000000000000GML", "someone@gmail.com")
    add_member(repositories, WORKSPACE, "01JB0000000000000000000GML", "admin")
    sign_in(client, "01JB0000000000000000000GML")
    response = client.post(DOMAINS_PATH, json={"domain": "gmail.com"})
    assert response.status_code == 422
    assert response.json()["error_code"] == "PUBLIC_EMAIL_DOMAIN"


@pytest.mark.parametrize("value", ["localhost", "not a domain", "acme", "-acme.example"])
def test_an_invalid_domain_is_refused(client: TestClient, workspace: str, value: str) -> None:
    sign_in(client, ADMIN)
    response = client.post(DOMAINS_PATH, json={"domain": value})
    assert response.status_code == 422
    assert response.json()["error_code"] == "INVALID_DOMAIN"


def test_the_domain_list_is_capped(client: TestClient, workspace: str, repositories: Any) -> None:
    for index in range(APPROVED_DOMAIN_LIMIT):
        repositories.memberships.add_approved_domain(WORKSPACE, f"d{index}.example", added_by=OWNER)
    sign_in(client, ADMIN)
    response = client.post(DOMAINS_PATH, json={"domain": "acme.example"})
    assert response.status_code == 409
    assert response.json()["error_code"] == "LIMIT_EXCEEDED"


def test_a_member_cannot_manage_domains(client: TestClient, approved: str) -> None:
    sign_in(client, MEMBER)
    assert client.get(DOMAINS_PATH).status_code == 403
    assert client.post(DOMAINS_PATH, json={"domain": "acme.example"}).status_code == 403
    assert client.delete(f"{DOMAINS_PATH}/acme.example").status_code == 403


def test_domain_rows_never_show_up_as_members(client: TestClient, approved: str) -> None:
    sign_in(client, ADMIN)
    response = client.get(f"/api/workspaces/{WORKSPACE}/members")
    assert response.status_code == 200
    assert {row["user_id"] for row in response.json()["members"]} == {OWNER, ADMIN, MEMBER}


def test_a_verified_person_on_the_domain_sees_and_joins_the_workspace(
    client: TestClient, approved: str, repositories: Any
) -> None:
    make_person(repositories, OUTSIDER, "new@acme.example")
    sign_in(client, OUTSIDER)
    joinable = client.get(JOINABLE_PATH)
    assert joinable.status_code == 200
    assert [(row["id"], row["domain"]) for row in joinable.json()["workspaces"]] == [(WORKSPACE, "acme.example")]
    joined = client.post(JOIN_PATH)
    assert joined.status_code == 201
    assert joined.json()["role"] == "member"
    assert repositories.memberships.get(WORKSPACE, OUTSIDER).role == "member"
    assert client.post(JOIN_PATH).status_code == 200
    assert client.get(JOINABLE_PATH).json()["workspaces"] == []


def test_an_existing_member_is_not_offered_the_workspace(client: TestClient, approved: str) -> None:
    sign_in(client, MEMBER)
    assert client.get(JOINABLE_PATH).json()["workspaces"] == []


def test_another_domain_cannot_join(client: TestClient, approved: str, repositories: Any) -> None:
    make_person(repositories, OUTSIDER, "someone@rival.example")
    sign_in(client, OUTSIDER)
    assert client.get(JOINABLE_PATH).json()["workspaces"] == []
    response = client.post(JOIN_PATH)
    assert response.status_code == 404
    assert repositories.memberships.get(WORKSPACE, OUTSIDER) is None


def test_an_unverified_email_cannot_join(client: TestClient, approved: str, repositories: Any) -> None:
    make_person(repositories, OUTSIDER, "new@acme.example", verified=False)
    sign_in(client, OUTSIDER)
    assert client.get(JOINABLE_PATH).json()["workspaces"] == []
    assert client.post(JOIN_PATH).status_code == 404


def test_a_removed_domain_stops_admitting_people(client: TestClient, approved: str, repositories: Any) -> None:
    repositories.memberships.remove_approved_domain(WORKSPACE, "acme.example")
    make_person(repositories, OUTSIDER, "new@acme.example")
    sign_in(client, OUTSIDER)
    assert client.post(JOIN_PATH).status_code == 404


def test_a_missing_workspace_answers_the_same_404(client: TestClient, approved: str, repositories: Any) -> None:
    make_person(repositories, OUTSIDER, "new@acme.example")
    sign_in(client, OUTSIDER)
    response = client.post("/api/workspaces/01JB00000000000000000MISS/join")
    assert response.status_code == 404


def test_joining_respects_the_member_cap(
    client: TestClient, approved: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setitem(PREVIEW_FREE_LIMITS, LimitedResource.MEMBERS, 3)
    make_person(repositories, OUTSIDER, "new@acme.example")
    sign_in(client, OUTSIDER)
    response = client.post(JOIN_PATH)
    assert response.status_code == 403
    assert response.json()["error_code"] == "PLAN_LIMIT_REACHED"
    assert repositories.memberships.get(WORKSPACE, OUTSIDER) is None


def test_an_api_key_cannot_list_or_join(client: TestClient, approved: str, repositories: Any) -> None:
    make_person(repositories, OUTSIDER, "new@acme.example")
    sign_in(client, OUTSIDER, actor="api_key", workspace_id=WORKSPACE)
    assert client.get(JOINABLE_PATH).status_code == 403
    assert client.post(JOIN_PATH).status_code == 403
    assert repositories.memberships.get(WORKSPACE, OUTSIDER) is None
