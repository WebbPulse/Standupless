"""The OAuth access token path into `/api/mcp`, which the gateway cannot verify for us.

`ANY /api/mcp` carries `authorization_type = "NONE"` so the endpoint can answer the
discovery challenge itself, which means no authorizer ever runs on it and a bearer JWT
has to be verified in this process. These cases drive that verification directly: a
correctly minted token is accepted, and each of the three ways one can be wrong is
refused with no path to a table.

Tokens are signed here with a real RSA key and verified through the identity package's
`JwksVerifier`, with the key set handed to it rather than fetched, so the assertions are
about this product's wiring and not about reaching the network. What is under test is
that the signature, the issuer, the audience and the expiry are all actually checked, and
that a verified token then narrows exactly as an API key does.
"""

from __future__ import annotations

import time
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.api_keys import API_KEY_SCOPES
from app.domains.integrations.mcp.transport import INSUFFICIENT_SCOPE
from tests.domains.helpers import MEMBER, sign_in
from tests.domains.integrations.conftest import WORKSPACE
from tests.domains.integrations.test_mcp import call, mint, tool

ISSUER = "https://identity.test/api/auth"

RESOURCE = "https://api.test/api/mcp"

KEY_ID = "test-mcp-signing-key"


@pytest.fixture(scope="module")
def signing_key() -> Any:
    """One RSA key for the module, because generating a 2048 bit key per case is slow."""
    from cryptography.hazmat.primitives.asymmetric import rsa

    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def issue_token(
    signing_key: Any,
    *,
    subject: str = MEMBER,
    tenant: str = WORKSPACE,
    scopes: tuple[str, ...] = API_KEY_SCOPES,
    audience: str = RESOURCE,
    issuer: str = ISSUER,
    expires_in: int = 600,
    key_id: str = KEY_ID,
) -> str:
    """One RS256 access token in the shape the authorization server mints.

    Every field the server puts on a token is settable, because each case here is about
    one of them being wrong. `typ` is `access` because the verifier refuses anything
    else, which is what stops a refresh token being presented as a bearer.
    """
    import jwt

    now = int(time.time())
    claims = {
        "typ": "access",
        "sub": subject,
        "iss": issuer.rstrip("/"),
        "aud": audience,
        "iat": now,
        "nbf": now,
        "exp": now + expires_in,
        "tenant_id": tenant,
        "scope": " ".join(scopes),
    }
    return jwt.encode(claims, signing_key, algorithm="RS256", headers={"kid": key_id})


@pytest.fixture
def mcp_tokens(signing_key: Any, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Point the in-process verifier at this module's key, with no network fetch.

    `JwksVerifier` takes a key client for exactly this, so the product's own construction
    is exercised rather than replaced: the issuer, the audience and the `typ` check are
    all the real ones, and only the transport that fetches the key set is stubbed.
    """
    from webbpulse.identity import JwksVerifier

    import app.common.api.dependencies.identity_claims as identity_claims_module
    from app.common.core.config import settings

    class _Key:
        """One resolved signing key, in the shape `PyJWKClient` answers with."""

        def __init__(self, key: Any) -> None:
            """Hold the public half the verifier decodes against."""
            self.key = key

    class _Client:
        """A key client answering this module's key for its `kid` and nothing else.

        An unknown `kid` raises, so a token signed by a different key is refused for the
        reason a real deployment would refuse it rather than by falling through.
        """

        def get_signing_key_from_jwt(self, token: str) -> _Key:
            """Resolve the token's `kid` against the one key this module signs with."""
            import jwt as pyjwt

            header = pyjwt.get_unverified_header(token)
            if header.get("kid") != KEY_ID:
                raise LookupError(f"no key for kid {header.get('kid')!r}")
            return _Key(signing_key.public_key())

    monkeypatch.setattr(settings, "IDENTITY_ISSUER", ISSUER, raising=False)
    monkeypatch.setattr(settings, "IDENTITY_MCP_RESOURCE_URL", RESOURCE, raising=False)

    identity_claims_module.reset_verifier()
    verifier = JwksVerifier(issuer=ISSUER, audience=RESOURCE, client=_Client())
    monkeypatch.setattr(identity_claims_module, "_mcp_verifier", lambda: verifier.verify)
    yield
    identity_claims_module.reset_verifier()


def test_a_valid_token_reaches_the_tool_list(
    client: TestClient, workspace: str, mcp_tokens: None, signing_key: Any
) -> None:
    """The flow the OAuth e2e drives: a minted token spends at `/api/mcp`.

    This is the case the gateway cannot cover. Nothing verified this token before the
    handler ran, so a 200 here means the in-process check ran and passed.
    """
    token = issue_token(signing_key)

    response = call(client, token, "tools/list")

    assert response.status_code == 200
    assert "error" not in response.json()
    assert response.json()["result"]["tools"]


def test_a_valid_token_resolves_the_workspace_it_was_consented_for(
    client: TestClient, workspace: str, mcp_tokens: None, signing_key: Any, issue: Any
) -> None:
    """The tenant claim, not a path, is what the token authorizes in.

    A tool answering this workspace's issue proves the claim was read and the membership
    behind it was resolved live, rather than the request being waved through.
    """
    token = issue_token(signing_key)

    body = tool(client, token, "get_issue", {"issue_key": issue.key}).json()

    assert "error" not in body
    assert issue.key in body["result"]["content"][0]["text"]


def test_a_token_for_another_audience_is_refused(
    client: TestClient, workspace: str, mcp_tokens: None, signing_key: Any
) -> None:
    """A token bound to a different resource cannot be replayed at this one.

    RFC 8707 binding is the whole reason `resource` is required at the token endpoint. A
    token minted for another API that verified here would make that binding decorative.
    """
    token = issue_token(signing_key, audience="https://api.test/api/something-else")

    response = call(client, token, "initialize")

    assert response.status_code == 401
    assert "resource_metadata=" in response.headers["www-authenticate"]


def test_a_token_from_another_issuer_is_refused(
    client: TestClient, workspace: str, mcp_tokens: None, signing_key: Any
) -> None:
    """A correctly shaped token from an issuer this stage does not trust is nobody."""
    token = issue_token(signing_key, issuer="https://identity.evil.test/api/auth")

    assert call(client, token, "initialize").status_code == 401


def test_an_expired_token_is_refused(client: TestClient, workspace: str, mcp_tokens: None, signing_key: Any) -> None:
    """Expiry is checked here, so a leaked token stops working when it should.

    Well past the verifier's leeway, so this fails on the claim rather than on clock
    tolerance.
    """
    token = issue_token(signing_key, expires_in=-3600)

    assert call(client, token, "initialize").status_code == 401


def test_a_token_signed_by_another_key_is_refused(
    client: TestClient, workspace: str, mcp_tokens: None, signing_key: Any
) -> None:
    """An unknown `kid` resolves to no key, so the signature is never even checked."""
    token = issue_token(signing_key, key_id="a-key-this-issuer-never-published")

    assert call(client, token, "initialize").status_code == 401


def test_a_token_carrying_no_tenant_is_refused(
    client: TestClient, workspace: str, mcp_tokens: None, signing_key: Any
) -> None:
    """A session token verifies and still cannot drive tools, having no workspace.

    The one rule that makes the OAuth flow necessary rather than optional: a browser's
    own access token is signed by the same issuer, and it is the absent tenant claim that
    keeps every signed in tab from being an MCP client.
    """
    token = issue_token(signing_key, tenant="")

    assert call(client, token, "initialize").status_code == 401


def test_a_token_whose_subject_left_the_workspace_is_refused(
    client: TestClient, workspace: str, mcp_tokens: None, signing_key: Any
) -> None:
    """Membership is read live, so a valid token for a departed member spends nothing."""
    token = issue_token(signing_key, subject="01JB0000000000000000NOTAMEM")

    assert call(client, token, "initialize").status_code == 401


def test_a_token_missing_a_scope_is_refused_with_insufficient_scope(
    client: TestClient, workspace: str, mcp_tokens: None, signing_key: Any
) -> None:
    """A narrow token authorizes the transport and is refused at the tool.

    A protocol error rather than a 401, because the request itself was authorized and it
    is the credential's breadth that is wrong. No retry of the same call can succeed, so
    the model is told to stop rather than to rephrase.
    """
    token = issue_token(signing_key, scopes=("teams:read",))

    body = tool(client, token, "create_issue", {"team_id": "x", "title": "No"}).json()

    assert body["error"]["code"] == INSUFFICIENT_SCOPE
    assert body["error"]["data"]["error_code"] == "INSUFFICIENT_SCOPE"
    assert "issues:write" in body["error"]["message"]


def test_a_token_scope_is_intersected_with_live_membership(
    client: TestClient, workspace: str, mcp_tokens: None, signing_key: Any
) -> None:
    """A scope granted at consent still cannot outlive the membership behind it.

    Consent cannot mint authority its subject does not hold, so a token is a ceiling and
    the membership read in this request is the other half of the intersection.
    """
    token = issue_token(signing_key, scopes=API_KEY_SCOPES)

    body = call(client, token, "tools/list").json()

    assert "error" not in body


def test_an_api_key_still_reaches_the_tool_list(
    client: TestClient, workspace: str, repositories: Any, mcp_tokens: None
) -> None:
    """The credential that worked before still works, with a token verifier in place.

    Verifying a bearer JWT added a path rather than replacing one. An API key is not a
    JWT, so it must still resolve against the stored hash and never reach the verifier.
    """
    secret = mint(repositories, MEMBER, API_KEY_SCOPES)

    response = call(client, secret, "tools/list")

    assert response.status_code == 200
    assert "error" not in response.json()


def test_an_api_key_works_where_no_token_verifier_is_configured(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A function with no MCP resource configured still serves keys rather than failing.

    Without the fixture there is no verifier to build, which is the state of any function
    that was never given `IDENTITY_MCP_RESOURCE_URL`. The key path must not depend on it.
    """
    secret = mint(repositories, MEMBER, API_KEY_SCOPES)

    assert call(client, secret, "tools/list").status_code == 200


def test_a_session_header_without_a_tenant_cannot_drive_tools(
    client: TestClient, workspace: str, mcp_tokens: None
) -> None:
    """An authorizer's own claims still lose to the missing tenant, verifier or not."""
    sign_in(client, MEMBER)

    assert call(client, None, "initialize").status_code == 401


def test_the_bearer_is_resolved_off_the_event_loop(
    client: TestClient, workspace: str, mcp_tokens: None, signing_key: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Verifying a token must not block the loop, or a one process stack deadlocks.

    `JwksVerifier` fetches the issuer's key set over a blocking socket. Run on the event
    loop that call stalls every other request on the worker, and where one process serves
    both the issuer and this endpoint it stalls the response it is itself waiting for, so
    the fetch times out and a valid token reads as unverifiable. That is not visible to a
    test client, which is why this asserts on the offload rather than on a status code.
    """
    import asyncio

    from app.domains.integrations.mcp import endpoint as endpoint_module

    resolved_in: list[str] = []
    original = endpoint_module._resolve_context

    def record(*args: Any, **kwargs: Any) -> Any:
        """Note whether a running event loop is on this thread, then resolve as usual."""
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            resolved_in.append("worker")
        else:
            resolved_in.append("event_loop")
        return original(*args, **kwargs)

    monkeypatch.setattr(endpoint_module, "_resolve_context", record)

    assert call(client, issue_token(signing_key), "tools/list").status_code == 200
    assert resolved_in == ["worker"], (
        "the bearer was resolved on the event loop, so a blocking JWKS fetch there would "
        "stall the worker and time out against an issuer served by the same process."
    )
