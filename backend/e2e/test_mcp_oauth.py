"""The M6 MCP authorization flow, driven end to end against the deployed stage.

Nothing else in the suite proves an MCP client can connect. The generic groups probe
`/api/mcp` anonymously and get the 401 challenge, which says the route exists and says
nothing about whether the handshake behind it works. The flow that matters is the one a
desktop MCP client performs on first connect: read the protected resource document, find
the authorization server, register itself, send the user through `/authorize`, exchange
the code at `/token` with its PKCE verifier, and only then call `/api/mcp`. Every step
has to work for the feature to exist, and every step is a different component.

The credential this produces is the one thing that reaches `/api/mcp` at all. A session
JWT carries no tenant claim and is refused on purpose, so before this flow existed there
was no way for a run to hold an MCP token, which is why the three `/api/mcp` routes sat
in the coverage allowlist. They come out with this module.

Every call goes through the shared `E2EClient`, the form encoded ones included: from
webbpulse 0.53.0 its `data=` sends `application/x-www-form-urlencoded`, which is what
`/token` and the consent post require of an RFC 6749 client. That keeps the pacing, the
gate header, the 429 retry and the access log record on these requests like every other
request the suite makes, so a failure here is traceable to a gateway entry rather than
invisible. The client never follows a redirect, which this flow depends on: the consent
post answers 303 and the authorization code is in that `Location`, pointing at a loopback
port nothing binds.

The whole sequence is one case. Splitting it would mean either repeating the registration
and consent for every assertion, which multiplies writes against a shared stage, or
passing a live token between cases through a session fixture, which hides which step
broke. One case that fails at the step that broke is the more useful failure.
"""

from __future__ import annotations

import base64
import hashlib
import html
import re
import secrets
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from webbpulse.e2e import worker_id

WRITES = pytest.mark.e2e_writes

REDIRECT_URI = "http://127.0.0.1:41999/callback"
"""The loopback callback an MCP client registers, which is never actually fetched.

Loopback with a port is what a desktop client uses and what the package's redirect
validation accepts. The flow reads the code out of the 303's `Location` rather than
following it, so nothing listens here.
"""

EXPECTED_TOOLS = frozenset(
    {
        "search_issues",
        "get_issue",
        "create_issue",
        "update_issue",
        "assign_issue",
        "add_comment",
        "list_teams",
        "list_statuses",
    }
)
"""The eight tools `docs/api/m6.md` fixes, named here so a silent addition fails.

An extra tool on the list is a new capability handed to every connected agent, which is
worth failing a deploy over rather than discovering from a model calling it.
"""

EXPECTED_SCOPES = frozenset({"issues:read", "issues:write", "comments:write", "teams:read", "views:read"})
"""The five scopes `MCP_SCOPES` pins, which both discovery documents must advertise."""

_HIDDEN_INPUT = re.compile(
    r"""<input\s+type="hidden"\s+name="(?P<name>[^"]+)"\s+value="(?P<value>[^"]*)"\s*>""",
    re.IGNORECASE,
)


def _pkce_pair() -> "tuple[str, str]":
    """A fresh PKCE verifier and its S256 challenge, base64url with no padding.

    Generated per run rather than fixed, because a verifier checked into a repository is
    a verifier every other caller can replay against a code they intercepted.
    """
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("=")
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return verifier, base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _hidden_fields(body: str) -> "dict[str, str]":
    """Every hidden input on the consent form, unescaped, keyed by name.

    The form carries an HMAC over these exact values, so they are replayed as rendered
    rather than rebuilt: a field this test reconstructed would be a field whose signature
    no longer matches, and the refusal would look like a server fault.
    """
    return {
        html.unescape(match.group("name")): html.unescape(match.group("value"))
        for match in _HIDDEN_INPUT.finditer(body)
    }


def _first_tenant(body: str) -> str:
    """The first workspace the consent screen offers, or an empty string when it offers none.

    An empty string is a meaningful answer rather than a parse failure: the renderer drops
    the select entirely when the account has no workspace whose membership delegates a
    scope, and the caller reports that as the product fact it is.
    """
    match = re.search(r"""<select\s+name="tenant_id"[^>]*>(?P<options>.*?)</select>""", body, re.DOTALL)
    if match is None:
        return ""
    option = re.search(r"""<option\s+value="(?P<id>[^"]*)\"""", match.group("options"))
    return html.unescape(option.group("id")) if option is not None else ""


def _call_mcp(client: Any, token: str, method: str, request_id: int) -> Any:
    """One JSON-RPC call to `/api/mcp`, returning the raw response for the caller to judge.

    Separate from `_rpc` because the first call of the flow has to distinguish a refusal
    from a protocol error, and `_rpc` treats any non-200 as a transport failure. Sent
    through the shared client either way, so the route is recorded for coverage.
    """
    return client.with_token(token).post(
        "/api/mcp",
        json={"jsonrpc": "2.0", "id": request_id, "method": method},
        headers={"content-type": "application/json"},
    )


def _rpc(client: Any, token: str, method: str, request_id: int) -> "dict[str, Any]":
    """One JSON-RPC call to `/api/mcp` with the MCP token, failing on a transport refusal.

    Sent through the shared client so the call is recorded for route coverage. A JSON-RPC
    error is returned rather than raised, because the caller asserts on it: the endpoint
    answers 200 with an `error` member for a protocol failure, and treating that as a
    transport failure would hide what the server actually said.
    """
    response = client.with_token(token).post(
        "/api/mcp",
        json={"jsonrpc": "2.0", "id": request_id, "method": method},
        headers={"content-type": "application/json"},
    )
    if response.status_code != 200:
        pytest.fail(
            f"MCP {method} answered {response.status_code} with the OAuth token this flow minted: {response.text[:400]}"
        )
    return dict(response.json())


@pytest.fixture(scope="session")
def mcp_resource(anon: Any) -> str:
    """The resource identifier, read from the discovery document rather than rebuilt.

    RFC 8707 compares `resource` as a string, so the value has to be the deployment's own
    `IDENTITY_MCP_RESOURCE_URL` character for character. Rebuilding it from the API base URL
    looks equivalent and is not: a stack configured with `localhost` refuses a request naming
    `127.0.0.1`, and the refusal reads as a broken authorization server rather than as two
    spellings of one host. A real client reads this document for the same reason.
    """
    response = anon.get("/api/auth/.well-known/oauth-protected-resource")
    if response.status_code != 200:
        pytest.fail(
            f"the protected resource document answered {response.status_code}, so the resource "
            f"identifier this flow must name is unknown: {response.text[:400]}"
        )
    return str(response.json()["resource"])


@pytest.fixture(scope="session")
def mcp_workspace(api: Any, e2e_env: Any, request: pytest.FixtureRequest) -> "Any":
    """A workspace this run owns, so consent has a tenant to bind the token to.

    Its own rather than shared with `test_product_flows`, because the two modules are
    separate sessions under xdist and a fixture from one is not reachable from the other.
    The name carries the worker id for the same reason it does there: session fixtures are
    per worker, and a slug is claimed across every tenant rather than inside one.
    """
    worker = worker_id(request.config)
    prefix = e2e_env.resource_prefix if worker == "master" else f"{e2e_env.resource_prefix}{worker}-"
    body = {"name": f"{prefix}mcp-oauth", "slug": f"{prefix}mcp".replace("_", "-")[-40:].strip("-")}
    response = api.post("/api/workspaces", json=body)
    if response.status_code not in (200, 201):
        pytest.fail(f"creating the workspace for the MCP flow answered {response.status_code}: {response.text[:400]}")
    created = dict(response.json())
    yield created
    api.delete(f"/api/workspaces/{created['id']}")


class TestMcpDiscovery:
    """The two documents an MCP client reads before it can do anything else."""

    def test_the_protected_resource_document_names_this_api_and_its_authorization_server(
        self, anon: Any, e2e_env: Any
    ) -> None:
        """RFC 9728 discovery: the resource names itself, its server and its scopes.

        Read under the issuer prefix rather than at the origin root. The package serves both
        documents under the issuer, and `terraform/apigateway.tf` also declares root level
        route keys for them which answer 404 on the deployed stage. That mismatch is recorded
        in the pull request rather than asserted here: this case is about the document a
        client actually reaches, which is the one the challenge header points at.
        """
        response = anon.get("/api/auth/.well-known/oauth-protected-resource")
        assert response.status_code == 200, (
            f"the protected resource document answered {response.status_code}. An MCP client "
            f"reads this first and cannot discover the authorization server without it: {response.text[:400]}"
        )
        document = response.json()
        assert str(document["resource"]).rstrip("/").endswith("/api/mcp"), (
            f"the document's resource is {document['resource']!r}, which is not this API's MCP endpoint. "
            "A token bound to that audience would be refused by the resource it was minted for."
        )
        servers = [str(value).rstrip("/") for value in document["authorization_servers"]]
        assert servers, "the document advertises no authorization server, so discovery stops here."
        assert all(server.endswith("/api/auth") for server in servers), (
            f"the advertised authorization servers are {servers}, which are not this stage's issuer."
        )
        assert EXPECTED_SCOPES.issubset(set(document["scopes_supported"])), (
            f"the document advertises {sorted(document['scopes_supported'])}, which is missing one of the "
            f"five scopes the contract fixes: {sorted(EXPECTED_SCOPES)}."
        )

    def test_the_authorization_server_document_names_the_three_endpoints_the_flow_uses(self, anon: Any) -> None:
        """RFC 8414 discovery: registration, authorization and token, plus S256.

        The three endpoints are asserted by path suffix rather than by exact URL, so the case
        reads the same against staging and a local stack. What matters is that the document
        points at the endpoints this flow then drives, and that PKCE S256 is offered: a server
        advertising `plain` would be offering a challenge that proves nothing.
        """
        response = anon.get("/api/auth/.well-known/oauth-authorization-server")
        assert response.status_code == 200, (
            f"the authorization server document answered {response.status_code}: {response.text[:400]}"
        )
        document = response.json()
        for key, suffix in (
            ("registration_endpoint", "/register-client"),
            ("authorization_endpoint", "/authorize"),
            ("token_endpoint", "/token"),
        ):
            assert str(document[key]).endswith(suffix), (
                f"{key} is {document[key]!r}, which does not end in {suffix!r}. A client follows this "
                "document rather than guessing paths, so a wrong one strands it here."
            )
        assert "S256" in document["code_challenge_methods_supported"], (
            "the server does not advertise S256, so a client has no proof of possession method to use."
        )


class TestMcpOAuthFlow:
    """The whole authorization code flow, from registration to a tool list."""

    @WRITES
    def test_a_registered_client_authorizes_and_calls_the_mcp_endpoint(
        self,
        anon: Any,
        api: Any,
        mcp_resource: str,
        mcp_workspace: "dict[str, Any]",
    ) -> None:
        """Register, authorize, consent, exchange, then initialize and list tools.

        This is the connect sequence a desktop MCP client performs, in order, against the
        deployed stage. Each step asserts on the step's own failure mode, so a break reports
        which component refused rather than a tool list that never arrived.

        The authorization request and the consent post go through `api` rather than `anon`,
        because `/authorize` resolves the subject through the same path every other identity
        route uses and answers 401 to an anonymous caller by design. A browser would carry a
        session cookie here; `api` carries the bearer the run already signed in with.
        Registration and both token exchanges go through `anon`, because an RFC 6749 public
        client holds no credential at those endpoints and a bearer there would prove nothing.

        The last step spends the token, which is the assertion the rest of the flow exists
        to reach. The gateway verifies nothing on `/api/mcp` by design, so a 200 there is
        proof that the integrations function verified the bearer itself against the
        issuer's published key set.
        """
        verifier, challenge = _pkce_pair()

        registration = anon.post(
            "/api/auth/register-client",
            json={
                "client_name": "webbpulse e2e mcp client",
                "redirect_uris": [REDIRECT_URI],
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
            },
        )
        assert registration.status_code == 201, (
            f"dynamic client registration answered {registration.status_code}. An MCP client that "
            f"cannot register cannot connect at all: {registration.text[:400]}"
        )
        client_id = str(registration.json()["client_id"])
        assert "client_secret" not in registration.json(), (
            "the registration response carries a client_secret. This server registers public PKCE "
            "clients, and a secret shipped inside a desktop client is a published credential."
        )

        state = secrets.token_urlsafe(16)
        authorize = api.get(
            "/api/auth/authorize",
            params={
                "response_type": "code",
                "client_id": client_id,
                "redirect_uri": REDIRECT_URI,
                "resource": mcp_resource,
                "scope": " ".join(sorted(EXPECTED_SCOPES)),
                "state": state,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
            },
        )
        assert authorize.status_code == 200, (
            f"/authorize answered {authorize.status_code} for the signed in e2e user, so the consent "
            f"screen never rendered: {authorize.text[:400]}"
        )

        fields = _hidden_fields(authorize.text)
        assert "signature" in fields, (
            "the consent form carries no signature field, so the post below could not be accepted. "
            f"fields were {sorted(fields)}."
        )
        tenant_id = _first_tenant(authorize.text)
        assert tenant_id, (
            "the consent screen offered no workspace to grant access to, although this run created "
            f"workspace {mcp_workspace['id']}. A token can only ever be bound to a workspace whose "
            "membership delegates at least one MCP scope, so this is where that intersection broke."
        )

        consent = api.post(
            "/api/auth/authorize/consent",
            data={**fields, "decision": "allow", "tenant_id": tenant_id},
        )
        assert consent.status_code == 303, (
            f"the consent post answered {consent.status_code} rather than redirecting with a code: {consent.text[:400]}"
        )
        redirected = parse_qs(urlsplit(consent.headers["location"]).query)
        assert "error" not in redirected, (
            f"consent redirected with an error rather than a code: {redirected.get('error')} "
            f"{redirected.get('error_description')}"
        )
        code = redirected["code"][0]
        assert redirected.get("state", [""])[0] == state, (
            "the redirect came back with a different state than the one sent, which is the CSRF "
            "check a client performs before it exchanges anything."
        )

        exchange = anon.post(
            "/api/auth/token",
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": REDIRECT_URI,
                "client_id": client_id,
                "code_verifier": verifier,
                "resource": mcp_resource,
            },
        )
        assert exchange.status_code == 200, (
            f"the code exchange answered {exchange.status_code}, so the PKCE verifier, the code or the "
            f"resource was refused: {exchange.text[:400]}"
        )
        token_body = exchange.json()
        assert token_body.get("token_type", "").lower() == "bearer", (
            f"the token response names token_type {token_body.get('token_type')!r} rather than Bearer."
        )
        access_token = str(token_body["access_token"])

        spent = anon.post(
            "/api/auth/token",
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": REDIRECT_URI,
                "client_id": client_id,
                "code_verifier": verifier,
                "resource": mcp_resource,
            },
        )
        assert spent.status_code == 400, (
            f"replaying the authorization code answered {spent.status_code} rather than refusing it. "
            "An authorization code is single use, and a reusable one is replayable by anyone who "
            "reads it out of a redirect."
        )

        served = _call_mcp(api, access_token, "initialize", 1)
        assert served.status_code != 401, (
            "the authorization server minted a correct MCP token and /api/mcp refused it. The gateway "
            "declares ANY /api/mcp with authorization_type NONE, deliberately, so the endpoint can "
            "answer the discovery challenge itself, which means the integrations function verifies the "
            "bearer in process against the issuer's published keys. A 401 here means that verification "
            "did not run or did not pass: check that the function carries IDENTITY_ISSUER and "
            "IDENTITY_MCP_RESOURCE_URL, and that the latter is character for character the resource "
            f"this flow named, {mcp_resource!r}. Response: {served.text[:400]}"
        )

        assert served.status_code == 200, (
            f"MCP initialize answered {served.status_code} with the OAuth token this flow minted: {served.text[:400]}"
        )
        initialized = dict(served.json())
        assert "error" not in initialized, f"MCP initialize returned an error: {initialized['error']}"
        info = initialized["result"]["serverInfo"]
        assert info["name"] == "standupless", f"the server introduced itself as {info['name']!r}."
        assert initialized["result"]["capabilities"].get("tools") is not None, (
            "the handshake advertises no tools capability, so a client would never call tools/list."
        )

        listed = _rpc(api, access_token, "tools/list", 2)
        assert "error" not in listed, f"MCP tools/list returned an error: {listed['error']}"
        names = {str(tool["name"]) for tool in listed["result"]["tools"]}
        assert names == EXPECTED_TOOLS, (
            f"the tool list is {sorted(names)}, which is not the eight tools docs/api/m6.md fixes: "
            f"{sorted(EXPECTED_TOOLS)}. Missing: {sorted(EXPECTED_TOOLS - names)}. "
            f"Unexpected: {sorted(names - EXPECTED_TOOLS)}."
        )

    @WRITES
    def test_the_mcp_endpoint_refuses_the_session_token_and_challenges_anonymously(self, api: Any, anon: Any) -> None:
        """A browser session is refused, and an anonymous caller gets the discovery challenge.

        Both halves matter and neither is covered by the flow above. The session refusal is
        the rule that makes the OAuth flow necessary rather than optional: if a session JWT
        worked here, every browser tab would be an MCP client. The challenge is what starts
        discovery, so a 401 without it strands a client that has no token yet.

        `DELETE` is driven here too, with the session token, so the third `/api/mcp` route is
        exercised. It answers the same refusal for the same reason.
        """
        rejected = api.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"})
        assert rejected.status_code == 401, (
            f"/api/mcp answered {rejected.status_code} to a browser session token rather than refusing "
            "it. A session carries no tenant claim, so treating it as an MCP credential would make "
            "every signed in tab a tool caller."
        )

        ended = api.delete("/api/mcp")
        assert ended.status_code == 401, (
            f"DELETE /api/mcp answered {ended.status_code} to a session token rather than refusing it."
        )

        challenged = anon.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"})
        assert challenged.status_code == 401, (
            f"/api/mcp answered {challenged.status_code} to an anonymous caller rather than 401."
        )
        challenge = challenged.headers.get("www-authenticate", "")
        assert "resource_metadata=" in challenge, (
            f"the 401 carries no resource_metadata in its WWW-Authenticate header: {challenge!r}. "
            "That parameter is how a client with no token finds the authorization server."
        )

        refused_get = anon.get("/api/mcp")
        assert refused_get.status_code == 405, (
            f"GET /api/mcp answered {refused_get.status_code} rather than 405. There is no SSE stream "
            "here, and the path exists, so the method is what is wrong."
        )
