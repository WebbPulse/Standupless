"""An account whose address is unconfirmed signs in but reaches only its own account.

Registration signs the person in, the token carries `email_verified` false, and every
route outside `/api/users/me` and `/api/auth` answers 403 `EMAIL_NOT_VERIFIED` until the
link is opened and the session refreshed.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.identity import AuthenticationRefused

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.users import User
from app.domains.identity.identity_hooks import StanduplessIdentityHooks
from tests.domains.helpers import OWNER, sign_in, sign_in_through_gate


def _client(repositories: Any, domain: str) -> TestClient:
    """A client for one domain's application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS[domain])
    bind_repositories(app, repositories)
    return TestClient(app)


@pytest.fixture
def unverified(repositories: Any) -> str:
    """A freshly registered person whose address is not yet confirmed."""
    repositories.users.create(User(id=OWNER, email="new@example.com", email_verified=False))
    return OWNER


@pytest.fixture
def workspaces(repositories: Any) -> Iterator[TestClient]:
    """A client for the workspaces application."""
    with _client(repositories, "workspaces") as client:
        yield client


@pytest.fixture
def identity(repositories: Any) -> Iterator[TestClient]:
    """A client for the identity application."""
    with _client(repositories, "identity") as client:
        yield client


def test_an_unverified_session_is_refused_a_workspace_route(workspaces: TestClient, unverified: str) -> None:
    """The workspace list answers the typed 403 the frontend renders as the pending screen."""
    sign_in(workspaces, unverified, email_verified="false")
    response = workspaces.get("/api/workspaces")
    assert response.status_code == 403
    assert response.json()["error_code"] == "EMAIL_NOT_VERIFIED"


def test_an_unverified_session_is_refused_through_the_staging_gate(workspaces: TestClient, unverified: str) -> None:
    """The gate's JSON claims carry a real boolean, which refuses the same way."""
    sign_in_through_gate(workspaces, unverified, email_verified=False)
    response = workspaces.get("/api/workspaces")
    assert response.status_code == 403
    assert response.json()["error_code"] == "EMAIL_NOT_VERIFIED"


def test_an_unverified_session_reads_its_own_account(identity: TestClient, unverified: str) -> None:
    """`GET /api/users/me` stays open, so the app can boot into the pending screen."""
    sign_in(identity, unverified, email_verified="false")
    response = identity.get("/api/users/me")
    assert response.status_code == 200
    assert response.json()["email_verified"] is False


@pytest.mark.parametrize(
    ("path", "allowed"),
    [
        ("/api/users/me", True),
        ("/api/users/me/preferences", True),
        ("/api/auth", True),
        ("/api/auth/refresh", True),
        ("/api/users/mentions", False),
        ("/api/authors", False),
        ("/api/workspaces/w1/connected-apps", False),
    ],
)
def test_the_unverified_allowance_covers_only_the_account_and_identity_routes(path: str, allowed: bool) -> None:
    """The account and identity trees are open and nothing that merely starts the same."""
    from fastapi import HTTPException, Request
    from webbpulse.identity.claims import require_verified_email

    from app.common.api.dependencies.authz import UNVERIFIED_ALLOWED_ROUTES

    request = Request({"type": "http", "method": "GET", "path": path, "headers": []})
    claims = {"sub": OWNER, "email_verified": False}
    if allowed:
        require_verified_email(request, claims, allowed_routes=UNVERIFIED_ALLOWED_ROUTES)
        return
    with pytest.raises(HTTPException) as refused:
        require_verified_email(request, claims, allowed_routes=UNVERIFIED_ALLOWED_ROUTES)
    assert refused.value.status_code == 403


def test_an_unverified_mcp_token_resolves_to_no_caller(monkeypatch: pytest.MonkeyPatch) -> None:
    """The MCP path has no authorizer, so an unconfirmed address is refused where its token is read."""
    from fastapi import Request

    from app.common.api.dependencies import authz

    request = Request({"type": "http", "method": "POST", "path": "/api/mcp", "headers": []})
    monkeypatch.setattr(authz, "identity_claims", lambda _request: None)
    monkeypatch.setattr(authz, "_api_key_claims", lambda _request, _repositories=None: None)

    monkeypatch.setattr(authz, "_mcp_token_claims", lambda _request: {"sub": OWNER, "email_verified": False})
    assert authz.bearer_claims_of(request) is None

    verified = {"sub": OWNER, "email_verified": True}
    monkeypatch.setattr(authz, "_mcp_token_claims", lambda _request: verified)
    assert authz.bearer_claims_of(request) is verified


def test_a_verified_session_reaches_workspace_routes(workspaces: TestClient, repositories: Any) -> None:
    """Once the refreshed token says verified, the workspace list answers."""
    repositories.users.create(User(id=OWNER, email="new@example.com", email_verified=True))
    sign_in(workspaces, OWNER, email_verified="true")
    assert workspaces.get("/api/workspaces").status_code == 200


def test_a_token_without_the_claim_is_not_refused(workspaces: TestClient, repositories: Any) -> None:
    """A token minted before the claim existed passes as before."""
    repositories.users.create(User(id=OWNER, email="new@example.com", email_verified=True))
    sign_in(workspaces, OWNER)
    assert workspaces.get("/api/workspaces").status_code == 200


def test_an_unverified_account_may_sign_in(repositories: Any, unverified: str) -> None:
    """The hook permits an unconfirmed address and still refuses a disabled account."""
    hooks = StanduplessIdentityHooks(repositories.users)
    hooks.may_authenticate(hooks.load_user_by_id(unverified) or {})

    repositories.users.update(unverified, disabled=True)
    with pytest.raises(AuthenticationRefused) as refused:
        hooks.may_authenticate(hooks.load_user_by_id(unverified) or {})
    assert refused.value.error_code == "ACCOUNT_DISABLED"


def test_registration_signs_the_new_account_in(monkeypatch: pytest.MonkeyPatch) -> None:
    """The product turns on `unverified_sessions`, so register issues a session."""
    monkeypatch.setenv("IDENTITY_ISSUER", "http://identity.test/api/auth")
    monkeypatch.setenv("IDENTITY_AUDIENCE", "standupless")
    monkeypatch.setenv("IDENTITY_ENVIRONMENT", "test")
    monkeypatch.setenv("IDENTITY_SIGNER", "local")
    monkeypatch.setenv("IDENTITY_SIGNING_KEY_ARNS", '["arn:aws:kms:us-west-2:000000000000:key/test-signing-key"]')
    from app.common.core.config import settings
    from app.domains.identity.package_glue import build_identity_settings

    built = build_identity_settings(settings)
    assert built.unverified_sessions is True
    assert built.registration_attributes == ["display_name"]
