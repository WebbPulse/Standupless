"""Workspace single sign-on: domains, the connection, the test sign-in, requiring it, and joining.

Setting single sign-on up needs the Business plan and an owner or admin. A domain
proves itself by DNS, a connection is saved with its client secret sealed, and a
test sign-in through the connection is what makes it discoverable and lets the
requirement go on. Once required, every session that did not come through the
connection is refused with `SSO_REQUIRED`, except an owner's, which is the way
back in when the provider fails. A person whose session came through the
connection joins the workspace as a member when their verified email is on one of
its verified domains.
"""

from __future__ import annotations

import base64
import datetime
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.audit import AuditQuery

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.users import User
from tests.domains.helpers import ADMIN, MEMBER, OUTSIDER, OWNER, add_member, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

OTHER_WORKSPACE = "01JB00000000000000000000W2"

BASE = f"/api/workspaces/{WORKSPACE}/sso"

SSO_AMR = ["sso", "oidc"]

OIDC_CONNECTION = {
    "protocol": "oidc",
    "display_name": "Acme Okta",
    "oidc_issuer": "https://acme.okta.example/",
    "oidc_client_id": "client-123",
    "oidc_client_secret": "not-a-real-secret",
}


def _sso_session(client: TestClient, subject: str, workspace_id: str = WORKSPACE) -> None:
    """Sign in as `subject` through the workspace's connection."""
    sign_in(client, subject, amr=SSO_AMR, sso_connection=workspace_id)


def _certificate() -> str:
    """A throwaway self-signed certificate in PEM, standing in for a provider's signing certificate."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "idp.example")])
    now = datetime.datetime.now(datetime.timezone.utc)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=1))
        .sign(key, hashes.SHA256())
    )
    return certificate.public_bytes(serialization.Encoding.PEM).decode("ascii")


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the workspaces application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["workspaces"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(autouse=True)
def master_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """A throwaway master key, so a client secret can be sealed."""
    monkeypatch.setenv("IDENTITY_TOTP_MASTER_KEY", base64.b64encode(b"k" * 32).decode("ascii"))


@pytest.fixture
def dns(monkeypatch: pytest.MonkeyPatch) -> dict[str, bool]:
    """Answer every TXT lookup from this map instead of DNS."""
    answers: dict[str, bool] = {}
    monkeypatch.setattr("app.common.sso.domain_is_verified", lambda domain, token: answers.get(domain, False))
    return answers


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A Business workspace with an admin and a member beside its owner."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    repositories.workspaces.set_billing(WORKSPACE, plan="business")
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    return WORKSPACE


@pytest.fixture
def connected(client: TestClient, workspace: str, dns: dict[str, bool]) -> str:
    """The workspace with acme.com verified and an OIDC connection saved but not yet tested."""
    dns["acme.com"] = True
    sign_in(client, ADMIN)
    assert client.post(f"{BASE}/domains", json={"domain": "acme.com"}).status_code == 201
    assert client.post(f"{BASE}/domains/acme.com/verify").status_code == 200
    assert client.put(f"{BASE}/connection", json=OIDC_CONNECTION).status_code == 200
    return workspace


@pytest.fixture
def tested(client: TestClient, connected: str) -> str:
    """The connected workspace after the admin's test sign-in through it."""
    _sso_session(client, ADMIN)
    assert client.post(f"{BASE}/connection/test-result").status_code == 200
    return connected


@pytest.fixture
def required(client: TestClient, tested: str, repositories: Any) -> str:
    """The tested workspace with single sign-on required."""
    _sso_session(client, ADMIN)
    response = client.put(f"{BASE}/policy", json={"require_sso": True})
    assert response.status_code == 200
    assert repositories.memberships.get_auth_policy(tested).require_sso is True
    return tested


def test_the_settings_start_empty_and_available_on_business(client: TestClient, workspace: str) -> None:
    sign_in(client, ADMIN)
    response = client.get(BASE)
    assert response.status_code == 200
    body = response.json()
    assert body["available"] is True
    assert body["domains"] == []
    assert body["connection"] is None
    assert body["require_sso"] is False
    assert body["can_require"] is False
    assert body["current_session_sso"] is False
    assert body["service_provider"]["oidc_redirect_uri"].endswith(f"/sso/oidc/{WORKSPACE}/callback")
    assert body["service_provider"]["saml_acs_url"].endswith(f"/sso/saml/{WORKSPACE}/acs")


def test_a_member_may_not_read_or_change_single_sign_on(client: TestClient, workspace: str) -> None:
    sign_in(client, MEMBER)
    assert client.get(BASE).status_code == 403
    assert client.post(f"{BASE}/domains", json={"domain": "acme.com"}).status_code == 403
    assert client.put(f"{BASE}/policy", json={"require_sso": True}).status_code == 403


def test_an_outsider_gets_the_not_found(client: TestClient, workspace: str) -> None:
    sign_in(client, OUTSIDER)
    assert client.get(BASE).status_code == 404


def test_adding_a_domain_needs_the_business_plan(client: TestClient, repositories: Any) -> None:
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    sign_in(client, OWNER)
    assert client.get(BASE).json()["available"] is False
    response = client.post(f"{BASE}/domains", json={"domain": "acme.com"})
    assert response.status_code == 403
    assert response.json()["error_code"] == "PLAN_FEATURE_UNAVAILABLE"


def test_a_domain_answers_its_txt_record_and_is_audited(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    sign_in(client, ADMIN)
    response = client.post(f"{BASE}/domains", json={"domain": "@Acme.COM"})
    assert response.status_code == 201
    body = response.json()
    assert body["domain"] == "acme.com"
    assert body["verified"] is False
    assert body["record_type"] == "TXT"
    assert body["record_value"].startswith("standupless-verification=")
    again = client.post(f"{BASE}/domains", json={"domain": "acme.com"}).json()
    assert again["record_value"] == body["record_value"]
    rows = repositories.audit.list_events(workspace, AuditQuery(action="sso.domain_added")).events
    assert [row.target.id for row in rows] == ["acme.com"]


@pytest.mark.parametrize(("domain", "code"), [("gmail.com", "PUBLIC_EMAIL_DOMAIN"), ("not a domain", "INVALID_DOMAIN")])
def test_a_public_or_malformed_domain_is_refused(client: TestClient, workspace: str, domain: str, code: str) -> None:
    sign_in(client, ADMIN)
    response = client.post(f"{BASE}/domains", json={"domain": domain})
    assert response.status_code == 422
    assert response.json()["error_code"] == code


def test_a_domain_without_its_record_stays_unverified(
    client: TestClient, workspace: str, dns: dict[str, bool]
) -> None:
    sign_in(client, ADMIN)
    client.post(f"{BASE}/domains", json={"domain": "acme.com"})
    response = client.post(f"{BASE}/domains/acme.com/verify")
    assert response.status_code == 409
    assert response.json()["error_code"] == "SSO_DOMAIN_UNVERIFIED"
    dns["acme.com"] = True
    verified = client.post(f"{BASE}/domains/acme.com/verify")
    assert verified.status_code == 200
    assert verified.json()["verified"] is True


def test_verifying_an_unlisted_domain_is_not_found(client: TestClient, workspace: str, dns: dict[str, bool]) -> None:
    sign_in(client, ADMIN)
    assert client.post(f"{BASE}/domains/acme.com/verify").status_code == 404


def test_a_domain_another_workspace_verified_cannot_be_verified_again(
    client: TestClient, connected: str, repositories: Any, dns: dict[str, bool]
) -> None:
    make_workspace(repositories, OTHER_WORKSPACE, "rival", OUTSIDER)
    repositories.workspaces.set_billing(OTHER_WORKSPACE, plan="business")
    sign_in(client, OUTSIDER)
    other = f"/api/workspaces/{OTHER_WORKSPACE}/sso"
    assert client.post(f"{other}/domains", json={"domain": "acme.com"}).status_code == 201
    response = client.post(f"{other}/domains/acme.com/verify")
    assert response.status_code == 409
    assert response.json()["error_code"] == "SSO_DOMAIN_TAKEN"


def test_the_oidc_connection_never_answers_its_secret(client: TestClient, connected: str, repositories: Any) -> None:
    sign_in(client, ADMIN)
    body = client.get(BASE).json()
    connection = body["connection"]
    assert connection["protocol"] == "oidc"
    assert connection["oidc_issuer"] == "https://acme.okta.example"
    assert connection["oidc_scopes"] == ["openid", "email", "profile"]
    assert connection["has_client_secret"] is True
    assert connection["tested"] is False
    assert "not-a-real-secret" not in str(body)
    stored = repositories.memberships.get_sso_connection(connected)
    assert stored is not None
    assert "not-a-real-secret" not in str(stored.oidc_sealed_secret)


def test_saving_without_a_secret_keeps_the_stored_one(client: TestClient, connected: str, repositories: Any) -> None:
    before = repositories.memberships.get_sso_connection(connected).oidc_sealed_secret
    sign_in(client, ADMIN)
    response = client.put(f"{BASE}/connection", json={**OIDC_CONNECTION, "oidc_client_secret": ""})
    assert response.status_code == 200
    assert repositories.memberships.get_sso_connection(connected).oidc_sealed_secret == before


def test_a_first_oidc_connection_needs_a_secret(client: TestClient, workspace: str) -> None:
    sign_in(client, ADMIN)
    response = client.put(f"{BASE}/connection", json={**OIDC_CONNECTION, "oidc_client_secret": ""})
    assert response.status_code == 422
    assert response.json()["details"]["field"] == "oidc_client_secret"


def test_a_plain_http_issuer_is_refused(client: TestClient, workspace: str) -> None:
    sign_in(client, ADMIN)
    response = client.put(f"{BASE}/connection", json={**OIDC_CONNECTION, "oidc_issuer": "http://acme.okta.example"})
    assert response.status_code == 422
    assert response.json()["details"]["field"] == "oidc_issuer"


def test_a_saml_connection_is_saved_from_its_three_values(client: TestClient, workspace: str) -> None:
    sign_in(client, ADMIN)
    response = client.put(
        f"{BASE}/connection",
        json={
            "protocol": "saml",
            "saml_idp_entity_id": "https://idp.example/entity",
            "saml_idp_sso_url": "https://idp.example/sso",
            "saml_idp_certificate": _certificate(),
        },
    )
    assert response.status_code == 200
    connection = response.json()["connection"]
    assert connection["protocol"] == "saml"
    assert connection["saml_certificate_count"] == 1
    assert connection["saml_idp_sso_url"] == "https://idp.example/sso"


def test_a_saml_certificate_that_does_not_parse_is_refused(client: TestClient, workspace: str) -> None:
    sign_in(client, ADMIN)
    response = client.put(
        f"{BASE}/connection",
        json={
            "protocol": "saml",
            "saml_idp_entity_id": "https://idp.example/entity",
            "saml_idp_sso_url": "https://idp.example/sso",
            "saml_idp_certificate": "not a certificate",
        },
    )
    assert response.status_code == 422
    assert response.json()["details"]["field"] == "saml_idp_certificate"


def test_the_connection_save_is_audited_without_its_secret(
    client: TestClient, connected: str, repositories: Any
) -> None:
    rows = repositories.audit.list_events(connected, AuditQuery(action="sso.connection_saved")).events
    assert len(rows) == 1
    assert rows[0].after == {"protocol": "oidc", "issuer": "https://acme.okta.example", "client_id": "client-123"}


def test_recording_a_test_needs_a_session_through_the_connection(client: TestClient, connected: str) -> None:
    sign_in(client, ADMIN)
    response = client.post(f"{BASE}/connection/test-result")
    assert response.status_code == 409
    assert response.json()["error_code"] == "SSO_TEST_REQUIRED"
    _sso_session(client, ADMIN, OTHER_WORKSPACE)
    assert client.post(f"{BASE}/connection/test-result").status_code == 409


def test_a_test_through_the_connection_makes_it_ready(client: TestClient, tested: str, repositories: Any) -> None:
    _sso_session(client, ADMIN)
    body = client.get(BASE).json()
    assert body["connection"]["tested"] is True
    assert body["current_session_sso"] is True
    assert body["can_require"] is True
    rows = repositories.audit.list_events(tested, AuditQuery(action="sso.connection_tested")).events
    assert len(rows) == 1


def test_saving_the_connection_again_clears_its_test(client: TestClient, tested: str) -> None:
    sign_in(client, ADMIN)
    response = client.put(f"{BASE}/connection", json=OIDC_CONNECTION)
    assert response.json()["connection"]["tested"] is False
    assert response.json()["can_require"] is False


def test_requiring_needs_a_tested_connection(client: TestClient, connected: str) -> None:
    _sso_session(client, ADMIN)
    response = client.put(f"{BASE}/policy", json={"require_sso": True})
    assert response.status_code == 409
    assert response.json()["error_code"] == "SSO_NOT_READY"


def test_an_admin_must_have_signed_in_through_it_to_require_it(client: TestClient, tested: str) -> None:
    sign_in(client, ADMIN)
    response = client.put(f"{BASE}/policy", json={"require_sso": True})
    assert response.status_code == 409
    assert response.json()["error_code"] == "SSO_SESSION_REQUIRED"


def test_an_owner_may_require_it_from_a_password_session(client: TestClient, tested: str) -> None:
    sign_in(client, OWNER, amr=["pwd"])
    response = client.put(f"{BASE}/policy", json={"require_sso": True})
    assert response.status_code == 200
    assert response.json()["require_sso"] is True


def test_requiring_it_is_audited(client: TestClient, required: str, repositories: Any) -> None:
    rows = repositories.audit.list_events(required, AuditQuery(action="auth_policy.updated")).events
    assert [(row.target.label, row.before, row.after) for row in rows] == [
        ("Require single sign-on", {"require_sso": False}, {"require_sso": True})
    ]


@pytest.mark.parametrize("subject", [ADMIN, MEMBER])
def test_a_session_outside_the_connection_is_refused_once_required(
    client: TestClient, required: str, subject: str
) -> None:
    sign_in(client, subject, amr=["pwd"])
    response = client.get(f"/api/workspaces/{required}")
    assert response.status_code == 403
    assert response.json()["error_code"] == "SSO_REQUIRED"
    sign_in(client, subject, amr=["oauth", "google"])
    assert client.get(f"/api/workspaces/{required}").json()["error_code"] == "SSO_REQUIRED"


def test_a_session_through_another_connection_is_refused(client: TestClient, required: str) -> None:
    _sso_session(client, MEMBER, OTHER_WORKSPACE)
    assert client.get(f"/api/workspaces/{required}").status_code == 403


def test_a_session_through_the_connection_is_admitted(client: TestClient, required: str) -> None:
    _sso_session(client, MEMBER)
    assert client.get(f"/api/workspaces/{required}").status_code == 200


def test_a_claim_without_the_sso_method_is_not_a_single_sign_on_session(client: TestClient, required: str) -> None:
    sign_in(client, MEMBER, amr=["pwd"], sso_connection=WORKSPACE)
    assert client.get(f"/api/workspaces/{required}").status_code == 403


def test_the_owner_keeps_a_password_way_in(client: TestClient, required: str) -> None:
    sign_in(client, OWNER, amr=["pwd"])
    assert client.get(f"/api/workspaces/{required}").status_code == 200


def test_the_workspace_list_flags_the_sso_reason(client: TestClient, required: str) -> None:
    sign_in(client, MEMBER, amr=["pwd"])
    listed = {row["id"]: row for row in client.get("/api/workspaces").json()["workspaces"]}
    assert listed[required]["auth_policy_blocked"] is True
    assert listed[required]["auth_policy_reason"] == "sso"
    sign_in(client, OWNER, amr=["pwd"])
    listed = {row["id"]: row for row in client.get("/api/workspaces").json()["workspaces"]}
    assert listed[required]["auth_policy_blocked"] is False


def test_a_delegated_credential_is_not_held_to_the_requirement(repositories: Any, required: str) -> None:
    from app.common.api.dependencies.authz import blocked_by_auth_policy

    assert blocked_by_auth_policy(repositories, required, {"sub": MEMBER}, role="member") is True
    assert blocked_by_auth_policy(repositories, required, {"sub": MEMBER, "actor": "api_key"}, role="member") is False


def test_the_connection_and_last_domain_stay_while_required(client: TestClient, required: str) -> None:
    sign_in(client, OWNER)
    assert client.delete(f"{BASE}/domains/acme.com").json()["error_code"] == "SSO_REQUIRED_IN_USE"
    assert client.delete(f"{BASE}/connection").json()["error_code"] == "SSO_REQUIRED_IN_USE"
    assert client.put(f"{BASE}/connection", json=OIDC_CONNECTION).json()["error_code"] == "SSO_REQUIRED_IN_USE"


def test_turning_it_off_needs_neither_the_plan_nor_a_session_through_it(
    client: TestClient, required: str, repositories: Any
) -> None:
    repositories.workspaces.set_billing(required, plan="free")
    sign_in(client, ADMIN, amr=["pwd"])
    assert client.get(f"/api/workspaces/{required}").status_code == 403
    sign_in(client, OWNER, amr=["pwd"])
    response = client.put(f"{BASE}/policy", json={"require_sso": False})
    assert response.status_code == 200
    assert repositories.memberships.get_auth_policy(required).require_sso is False
    assert client.delete(f"{BASE}/connection").status_code == 204
    assert client.delete(f"{BASE}/domains/acme.com").status_code == 204


def test_the_two_factor_route_leaves_the_requirement_alone(client: TestClient, required: str, repositories: Any) -> None:
    repositories.memberships.set_auth_policy(required, require_two_factor=False, updated_by=OWNER)
    assert repositories.memberships.get_auth_policy(required).require_sso is True


def _person(repositories: Any, user_id: str, email: str, *, verified: bool = True) -> None:
    """Store a user row the way single sign-on provisions one."""
    repositories.users.create(User(id=user_id, email=email, display_name="Alice", email_verified=verified))


def test_a_person_through_the_connection_joins_as_a_member(
    client: TestClient, tested: str, repositories: Any
) -> None:
    _person(repositories, OUTSIDER, "alice@acme.com")
    _sso_session(client, OUTSIDER)
    response = client.post("/api/workspaces/sso/join")
    assert response.status_code == 201
    assert response.json() == {"workspace_id": tested, "slug": "acme", "name": "Acme", "created": True}
    membership = repositories.memberships.get(tested, OUTSIDER)
    assert membership is not None and membership.role == "member"
    again = client.post("/api/workspaces/sso/join")
    assert again.status_code == 200
    assert again.json()["created"] is False
    rows = repositories.audit.list_events(tested, AuditQuery(action="member.joined")).events
    assert [row.after for row in rows] == [{"role": "member", "via": "sso"}]


def test_joining_needs_a_session_through_a_connection(client: TestClient, tested: str, repositories: Any) -> None:
    _person(repositories, OUTSIDER, "alice@acme.com")
    sign_in(client, OUTSIDER, amr=["pwd"])
    response = client.post("/api/workspaces/sso/join")
    assert response.status_code == 409
    assert response.json()["error_code"] == "SSO_SESSION_REQUIRED"


@pytest.mark.parametrize(("email", "verified"), [("alice@other.com", True), ("alice@acme.com", False)])
def test_joining_needs_a_verified_address_on_a_verified_domain(
    client: TestClient, tested: str, repositories: Any, email: str, verified: bool
) -> None:
    _person(repositories, OUTSIDER, email, verified=verified)
    _sso_session(client, OUTSIDER)
    response = client.post("/api/workspaces/sso/join")
    assert response.status_code == 403
    assert response.json()["error_code"] == "SSO_DOMAIN_NOT_VERIFIED"
    assert repositories.memberships.get(tested, OUTSIDER) is None


def test_joining_needs_the_business_plan(client: TestClient, tested: str, repositories: Any) -> None:
    repositories.workspaces.set_billing(tested, plan="free")
    _person(repositories, OUTSIDER, "alice@acme.com")
    _sso_session(client, OUTSIDER)
    response = client.post("/api/workspaces/sso/join")
    assert response.status_code == 403
    assert response.json()["error_code"] == "PLAN_FEATURE_UNAVAILABLE"


def test_a_delegated_credential_cannot_join(client: TestClient, tested: str, repositories: Any) -> None:
    _person(repositories, OUTSIDER, "alice@acme.com")
    sign_in(client, OUTSIDER, amr=SSO_AMR, sso_connection=WORKSPACE, actor="api_key")
    assert client.post("/api/workspaces/sso/join").status_code in {401, 403}


def test_the_hooks_find_a_connection_by_email_only_once_tested(
    client: TestClient, connected: str, repositories: Any
) -> None:
    from app.domains.identity.sso_hooks import StanduplessSsoHooks

    hooks = StanduplessSsoHooks(
        memberships=repositories.memberships, workspaces=repositories.workspaces, users=repositories.users
    )
    assert hooks.find_connection(email="alice@acme.com") is None
    loaded = hooks.load_connection(connected)
    assert loaded is not None
    assert loaded.enabled is True
    assert loaded.verified_domains == ("acme.com",)

    _sso_session(client, ADMIN)
    client.post(f"{BASE}/connection/test-result")
    found = hooks.find_connection(email="Alice@ACME.com")
    assert found is not None and found.connection_id == connected
    assert hooks.find_connection(email="alice@other.com") is None


def test_the_hooks_disable_a_connection_off_the_business_plan(connected: str, repositories: Any) -> None:
    from app.domains.identity.sso_hooks import StanduplessSsoHooks

    repositories.workspaces.set_billing(connected, plan="free")
    hooks = StanduplessSsoHooks(
        memberships=repositories.memberships, workspaces=repositories.workspaces, users=repositories.users
    )
    loaded = hooks.load_connection(connected)
    assert loaded is not None and loaded.enabled is False
    assert hooks.load_connection(OTHER_WORKSPACE) is None


def test_mcp_consent_offers_a_required_workspace_only_through_its_connection(repositories: Any, required: str) -> None:
    from webbpulse.identity import AuthorizationSubject
    from webbpulse.identity.sso import sso_session_amr

    from app.domains.identity.oauth_server_glue import resolve_tenants

    def subject(user_id: str, amr: tuple[str, ...]) -> Any:
        """An OAuth subject with this stored `amr`."""
        return AuthorizationSubject(user_id=user_id, amr=amr)

    assert required not in {choice.id for choice in resolve_tenants(subject(MEMBER, ("pwd",)))}
    through = subject(MEMBER, sso_session_amr("oidc", required))
    assert required in {choice.id for choice in resolve_tenants(through)}
    assert required in {choice.id for choice in resolve_tenants(subject(OWNER, ("pwd",)))}
