"""The OAuth 2.1 authorization server the identity package mounts for MCP clients.

Drives the package's own routes rather than product code, because that is what the
product ships: the value under test is the wiring, which is the stores, the five scopes
and the tenant resolver. A regression here is a deployment advertising an authorization
server it cannot honour.
"""

from __future__ import annotations

import base64
import hashlib
import re
import secrets
from typing import Any, Iterator
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tests.domains.helpers import MEMBER, OWNER, add_member, make_user, make_workspace, sign_in

ISSUER = "http://identity.test/api/auth"

PREFIX = "/api/auth"
"""The issuer's own path, which every route including the two discovery documents mounts under.

The gateway routes `/.well-known/oauth-authorization-server` to this function, so a client
reaching the bare well-known path is served by API Gateway's mapping rather than by a second
route here. In process, the documents live under the prefix.
"""

RESOURCE = "http://api.test/api/mcp"

WORKSPACE_ONE = "01JB00000000000000000000W1"

WORKSPACE_TWO = "01JB00000000000000000000W2"

PRODUCT_SCOPES = ["issues:read", "issues:write", "comments:write", "projects:read", "views:read"]

IDENTITY_ENVIRONMENT = {
    "IDENTITY_ISSUER": ISSUER,
    "IDENTITY_AUDIENCE": "standupless",
    "IDENTITY_ENVIRONMENT": "test",
    "IDENTITY_SIGNER": "local",
    "IDENTITY_SIGNING_KEY_ARNS": '["arn:aws:kms:us-west-2:000000000000:key/test-signing-key"]',
    "IDENTITY_MCP_OAUTH_ENABLED": "true",
    "IDENTITY_MCP_RESOURCE_URL": RESOURCE,
}
"""What Terraform sets on the identity function, narrowed to what this server needs.

The local signer keeps the suite free of KMS; the package refuses it in production, so
it cannot leak out of a test environment. A key ARN is still required, because it is
what names the `kid` the JWKS publishes, signer or no signer. The environment is `test`
rather than `development` because only `local` and `test` may carry a plaintext issuer.
"""


def pkce_pair() -> tuple[str, str]:
    """A PKCE verifier and its S256 challenge, as an MCP client would compute them."""
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return verifier, base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


@pytest.fixture
def oauth_tables(dynamo_tables: None) -> Iterator[None]:
    """The identity package's tables, beside the product's own in moto.

    The product's `TABLES` deliberately excludes them, because the platform identity
    module provisions them; the shared conftest therefore creates none of them. Both the
    package's own set and the three authorization server tables are created from the
    package's specs rather than from a copy here, so a spec change upstream fails this
    suite instead of passing against a stale shape.

    The token exchange writes a refresh token, so the authorization server's three
    tables alone are not enough to carry a code all the way to a token.
    """
    from webbpulse.identity import OAUTH_SERVER_TABLES
    from webbpulse.identity.storage import TABLES as IDENTITY_TABLES

    from app.common.core.config import settings
    from app.common.db.dynamo.client import get_client

    client = get_client()
    for spec in (*IDENTITY_TABLES, *OAUTH_SERVER_TABLES):
        client.create_table(**spec.create_table_request(settings.dynamodb_table_prefix))
    yield


@pytest.fixture
def identity_environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """The `IDENTITY_*` variables for one test, removed again afterwards."""
    for key, value in IDENTITY_ENVIRONMENT.items():
        monkeypatch.setenv(key, value)
    yield


@pytest.fixture
def client(oauth_tables: None, identity_environment: None, repositories: Any) -> Iterator[TestClient]:
    """A client over the identity package router, with the OAuth server mounted.

    The router is mounted on a bare application rather than through `build_domain_app`,
    because these routes carry the issuer's own absolute paths and nothing else in the
    identity domain is under test here.
    """
    from app.common.core.config import Settings
    from app.domains.identity.package_glue import build_router

    app = FastAPI()
    app.include_router(build_router(Settings(**{"_env_file": None})))  # pyright: ignore[reportCallIssue]
    with TestClient(app) as test_client:
        yield test_client


def register_client(client: TestClient, redirect_uri: str = "http://localhost:7777/callback") -> str:
    """Register a public PKCE client and return its id."""
    response = client.post(
        "/api/auth/register-client",
        json={"redirect_uris": [redirect_uri], "client_name": "Test MCP Client"},
    )
    assert response.status_code == 201, response.text
    return str(response.json()["client_id"])


def test_the_authorization_server_metadata_names_the_five_scopes(client: TestClient) -> None:
    """Discovery advertises exactly the product's scopes, so a client asks for no other."""
    response = client.get(f"{PREFIX}/.well-known/oauth-authorization-server")
    assert response.status_code == 200
    body = response.json()
    assert body["issuer"] == ISSUER
    assert body["scopes_supported"] == PRODUCT_SCOPES
    assert body["registration_endpoint"] == f"{ISSUER}/register-client"


def test_the_metadata_offers_s256_alone_and_no_client_secret(client: TestClient) -> None:
    """S256 only and `none` only: a client that tries `plain` is refused, not narrowed."""
    body = client.get(f"{PREFIX}/.well-known/oauth-authorization-server").json()
    assert body["code_challenge_methods_supported"] == ["S256"]
    assert body["response_types_supported"] == ["code"]
    assert sorted(body["grant_types_supported"]) == ["authorization_code", "refresh_token"]
    assert body["token_endpoint_auth_methods_supported"] == ["none"]


def test_the_protected_resource_metadata_names_the_mcp_endpoint(client: TestClient) -> None:
    """The discovery handshake a 401 from `/api/mcp` sends a client to."""
    response = client.get(f"{PREFIX}/.well-known/oauth-protected-resource")
    assert response.status_code == 200
    body = response.json()
    assert body["resource"] == RESOURCE
    assert body["authorization_servers"] == [ISSUER]
    assert body["scopes_supported"] == PRODUCT_SCOPES


def test_a_public_client_registers(client: TestClient) -> None:
    """Dynamic registration is open, and it issues no client secret."""
    response = client.post(
        "/api/auth/register-client",
        json={"redirect_uris": ["http://localhost:7777/callback"], "client_name": "Claude"},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["client_id"]
    assert "client_secret" not in body
    assert body["token_endpoint_auth_method"] == "none"
    assert body["redirect_uris"] == ["http://localhost:7777/callback"]


def test_a_confidential_client_is_refused(client: TestClient) -> None:
    """A client asking to hold a secret is refused: every MCP client is public."""
    response = client.post(
        "/api/auth/register-client",
        json={
            "redirect_uris": ["http://localhost:7777/callback"],
            "token_endpoint_auth_method": "client_secret_post",
        },
    )
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_client_metadata"


def test_pkce_plain_is_refused(client: TestClient, repositories: Any) -> None:
    """`plain` is not a method this server accepts, whatever the client asks for."""
    make_user(repositories, OWNER, "owner@example.com")
    make_workspace(repositories, WORKSPACE_ONE, "one", OWNER)
    client_id = register_client(client)
    sign_in(client, OWNER)

    verifier, _ = pkce_pair()
    response = client.get(
        "/api/auth/authorize",
        params={
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": "http://localhost:7777/callback",
            "resource": RESOURCE,
            "scope": "issues:read",
            "code_challenge": verifier,
            "code_challenge_method": "plain",
        },
    )
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_request"


def test_an_authorization_request_without_pkce_is_refused(client: TestClient, repositories: Any) -> None:
    """No `code_challenge` at all is refused: PKCE is what stands in for a secret."""
    make_user(repositories, OWNER, "owner@example.com")
    make_workspace(repositories, WORKSPACE_ONE, "one", OWNER)
    client_id = register_client(client)
    sign_in(client, OWNER)

    response = client.get(
        "/api/auth/authorize",
        params={
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": "http://localhost:7777/callback",
            "resource": RESOURCE,
            "scope": "issues:read",
        },
    )
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_request"


def test_a_scope_outside_the_five_is_refused(client: TestClient, repositories: Any) -> None:
    """An unsupported scope is refused rather than dropped, so no client is misled."""
    make_user(repositories, OWNER, "owner@example.com")
    make_workspace(repositories, WORKSPACE_ONE, "one", OWNER)
    client_id = register_client(client)
    sign_in(client, OWNER)

    _, challenge = pkce_pair()
    response = client.get(
        "/api/auth/authorize",
        params={
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": "http://localhost:7777/callback",
            "resource": RESOURCE,
            "scope": "workspaces:admin",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        },
    )
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_scope"


def test_the_consent_screen_offers_every_workspace_the_user_belongs_to(client: TestClient, repositories: Any) -> None:
    """The tenant resolver answers the user's memberships, which is what consent picks from."""
    make_user(repositories, MEMBER, "member@example.com")
    make_workspace(repositories, WORKSPACE_ONE, "one", OWNER)
    make_workspace(repositories, WORKSPACE_TWO, "two", OWNER)
    add_member(repositories, WORKSPACE_ONE, MEMBER, "member")
    add_member(repositories, WORKSPACE_TWO, MEMBER, "member")
    client_id = register_client(client)
    sign_in(client, MEMBER)

    _, challenge = pkce_pair()
    response = client.get(
        "/api/auth/authorize",
        params={
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": "http://localhost:7777/callback",
            "resource": RESOURCE,
            "scope": "issues:read",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        },
    )
    assert response.status_code == 200
    assert WORKSPACE_ONE in response.text
    assert WORKSPACE_TWO in response.text


def test_an_anonymous_authorization_request_is_refused(client: TestClient, repositories: Any) -> None:
    """Nobody consents on behalf of a caller who is not signed in."""
    make_user(repositories, OWNER, "owner@example.com")
    make_workspace(repositories, WORKSPACE_ONE, "one", OWNER)
    client_id = register_client(client)

    _, challenge = pkce_pair()
    response = client.get(
        "/api/auth/authorize",
        params={
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": "http://localhost:7777/callback",
            "resource": RESOURCE,
            "scope": "issues:read",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        },
    )
    assert response.status_code == 401
    assert response.json()["error"] == "login_required"


def hidden_fields(html: str) -> dict[str, str]:
    """The consent form's hidden inputs, which a browser would post back unchanged.

    Parsed out of the rendered page rather than rebuilt, because one of them is the HMAC
    binding the form to the request it approves; a reconstructed form would not carry it.
    """
    pattern = r'<input type="hidden" name="([^"]+)" value="([^"]*)">'
    return {name: value for name, value in re.findall(pattern, html)}


def authorize(client: TestClient, client_id: str, scope: str, challenge: str) -> Any:
    """Drive `GET /authorize` for a signed-in caller and return the consent response."""
    return client.get(
        f"{PREFIX}/authorize",
        params={
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": "http://localhost:7777/callback",
            "resource": RESOURCE,
            "scope": scope,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": "opaque-client-state",
        },
    )


def consent(client: TestClient, html: str, workspace_id: str) -> Any:
    """Post the consent decision, naming the workspace the token will be bound to."""
    fields = hidden_fields(html)
    return client.post(
        f"{PREFIX}/authorize/consent",
        data={**fields, "tenant_id": workspace_id, "decision": "allow"},
        follow_redirects=False,
    )


def code_from(response: Any) -> str:
    """The authorization code off the redirect back to the client."""
    assert response.status_code == 303, response.text
    query = parse_qs(urlsplit(response.headers["location"]).query)
    assert query.get("state") == ["opaque-client-state"]
    return query["code"][0]


def test_a_token_is_bound_to_exactly_one_workspace(client: TestClient, repositories: Any) -> None:
    """Consent names one workspace and the access token carries it as its tenant claim.

    This is what makes an MCP token's blast radius an API key's: a user in two workspaces
    gets a token that reaches one of them, and reaching the other means authorizing again.
    """
    import jwt

    make_user(repositories, MEMBER, "member@example.com")
    make_workspace(repositories, WORKSPACE_ONE, "one", OWNER)
    make_workspace(repositories, WORKSPACE_TWO, "two", OWNER)
    add_member(repositories, WORKSPACE_ONE, MEMBER, "member")
    add_member(repositories, WORKSPACE_TWO, MEMBER, "member")
    client_id = register_client(client)
    sign_in(client, MEMBER)

    verifier, challenge = pkce_pair()
    screen = authorize(client, client_id, "issues:read issues:write", challenge)
    assert screen.status_code == 200

    code = code_from(consent(client, screen.text, WORKSPACE_TWO))
    exchange = client.post(
        f"{PREFIX}/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": client_id,
            "redirect_uri": "http://localhost:7777/callback",
            "code_verifier": verifier,
            "resource": RESOURCE,
        },
    )
    assert exchange.status_code == 200, exchange.text
    body = exchange.json()
    assert body["token_type"] == "Bearer"

    claims = jwt.decode(body["access_token"], options={"verify_signature": False}, audience=RESOURCE)
    assert claims["tenant_id"] == WORKSPACE_TWO
    assert claims["sub"] == MEMBER
    assert claims["aud"] == RESOURCE
    assert sorted(body["scope"].split()) == ["issues:read", "issues:write"]


def test_a_code_cannot_be_spent_twice(client: TestClient, repositories: Any) -> None:
    """Single use is one conditional delete, so the second exchange is refused."""
    make_user(repositories, MEMBER, "member@example.com")
    make_workspace(repositories, WORKSPACE_ONE, "one", OWNER)
    add_member(repositories, WORKSPACE_ONE, MEMBER, "member")
    client_id = register_client(client)
    sign_in(client, MEMBER)

    verifier, challenge = pkce_pair()
    screen = authorize(client, client_id, "issues:read", challenge)
    code = code_from(consent(client, screen.text, WORKSPACE_ONE))
    payload = {
        "grant_type": "authorization_code",
        "code": code,
        "client_id": client_id,
        "redirect_uri": "http://localhost:7777/callback",
        "code_verifier": verifier,
        "resource": RESOURCE,
    }
    assert client.post(f"{PREFIX}/token", data=payload).status_code == 200
    replayed = client.post(f"{PREFIX}/token", data=payload)
    assert replayed.status_code == 400
    assert replayed.json()["error"] == "invalid_grant"


def test_a_wrong_verifier_is_refused(client: TestClient, repositories: Any) -> None:
    """PKCE is what stands in for a client secret, so a mismatched verifier gets nothing."""
    make_user(repositories, MEMBER, "member@example.com")
    make_workspace(repositories, WORKSPACE_ONE, "one", OWNER)
    add_member(repositories, WORKSPACE_ONE, MEMBER, "member")
    client_id = register_client(client)
    sign_in(client, MEMBER)

    _, challenge = pkce_pair()
    screen = authorize(client, client_id, "issues:read", challenge)
    code = code_from(consent(client, screen.text, WORKSPACE_ONE))
    other_verifier, _ = pkce_pair()
    response = client.post(
        f"{PREFIX}/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": client_id,
            "redirect_uri": "http://localhost:7777/callback",
            "code_verifier": other_verifier,
            "resource": RESOURCE,
        },
    )
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_grant"


def test_consent_to_a_workspace_the_user_does_not_belong_to_is_refused(client: TestClient, repositories: Any) -> None:
    """A form edited in the browser cannot bind a token to somebody else's workspace."""
    make_user(repositories, MEMBER, "member@example.com")
    make_workspace(repositories, WORKSPACE_ONE, "one", OWNER)
    make_workspace(repositories, WORKSPACE_TWO, "two", OWNER)
    add_member(repositories, WORKSPACE_ONE, MEMBER, "member")
    client_id = register_client(client)
    sign_in(client, MEMBER)

    _, challenge = pkce_pair()
    screen = authorize(client, client_id, "issues:read", challenge)
    response = consent(client, screen.text, WORKSPACE_TWO)
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_request"
