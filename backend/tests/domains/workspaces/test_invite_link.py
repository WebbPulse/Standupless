"""The reusable workspace invite link: enable, reset, disable, preview and join.

Covers the token being stored only as a hash and rotating on reset, disabling
taking effect at once, one generic error for any dead token, the "who may invite"
setting deciding who manages the link, the member cap, required single sign-on,
a suspended member's refusal, delegated credentials, the audit trail and the
link routes' own rate limit class.
"""

from __future__ import annotations

import time
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.invites import hash_token
from app.common.db.dynamo.memberships import INVITE_LINK_KEY
from app.common.db.dynamo.users import User
from app.common.plan_limits import PREVIEW_FREE_LIMITS, LimitedResource
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OUTSIDER, OWNER, add_member, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

LINK = f"/api/workspaces/{WORKSPACE}/invite-link"

PREVIEW = "/api/invites/link/preview"

JOIN = "/api/invites/link/join"

SSO_AMR = ["sso", "oidc"]


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
    """A workspace with one person of each role and a verified outsider on another domain."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    make_person(repositories, OWNER, "owner@acme.example")
    make_person(repositories, ADMIN, "admin@acme.example")
    make_person(repositories, MEMBER, "member@acme.example")
    make_person(repositories, GUEST, "guest@acme.example")
    make_person(repositories, OUTSIDER, "someone@elsewhere.example")
    return WORKSPACE


def enable(client: TestClient) -> str:
    """Enable or reset the link as an admin and answer its token."""
    sign_in(client, ADMIN)
    response = client.post(LINK)
    assert response.status_code == 201, response.text
    return response.json()["token"]


def actions(repositories: Any) -> list[str]:
    """Every audit action recorded in the workspace, oldest first."""
    return sorted(row.action for row in repositories.audit.list_events(WORKSPACE).events)


def test_an_admin_enables_the_link_and_only_its_hash_is_stored(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    sign_in(client, ADMIN)
    assert client.get(LINK).json() == {"enabled": False, "created_by": None, "created_at": None}
    created = client.post(LINK)
    assert created.status_code == 201
    token = created.json()["token"]
    assert len(token) >= 43
    stored = repositories.memberships.get_invite_link(WORKSPACE)
    assert stored.token_hash == hash_token(token)
    assert token not in stored.model_dump_json()
    status_body = client.get(LINK).json()
    assert status_body["enabled"] is True
    assert status_body["created_by"] == ADMIN
    assert "token" not in status_body


def test_resetting_rotates_the_token_and_the_old_link_stops_working_at_once(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    old = enable(client)
    new = enable(client)
    assert new != old
    sign_in(client, OUTSIDER)
    refused = client.post(JOIN, json={"token": old})
    assert refused.status_code == 400
    assert refused.json()["error_code"] == "INVALID_INVITE"
    assert repositories.memberships.get(WORKSPACE, OUTSIDER) is None
    assert client.post(JOIN, json={"token": new}).status_code == 201


def test_disabling_stops_the_link_and_a_second_disable_is_harmless(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    token = enable(client)
    assert client.delete(LINK).status_code == 204
    assert client.delete(LINK).status_code == 204
    assert client.get(LINK).json()["enabled"] is False
    sign_in(client, OUTSIDER)
    assert client.post(PREVIEW, json={"token": token}).status_code == 400
    assert client.post(JOIN, json={"token": token}).status_code == 400
    assert repositories.memberships.get(WORKSPACE, OUTSIDER) is None


@pytest.mark.parametrize("token", ["nope", "x" * 43, "a" * 256])
def test_an_unknown_token_answers_the_one_generic_error(client: TestClient, workspace: str, token: str) -> None:
    enable(client)
    sign_in(client, OUTSIDER)
    for path in (PREVIEW, JOIN):
        response = client.post(path, json={"token": token})
        assert response.status_code == 400
        assert response.json()["error_code"] == "INVALID_INVITE"


def test_the_preview_names_the_workspace_and_joining_adds_a_member(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    token = enable(client)
    sign_in(client, OUTSIDER)
    preview = client.post(PREVIEW, json={"token": token})
    assert preview.status_code == 200
    assert preview.json() == {"workspace_id": WORKSPACE, "name": "Acme", "slug": "acme", "already_member": False}
    joined = client.post(JOIN, json={"token": token})
    assert joined.status_code == 201
    assert joined.json()["role"] == "member"
    assert repositories.memberships.get(WORKSPACE, OUTSIDER).role == "member"
    again = client.post(JOIN, json={"token": token})
    assert again.status_code == 200
    assert client.post(PREVIEW, json={"token": token}).json()["already_member"] is True


def test_an_existing_guest_keeps_their_role(client: TestClient, workspace: str, repositories: Any) -> None:
    token = enable(client)
    sign_in(client, GUEST)
    response = client.post(JOIN, json={"token": token})
    assert response.status_code == 200
    assert repositories.memberships.get(WORKSPACE, GUEST).role == "guest"


def test_a_member_cannot_see_or_manage_the_link_under_the_default(client: TestClient, workspace: str) -> None:
    enable(client)
    sign_in(client, MEMBER)
    assert client.get(LINK).status_code == 403
    assert client.post(LINK).status_code == 403
    assert client.delete(LINK).status_code == 403
    sign_in(client, GUEST)
    assert client.get(LINK).status_code == 403


def test_members_manage_the_link_when_members_may_invite(client: TestClient, workspace: str, repositories: Any) -> None:
    repositories.workspaces.set_permissions(WORKSPACE, invite_permission="members")
    sign_in(client, MEMBER)
    assert client.post(LINK).status_code == 201
    assert client.get(LINK).json()["created_by"] == MEMBER
    sign_in(client, GUEST)
    assert client.post(LINK).status_code == 403


def test_joining_respects_the_member_cap(
    client: TestClient, workspace: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = enable(client)
    monkeypatch.setitem(PREVIEW_FREE_LIMITS, LimitedResource.MEMBERS, 3)
    sign_in(client, OUTSIDER)
    response = client.post(JOIN, json={"token": token})
    assert response.status_code == 403
    assert response.json()["error_code"] == "PLAN_LIMIT_REACHED"
    assert repositories.memberships.get(WORKSPACE, OUTSIDER) is None


def test_required_sso_refuses_a_join_from_any_other_sign_in(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    token = enable(client)
    repositories.memberships.set_auth_policy(WORKSPACE, require_two_factor=False, updated_by=OWNER, require_sso=True)
    sign_in(client, OUTSIDER, amr=["pwd"])
    response = client.post(JOIN, json={"token": token})
    assert response.status_code == 403
    assert response.json()["error_code"] == "SSO_REQUIRED"
    assert repositories.memberships.get(WORKSPACE, OUTSIDER) is None
    sign_in(client, OUTSIDER, amr=SSO_AMR, sso_connection=WORKSPACE, auth_time=int(time.time()))
    assert client.post(JOIN, json={"token": token}).status_code == 201


def test_a_restricted_sign_in_method_is_refused(client: TestClient, workspace: str, repositories: Any) -> None:
    token = enable(client)
    repositories.memberships.set_auth_policy(
        WORKSPACE, require_two_factor=False, updated_by=OWNER, allowed_methods=["google"]
    )
    sign_in(client, OUTSIDER, amr=["pwd"])
    response = client.post(JOIN, json={"token": token})
    assert response.status_code == 403
    assert response.json()["error_code"] == "AUTH_POLICY_REQUIRED"


def test_a_suspended_member_cannot_rejoin_through_the_link(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    token = enable(client)
    repositories.memberships.set_suspended(WORKSPACE, MEMBER, suspended_by=ADMIN)
    sign_in(client, MEMBER)
    assert client.post(PREVIEW, json={"token": token}).json()["already_member"] is False
    response = client.post(JOIN, json={"token": token})
    assert response.status_code == 403
    assert response.json()["error_code"] == "MEMBER_SUSPENDED"
    assert repositories.memberships.get(WORKSPACE, MEMBER).is_suspended


def test_an_unverified_email_cannot_join(client: TestClient, workspace: str, repositories: Any) -> None:
    token = enable(client)
    make_person(repositories, "01JB0000000000000000000UNV", "late@elsewhere.example", verified=False)
    sign_in(client, "01JB0000000000000000000UNV")
    response = client.post(JOIN, json={"token": token})
    assert response.status_code == 403
    assert response.json()["error_code"] == "EMAIL_NOT_VERIFIED"


def test_an_api_key_cannot_preview_or_join(client: TestClient, workspace: str, repositories: Any) -> None:
    token = enable(client)
    sign_in(client, OUTSIDER, actor="api_key", workspace_id=WORKSPACE)
    assert client.post(PREVIEW, json={"token": token}).status_code == 403
    assert client.post(JOIN, json={"token": token}).status_code == 403
    assert repositories.memberships.get(WORKSPACE, OUTSIDER) is None


def test_enabling_resetting_disabling_and_joining_are_audited(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    enable(client)
    token = enable(client)
    sign_in(client, OUTSIDER)
    assert client.post(JOIN, json={"token": token}).status_code == 201
    sign_in(client, ADMIN)
    assert client.delete(LINK).status_code == 204
    assert actions(repositories) == sorted(
        ["invite_link.enabled", "invite_link.reset", "member.joined", "invite_link.disabled"]
    )
    [joined] = [row for row in repositories.audit.list_events(WORKSPACE).events if row.action == "member.joined"]
    assert joined.after == {"role": "member", "via": "invite_link"}


def test_the_link_row_never_shows_up_as_a_member(client: TestClient, workspace: str, repositories: Any) -> None:
    enable(client)
    response = client.get(f"/api/workspaces/{WORKSPACE}/members")
    assert response.status_code == 200
    assert {row["user_id"] for row in response.json()["members"]} == {OWNER, ADMIN, MEMBER, GUEST}
    assert repositories.memberships.get_invite_link(WORKSPACE) is not None
    assert INVITE_LINK_KEY == "invite_link"


def test_the_link_routes_have_their_own_rate_limit_class() -> None:
    from webbpulse.ratelimit import classify

    from app.common.api.middleware import rate_limit_tiers, rate_limiter

    classes = rate_limiter.limit_classes()
    for path in (PREVIEW, JOIN):
        assert classify("POST", path, classes).name == rate_limiter.INVITE_LINK_CLASS
    assert classify("POST", LINK, classes).name == rate_limiter.DEFAULT_CLASS
    assert rate_limiter.INVITE_LINK_CLASS in rate_limit_tiers.build_tiers().ip_classes
