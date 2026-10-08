"""The workspace authentication policy: requiring two-factor authentication.

Turning the policy on needs the Business plan and an admin whose own session
already has a second factor; turning it off never needs either. While it is on,
every workspace route refuses a session without the `two_factor` claim with
`AUTH_POLICY_REQUIRED`, the workspace list flags the workspace instead of hiding
it, delegated credentials are left to their own scopes, and MCP consent stops
offering the workspace to a person without a second factor.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Iterator, cast

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import (
    ADMIN,
    MEMBER,
    OUTSIDER,
    OWNER,
    add_member,
    make_workspace,
    sign_in,
    sign_in_through_gate,
)

WORKSPACE = "01JB00000000000000000000WS"

POLICY = f"/api/workspaces/{WORKSPACE}/auth-policy"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the workspaces application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["workspaces"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A Business workspace with an admin and a member beside its owner."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    repositories.workspaces.set_billing(WORKSPACE, plan="business")
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    return WORKSPACE


@pytest.fixture
def enforced(repositories: Any, workspace: str) -> str:
    """The workspace with two-factor authentication required."""
    repositories.memberships.set_auth_policy(workspace, require_two_factor=True, updated_by=OWNER)
    return workspace


def test_the_policy_starts_off_and_available_on_business(client: TestClient, workspace: str) -> None:
    sign_in(client, ADMIN)
    response = client.get(POLICY)
    assert response.status_code == 200
    body = response.json()
    assert body["require_two_factor"] is False
    assert body["available"] is True


def test_an_admin_with_two_factor_turns_it_on(client: TestClient, workspace: str, repositories: Any) -> None:
    sign_in(client, ADMIN, two_factor=True)
    response = client.put(POLICY, json={"require_two_factor": True})
    assert response.status_code == 200
    body = response.json()
    assert body["require_two_factor"] is True
    assert body["updated_by"] == ADMIN
    assert repositories.memberships.get_auth_policy(workspace).require_two_factor is True


def test_turning_it_on_without_your_own_second_factor_is_refused(client: TestClient, workspace: str) -> None:
    sign_in(client, OWNER)
    response = client.put(POLICY, json={"require_two_factor": True})
    assert response.status_code == 409
    assert response.json()["error_code"] == "TWO_FACTOR_REQUIRED"


def test_turning_it_on_needs_the_business_plan(client: TestClient, repositories: Any) -> None:
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    sign_in(client, OWNER, two_factor=True)
    assert client.get(POLICY).json()["available"] is False
    response = client.put(POLICY, json={"require_two_factor": True})
    assert response.status_code == 403
    assert response.json()["error_code"] == "PLAN_FEATURE_UNAVAILABLE"


def test_turning_it_off_needs_neither_the_plan_nor_a_second_factor(
    client: TestClient, enforced: str, repositories: Any
) -> None:
    repositories.workspaces.set_billing(enforced, plan="free")
    sign_in(client, OWNER, two_factor=True)
    response = client.put(POLICY, json={"require_two_factor": False})
    assert response.status_code == 200
    assert repositories.memberships.get_auth_policy(enforced).require_two_factor is False


def test_a_member_may_not_read_or_change_the_policy(client: TestClient, workspace: str) -> None:
    sign_in(client, MEMBER, two_factor=True)
    assert client.get(POLICY).status_code == 403
    assert client.put(POLICY, json={"require_two_factor": False}).status_code == 403


@pytest.mark.parametrize("subject", [OWNER, ADMIN, MEMBER])
def test_a_session_without_two_factor_is_refused_everywhere_in_the_workspace(
    client: TestClient, enforced: str, subject: str
) -> None:
    sign_in(client, subject)
    response = client.get(f"/api/workspaces/{enforced}")
    assert response.status_code == 403
    assert response.json()["error_code"] == "AUTH_POLICY_REQUIRED"


def test_a_session_with_two_factor_is_admitted(client: TestClient, enforced: str) -> None:
    sign_in(client, MEMBER, two_factor=True)
    assert client.get(f"/api/workspaces/{enforced}").status_code == 200


def test_the_gate_shape_string_claim_counts(client: TestClient, enforced: str) -> None:
    sign_in_through_gate(client, MEMBER, two_factor="true")
    assert client.get(f"/api/workspaces/{enforced}").status_code == 200
    sign_in_through_gate(client, MEMBER, two_factor="false")
    assert client.get(f"/api/workspaces/{enforced}").status_code == 403


def test_an_outsider_still_gets_the_not_found(client: TestClient, enforced: str) -> None:
    sign_in(client, OUTSIDER)
    assert client.get(f"/api/workspaces/{enforced}").status_code == 404


def test_the_workspace_list_flags_a_blocked_workspace(client: TestClient, enforced: str) -> None:
    sign_in(client, MEMBER)
    listed = {row["id"]: row for row in client.get("/api/workspaces").json()["workspaces"]}
    assert listed[enforced]["auth_policy_blocked"] is True

    sign_in(client, MEMBER, two_factor=True)
    listed = {row["id"]: row for row in client.get("/api/workspaces").json()["workspaces"]}
    assert listed[enforced]["auth_policy_blocked"] is False


def test_a_delegated_credential_is_not_held_to_the_session_claim(repositories: Any, enforced: str) -> None:
    from app.common.api.dependencies.authz import blocked_by_auth_policy

    assert blocked_by_auth_policy(repositories, enforced, {"sub": MEMBER}) is True
    assert blocked_by_auth_policy(repositories, enforced, {"sub": MEMBER, "scopes": ["issues:read"]}) is False
    assert blocked_by_auth_policy(repositories, enforced, {"sub": MEMBER, "actor": "api_key"}) is False


def test_the_session_claim_follows_the_totp_factor() -> None:
    from app.domains.identity.identity_hooks import StanduplessIdentityHooks

    factors = {"active": SimpleNamespace(is_active=True), "pending": SimpleNamespace(is_active=False)}
    store = SimpleNamespace(get=factors.get)
    users = cast(Any, object())
    hooks = StanduplessIdentityHooks(users=users, totp_factors=store)

    assert hooks.claims_for({"id": "active"})["two_factor"] is True
    assert hooks.claims_for({"id": "pending"})["two_factor"] is False
    assert hooks.claims_for({"id": "none"})["two_factor"] is False
    assert StanduplessIdentityHooks(users=users).claims_for({"id": "active"})["two_factor"] is False


def test_mcp_consent_leaves_out_a_workspace_the_person_cannot_meet(repositories: Any, enforced: str) -> None:
    from app.domains.identity.oauth_server_glue import resolve_tenants

    other = "01JB00000000000000000000W2"
    make_workspace(repositories, other, "other", MEMBER)

    without = {choice.id for choice in resolve_tenants(MEMBER, has_two_factor=lambda user_id: False)}
    assert without == {other}

    with_factor = {choice.id for choice in resolve_tenants(MEMBER, has_two_factor=lambda user_id: True)}
    assert with_factor == {enforced, other}
