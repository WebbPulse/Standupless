"""The workspace authentication policy: requiring two-factor, and limiting sign-in methods.

Turning the policy on needs the Business plan and an admin whose own session
already has a second factor; turning it off never needs either. While it is on,
every workspace route refuses a session without the `two_factor` claim with
`AUTH_POLICY_REQUIRED`, the workspace list flags the workspace instead of hiding
it, delegated credentials are left to their own scopes, and MCP consent stops
offering the workspace to a person without a second factor.

Limiting the sign-in methods works the same way off the first factor in the
session's `amr`, and the admin saving it must have signed in one of the allowed
ways. Each setting that changes is recorded as its own audit event.
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


GOOGLE_AMR = ["oauth", "google"]


@pytest.fixture
def google_only(repositories: Any, workspace: str) -> str:
    """The workspace limited to signing in with Google."""
    repositories.memberships.set_auth_policy(
        workspace, require_two_factor=False, allowed_methods=["google"], updated_by=OWNER
    )
    return workspace


@pytest.mark.parametrize(
    ("amr", "method"),
    [
        (["pwd"], "password"),
        (["pwd", "otp", "mfa"], "password"),
        (["pwd", "swk", "mfa"], "password"),
        (["oauth", "google"], "google"),
        (["oauth", "github", "otp", "mfa"], "github"),
        (["swk", "pin"], "passkey"),
        (["swk", "otp", "mfa"], "passkey"),
        ('["oauth","google"]', "google"),
        ("[swk, pin]", "passkey"),
        ("pwd otp mfa", "password"),
        (["oauth", "gitlab"], None),
        (["device"], None),
        ([], None),
        (None, None),
    ],
)
def test_the_sign_in_method_is_the_first_factor(amr: Any, method: Any) -> None:
    from app.common.api.dependencies.authz import sign_in_method_of

    assert sign_in_method_of({"sub": MEMBER, "amr": amr}) == method


def test_the_policy_allows_every_method_by_default(client: TestClient, workspace: str) -> None:
    sign_in(client, ADMIN, amr=["pwd"])
    body = client.get(POLICY).json()
    assert body["allowed_methods"] == ["password", "google", "github", "passkey"]
    assert body["current_method"] == "password"


def test_an_admin_limits_the_methods_keeping_their_own(client: TestClient, workspace: str, repositories: Any) -> None:
    sign_in(client, ADMIN, amr=GOOGLE_AMR)
    response = client.put(POLICY, json={"allowed_methods": ["passkey", "google"]})
    assert response.status_code == 200
    assert response.json()["allowed_methods"] == ["google", "passkey"]
    assert response.json()["current_method"] == "google"
    assert response.json()["require_two_factor"] is False
    assert repositories.memberships.get_auth_policy(workspace).allowed_methods == ["google", "passkey"]


def test_excluding_your_own_method_is_refused(client: TestClient, workspace: str) -> None:
    sign_in(client, ADMIN, amr=["pwd", "otp", "mfa"], two_factor=True)
    response = client.put(POLICY, json={"allowed_methods": ["google", "github"]})
    assert response.status_code == 409
    assert response.json()["error_code"] == "SIGN_IN_METHOD_REQUIRED"


def test_an_empty_or_unknown_method_list_is_rejected(client: TestClient, workspace: str) -> None:
    sign_in(client, ADMIN, amr=["pwd"])
    assert client.put(POLICY, json={"allowed_methods": []}).status_code == 422
    assert client.put(POLICY, json={"allowed_methods": ["sms"]}).status_code == 422


def test_limiting_the_methods_needs_the_business_plan(client: TestClient, repositories: Any) -> None:
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    sign_in(client, OWNER, amr=GOOGLE_AMR)
    response = client.put(POLICY, json={"allowed_methods": ["google"]})
    assert response.status_code == 403
    assert response.json()["error_code"] == "PLAN_FEATURE_UNAVAILABLE"


def test_allowing_every_method_again_needs_no_plan(client: TestClient, google_only: str, repositories: Any) -> None:
    repositories.workspaces.set_billing(google_only, plan="free")
    sign_in(client, OWNER, amr=GOOGLE_AMR)
    response = client.put(
        POLICY, json={"require_two_factor": False, "allowed_methods": ["password", "google", "github", "passkey"]}
    )
    assert response.status_code == 200
    assert response.json()["allowed_methods"] == ["password", "google", "github", "passkey"]


def test_saving_two_factor_alone_keeps_the_methods(client: TestClient, google_only: str, repositories: Any) -> None:
    sign_in(client, ADMIN, amr=["oauth", "google", "otp", "mfa"], two_factor=True)
    response = client.put(POLICY, json={"require_two_factor": True})
    assert response.status_code == 200
    assert response.json()["allowed_methods"] == ["google"]
    assert repositories.memberships.get_auth_policy(google_only).require_two_factor is True


@pytest.mark.parametrize("amr", [["pwd"], ["pwd", "otp", "mfa"], ["swk", "pin"], ["oauth", "github"], []])
def test_a_session_signed_in_another_way_is_refused(client: TestClient, google_only: str, amr: Any) -> None:
    sign_in(client, MEMBER, amr=amr, two_factor=True)
    response = client.get(f"/api/workspaces/{google_only}")
    assert response.status_code == 403
    body = response.json()
    assert body["error_code"] == "AUTH_POLICY_REQUIRED"


def test_a_session_signed_in_an_allowed_way_is_admitted(client: TestClient, google_only: str) -> None:
    sign_in(client, MEMBER, amr=GOOGLE_AMR)
    assert client.get(f"/api/workspaces/{google_only}").status_code == 200
    sign_in_through_gate(client, MEMBER, amr=GOOGLE_AMR)
    assert client.get(f"/api/workspaces/{google_only}").status_code == 200


def test_the_method_refusal_names_the_allowed_methods(repositories: Any, google_only: str) -> None:
    from app.common.api.dependencies.authz import auth_policy_refusal

    refusal = auth_policy_refusal(repositories, google_only, {"sub": MEMBER, "amr": ["pwd"]})
    assert refusal is not None
    detail = refusal.detail()
    assert detail["reason"] == "sign_in_method"
    assert detail["allowed_methods"] == ["google"]
    assert "Google" in detail["message"]


def test_the_method_is_checked_before_the_second_factor(repositories: Any, workspace: str) -> None:
    from app.common.api.dependencies.authz import auth_policy_refusal

    repositories.memberships.set_auth_policy(
        workspace, require_two_factor=True, allowed_methods=["google"], updated_by=OWNER
    )
    by_password = auth_policy_refusal(repositories, workspace, {"sub": MEMBER, "amr": ["pwd"]})
    assert by_password is not None and by_password.reason == "sign_in_method"
    by_google = auth_policy_refusal(repositories, workspace, {"sub": MEMBER, "amr": GOOGLE_AMR})
    assert by_google is not None and by_google.reason == "two_factor"
    assert auth_policy_refusal(repositories, workspace, {"sub": MEMBER, "amr": GOOGLE_AMR, "two_factor": True}) is None


def test_the_workspace_list_says_why_a_workspace_is_blocked(client: TestClient, google_only: str) -> None:
    sign_in(client, MEMBER, amr=["pwd"])
    listed = {row["id"]: row for row in client.get("/api/workspaces").json()["workspaces"]}
    assert listed[google_only]["auth_policy_blocked"] is True
    assert listed[google_only]["auth_policy_reason"] == "sign_in_method"
    assert listed[google_only]["auth_policy_allowed_methods"] == ["google"]

    sign_in(client, MEMBER, amr=GOOGLE_AMR)
    listed = {row["id"]: row for row in client.get("/api/workspaces").json()["workspaces"]}
    assert listed[google_only]["auth_policy_blocked"] is False
    assert listed[google_only]["auth_policy_reason"] is None


def test_a_delegated_credential_is_not_held_to_the_methods(repositories: Any, google_only: str) -> None:
    from app.common.api.dependencies.authz import blocked_by_auth_policy

    assert blocked_by_auth_policy(repositories, google_only, {"sub": MEMBER, "amr": ["pwd"]}) is True
    assert blocked_by_auth_policy(repositories, google_only, {"sub": MEMBER, "scopes": ["issues:read"]}) is False
    assert blocked_by_auth_policy(repositories, google_only, {"sub": MEMBER, "actor": "api_key"}) is False


def test_changing_the_methods_is_audited_apart_from_two_factor(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    sign_in(client, ADMIN, amr=["oauth", "google", "otp", "mfa"], two_factor=True)
    response = client.put(POLICY, json={"require_two_factor": True, "allowed_methods": ["passkey", "google"]})
    assert response.status_code == 200

    rows, _ = repositories.audit.list_events(workspace, event="auth_policy.updated")
    changes = {row.target_label: (row.before, row.after) for row in rows}
    assert changes == {
        "Require two-factor authentication": ({"require_two_factor": False}, {"require_two_factor": True}),
        "Allowed sign-in methods": (
            {"allowed_methods": ["password", "google", "github", "passkey"]},
            {"allowed_methods": ["google", "passkey"]},
        ),
    }
    assert all(row.actor_id == ADMIN for row in rows)


def test_saving_the_same_methods_records_nothing(client: TestClient, google_only: str, repositories: Any) -> None:
    sign_in(client, ADMIN, amr=GOOGLE_AMR)
    assert client.put(POLICY, json={"allowed_methods": ["google"]}).status_code == 200
    rows, _ = repositories.audit.list_events(google_only, event="auth_policy.updated")
    assert rows == []
