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
import json
import re
import secrets
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from webbpulse.e2e import worker_id
from webbpulse.e2e.identity import login, refresh

WRITES = pytest.mark.e2e_writes

REDIRECT_URI = "http://127.0.0.1:41999/callback"
"""The loopback callback an MCP client registers, which is never actually fetched.

Loopback with a port is what a desktop client uses and what the package's redirect
validation accepts. The flow reads the code out of the 303's `Location` rather than
following it, so nothing listens here.
"""

EXPECTED_TOOLS = frozenset(
    {
        "add_comment",
        "add_issues_to_cycle",
        "add_team_member",
        "archive_issue",
        "assign_issue",
        "backfill_releases",
        "bulk_update_issues",
        "create_channel",
        "create_cycle",
        "create_issue",
        "create_issue_relation",
        "create_label",
        "create_milestone",
        "create_project",
        "create_project_update",
        "create_status",
        "create_team",
        "create_view",
        "create_workspace_label",
        "create_workspace_status",
        "delete_channel",
        "delete_cycle",
        "delete_issue_relation",
        "delete_label",
        "delete_milestone",
        "delete_notification",
        "delete_project",
        "delete_project_update",
        "delete_status",
        "delete_team",
        "delete_view",
        "export_workspace",
        "delete_workspace_label",
        "delete_workspace_status",
        "get_cycle",
        "get_insights",
        "get_issue",
        "get_project",
        "get_standup",
        "get_team",
        "get_team_github_sync",
        "get_triage_summary",
        "get_workspace",
        "get_workspace_export",
        "invite_member",
        "join_team",
        "leave_team",
        "list_channels",
        "list_comments",
        "list_cycles",
        "list_github_transitions",
        "list_invites",
        "list_issue_activity",
        "list_issue_relations",
        "list_issue_subscribers",
        "list_issues",
        "list_labels",
        "list_my_issues",
        "list_notifications",
        "list_project_milestones",
        "list_project_updates",
        "list_projects",
        "list_statuses",
        "list_team_members",
        "list_teams",
        "list_triage_issues",
        "list_users",
        "list_views",
        "list_workspace_labels",
        "list_workspace_exports",
        "list_audit_events",
        "list_workspace_members",
        "list_workspace_statuses",
        "mark_all_notifications_read",
        "mark_notification_read",
        "mark_notification_unread",
        "move_issue",
        "override_team_label",
        "override_team_status",
        "remove_issues_from_cycle",
        "remove_member",
        "remove_team_member",
        "reset_team_label_override",
        "reset_team_status_override",
        "revoke_invite",
        "list_approved_domains",
        "add_approved_domain",
        "remove_approved_domain",
        "search_issues",
        "set_github_transitions",
        "set_standup_note",
        "snooze_notification",
        "subscribe_to_issue",
        "test_channel",
        "triage_issue",
        "unarchive_issue",
        "unsubscribe_from_issue",
        "update_channel",
        "update_cycle",
        "update_issue",
        "update_label",
        "update_member_role",
        "update_milestone",
        "update_project",
        "update_project_update",
        "update_standup_settings",
        "update_status",
        "update_team",
        "update_team_archive_settings",
        "update_team_auto_close_settings",
        "update_team_cycle_settings",
        "update_team_github_sync",
        "pin_team_repository",
        "update_team_member_role",
        "update_team_sla_settings",
        "update_team_triage_settings",
        "update_view",
        "update_workspace",
        "update_workspace_label",
        "update_workspace_status",
        "list_releases",
        "get_release",
        "create_release",
        "advance_release",
        "update_release",
        "add_issues_to_release",
        "remove_issue_from_release",
        "delete_release",
        "get_release_pipeline",
        "set_release_pipeline",
        "list_initiatives",
        "get_initiative",
        "create_initiative",
        "update_initiative",
        "delete_initiative",
        "add_project_to_initiative",
        "remove_project_from_initiative",
        "list_initiative_updates",
        "create_initiative_update",
        "update_initiative_update",
        "delete_initiative_update",
        "list_documents",
        "get_document",
        "create_document",
        "update_document",
        "delete_document",
    }
)
"""The tools `docs/api/m6.md` fixes, named here so a silent addition fails.

An extra tool on the list is a new capability handed to every connected agent, which is
worth failing a deploy over rather than discovering from a model calling it.
"""

EXPECTED_SCOPES = frozenset(
    {
        "issues:read",
        "issues:write",
        "comments:write",
        "teams:read",
        "teams:write",
        "members:read",
        "members:write",
        "statuses:read",
        "statuses:write",
        "labels:read",
        "labels:write",
        "projects:read",
        "projects:write",
        "milestones:read",
        "milestones:write",
        "cycles:read",
        "cycles:write",
        "releases:read",
        "releases:write",
        "views:read",
        "views:write",
        "notifications:read",
        "notifications:write",
        "settings:read",
        "settings:write",
        "admin",
    }
)
"""The scopes `MCP_SCOPES` pins, which both discovery documents must advertise."""

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


def _offered_tenants(body: str) -> "list[str]":
    """Every workspace id the consent screen offers, in the order it renders them.

    From webbpulse 0.64.0 the picker is a set of radio inputs; an older package rendered
    a select, which is still read so either page parses. An empty list is a meaningful
    answer rather than a parse failure: the screen offers no input when the account has
    no workspace whose membership delegates a scope.
    """
    radios = re.findall(r"""<input\s+type="radio"\s+name="tenant_id"\s+value="([^"]*)"[^>]*>""", body)
    if radios:
        return [html.unescape(value) for value in radios]
    match = re.search(r"""<select\s+name="tenant_id"[^>]*>(?P<options>.*?)</select>""", body, re.DOTALL)
    if match is None:
        return []
    return [html.unescape(value) for value in re.findall(r"""<option\s+value="([^"]*)\"""", match.group("options"))]


def _first_tenant(body: str) -> str:
    """The workspace the consent screen preselects, or an empty string when it offers none."""
    offered = _offered_tenants(body)
    return offered[0] if offered else ""


def _run_tenant(body: str, workspace: "dict[str, Any]") -> str:
    """The run-owned workspace's id, failing when the consent screen does not offer it.

    The screen preselects the caller's oldest membership, which is whatever workspace
    another module on this worker happened to create first. Binding to that made the
    flow read and write a tenant it does not own, and made its team assertions depend
    on test order, so the token is bound to the workspace this module created instead.
    """
    workspace_id = str(workspace["id"])
    offered = _offered_tenants(body)
    assert workspace_id in offered, (
        f"the consent screen offered {offered}, which leaves out workspace {workspace_id} this run "
        "created. A token can only ever be bound to a workspace whose membership delegates at least "
        "one MCP scope, so this is where that intersection broke."
    )
    return workspace_id


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


def _rpc(client: Any, token: str, method: str, request_id: int, params: Any = None) -> "dict[str, Any]":
    """One JSON-RPC call to `/api/mcp` with the MCP token, failing on a transport refusal.

    Sent through the shared client so the call is recorded for route coverage. A JSON-RPC
    error is returned rather than raised, because the caller asserts on it: the endpoint
    answers 200 with an `error` member for a protocol failure, and treating that as a
    transport failure would hide what the server actually said.
    """
    payload: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        payload["params"] = params
    response = client.with_token(token).post(
        "/api/mcp",
        json=payload,
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
def mcp_workspace(api: Any, e2e_env: Any, request: pytest.FixtureRequest, schedule_workspace_deletion: Any) -> "Any":
    """A workspace and team this run owns, so consent binds the token to a known tenant.

    Its own rather than borrowed from another module, because every module on a worker
    signs in as the same user and the consent screen preselects whichever workspace was
    created first. The team is created here for the same reason: a new workspace has
    none, and the tool calls below need one that exists whatever ran before them. The
    name carries the worker id because a slug is claimed across every tenant, and the
    teardown schedules the deletion, since there is no route that deletes at once.
    """
    worker = worker_id(request.config)
    prefix = e2e_env.resource_prefix if worker == "master" else f"{e2e_env.resource_prefix}{worker}-"
    body = {"name": f"{prefix}mcp-oauth", "slug": f"{prefix}mcp".replace("_", "-")[-40:].strip("-")}
    response = api.post("/api/workspaces", json=body)
    if response.status_code not in (200, 201):
        pytest.fail(f"creating the workspace for the MCP flow answered {response.status_code}: {response.text[:400]}")
    created = dict(response.json())
    teams = f"/api/workspaces/{created['id']}/teams"
    team = api.post(teams, json={"name": f"{prefix}mcp-team", "key_prefix": "MCP"})
    if team.status_code not in (200, 201):
        pytest.fail(f"creating the team for the MCP flow answered {team.status_code}: {team.text[:400]}")
    created["team"] = dict(team.json())
    yield created
    api.delete(f"{teams}/{created['team']['id']}")
    schedule_workspace_deletion(created["id"])


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
            f"scopes the contract fixes: {sorted(EXPECTED_SCOPES)}."
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
        tenant_id = _run_tenant(authorize.text, mcp_workspace)

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
            f"the tool list is {sorted(names)}, which is not the tool set docs/api/m6.md fixes: "
            f"{sorted(EXPECTED_TOOLS)}. Missing: {sorted(EXPECTED_TOOLS - names)}. "
            f"Unexpected: {sorted(names - EXPECTED_TOOLS)}."
        )

        members = _rpc(api, access_token, "tools/call", 3, {"name": "list_users", "arguments": {}})
        assert "error" not in members, f"MCP list_users returned an error: {members['error']}"
        assert members["result"]["isError"] is False, f"list_users refused: {members['result']['content']}"
        listed_users = json.loads(members["result"]["content"][0]["text"])["users"]
        assert listed_users, "list_users answered no members for the workspace this flow created."

        team_id = str(mcp_workspace["team"]["id"])
        teams = _tool(api, access_token, 4, "list_teams", {})
        assert team_id in {str(team["team_id"]) for team in teams["teams"]}, (
            f"list_teams answered {teams['teams']}, which leaves out team {team_id} this run created in "
            "the workspace the token is bound to."
        )
        one = _tool(api, access_token, 5, "get_team", {"team_id": team_id})
        assert one["statuses"], "get_team answered no statuses for the run's own team."

        _exercise_every_resource(api, access_token, team_id)

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


def _tool(client: Any, token: str, request_id: int, name: str, arguments: "dict[str, Any]") -> "dict[str, Any]":
    """One `tools/call` that must succeed, returning the tool's JSON answer."""
    answered = _rpc(client, token, "tools/call", request_id, {"name": name, "arguments": arguments})
    assert "error" not in answered, f"MCP {name} returned a protocol error: {answered['error']}"
    assert answered["result"]["isError"] is False, f"{name} refused: {answered['result']['content']}"
    return dict(json.loads(answered["result"]["content"][0]["text"]))


def _exercise_every_resource(client: Any, token: str, team_id: str) -> None:
    """A representative write per resource the consented token can drive, cleaned up as it goes.

    Everything is created in the run-owned workspace, which teardown deletes, so a failure
    part way leaves nothing behind in a shared one.
    """
    status = _tool(
        client, token, 10, "create_status", {"team_id": team_id, "name": "E2E review", "category": "started"}
    )
    assert _tool(client, token, 11, "delete_status", {"team_id": team_id, "status": status["status_id"]})["deleted"]

    label = _tool(client, token, 12, "create_label", {"team_id": team_id, "name": "e2e-mcp", "color": "#336699"})
    renamed = _tool(
        client, token, 13, "update_label", {"team_id": team_id, "label": label["label_id"], "name": "e2e-mcp-2"}
    )
    assert renamed["name"] == "e2e-mcp-2", f"update_label kept the name {renamed['name']!r}."
    assert _tool(client, token, 14, "delete_label", {"team_id": team_id, "label": "e2e-mcp-2"})["deleted"]

    cycle = _tool(
        client,
        token,
        15,
        "create_cycle",
        {"team_id": team_id, "name": "E2E cycle", "start_date": "2030-01-01", "end_date": "2030-01-14"},
    )
    assert _tool(client, token, 16, "delete_cycle", {"team_id": team_id, "cycle_id": cycle["cycle_id"]})["deleted"]

    project = _tool(client, token, 17, "create_project", {"name": "E2E project", "team_ids": [team_id]})
    milestone = _tool(
        client, token, 18, "create_milestone", {"project_id": project["project_id"], "name": "E2E milestone"}
    )
    removed = _tool(
        client,
        token,
        19,
        "delete_milestone",
        {"project_id": project["project_id"], "milestone_id": milestone["milestone_id"]},
    )
    assert removed["deleted"]
    assert _tool(client, token, 20, "delete_project", {"project_id": project["project_id"]})["deleted"]

    view = _tool(client, token, 21, "create_view", {"name": "E2E view"})
    assert _tool(client, token, 22, "delete_view", {"view_id": view["view_id"]})["deleted"]

    assert "notifications" in _tool(client, token, 23, "list_notifications", {})
    assert _tool(client, token, 24, "get_workspace", {})["role"] == "owner", (
        "get_workspace did not name the caller's role."
    )
    assert _tool(client, token, 25, "list_workspace_members", {})["members"], "list_workspace_members answered nobody."

    issue = _tool(client, token, 26, "create_issue", {"team_id": team_id, "title": "E2E subscribe"})
    assert _tool(client, token, 27, "subscribe_to_issue", {"issue_id": issue["issue_key"]})["subscribed"] is True
    assert _tool(client, token, 28, "unsubscribe_from_issue", {"issue_id": issue["issue_key"]})["subscribed"] is False


def _register(anon: Any) -> str:
    """Register a public PKCE client for `REDIRECT_URI` and return its client id."""
    registration = anon.post(
        "/api/auth/register-client",
        json={
            "client_name": "webbpulse e2e mcp browser client",
            "redirect_uris": [REDIRECT_URI],
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
        },
    )
    assert registration.status_code == 201, (
        f"dynamic client registration answered {registration.status_code}: {registration.text[:400]}"
    )
    return str(registration.json()["client_id"])


def _authorize_params(client_id: str, resource: str, challenge: str, state: str) -> "dict[str, str]":
    """The authorization request an MCP client sends the browser to."""
    return {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "resource": resource,
        "scope": " ".join(sorted(EXPECTED_SCOPES)),
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }


class TestMcpBrowserSignIn:
    """The browser half of the flow: no bearer, only what a signed in tab carries.

    A real MCP client opens `/authorize` in the user's browser, which holds the refresh
    cookie and never a bearer. These cases drive exactly that: an anonymous request is
    sent to the product login page with the authorize URL to come back to, and a request
    carrying only the refresh cookie renders consent and completes it.
    """

    @WRITES
    def test_an_anonymous_authorize_is_sent_to_the_login_page_with_a_return(self, anon: Any, mcp_resource: str) -> None:
        """No session means a redirect to `IDENTITY_MCP_LOGIN_URL` with `returnTo` set.

        The return must be the issuer's own authorize URL, rebuilt from the issuer rather
        than from the request host, so the login page can hand the browser straight back.
        """
        issuer = str(anon.get("/api/auth/.well-known/oauth-authorization-server").json()["issuer"]).rstrip("/")
        _, challenge = _pkce_pair()
        params = _authorize_params(_register(anon), mcp_resource, challenge, secrets.token_urlsafe(16))
        response = anon.get("/api/auth/authorize", params=params)
        assert response.status_code == 302, (
            f"an anonymous /authorize answered {response.status_code} rather than sending the browser to "
            f"sign in. Check IDENTITY_MCP_LOGIN_URL on the identity function: {response.text[:400]}"
        )
        location = urlsplit(response.headers["location"])
        assert location.path.rstrip("/").endswith("/login"), f"the redirect went to {location.path!r}."
        returned = parse_qs(location.query).get("returnTo", [""])[0]
        assert returned.startswith(f"{issuer}/authorize?"), (
            f"returnTo is {returned!r}, which is not this issuer's authorize URL."
        )
        assert parse_qs(urlsplit(returned).query).get("client_id") == [params["client_id"]], (
            "returnTo lost the authorization request it was meant to resume."
        )

    @WRITES
    def test_the_refresh_cookie_alone_authorizes_and_consents(
        self,
        anon: Any,
        credentials: Any,
        mcp_resource: str,
        mcp_workspace: "dict[str, Any]",
    ) -> None:
        """A fresh sign in's refresh cookie, with no bearer, reaches consent and gets a code.

        The lookup behind this is read only, so the same cookie still refreshes afterwards,
        which is asserted too: a peek that rotated or consumed the token would sign the
        user out of the tab that just granted access.
        """
        session = login(anon, credentials.email, credentials.password)
        cookie = "; ".join(f"{name}={value}" for name, value in session.refresh_cookies.items())
        assert cookie, "signing in set no refresh cookie, so there is nothing for a browser to carry."
        try:
            verifier, challenge = _pkce_pair()
            client_id = _register(anon)
            state = secrets.token_urlsafe(16)
            authorize = anon.get(
                "/api/auth/authorize",
                params=_authorize_params(client_id, mcp_resource, challenge, state),
                headers={"cookie": cookie},
            )
            assert authorize.status_code == 200, (
                f"/authorize answered {authorize.status_code} to a browser carrying only the refresh "
                f"cookie: {authorize.text[:400]}"
            )
            fields = _hidden_fields(authorize.text)
            tenant_id = _run_tenant(authorize.text, mcp_workspace)

            consent = anon.post(
                "/api/auth/authorize/consent",
                data={**fields, "decision": "allow", "tenant_id": tenant_id},
                headers={"cookie": cookie},
            )
            assert consent.status_code == 303, (
                f"the cookie consent post answered {consent.status_code}: {consent.text[:400]}"
            )
            redirected = parse_qs(urlsplit(consent.headers["location"]).query)
            assert "error" not in redirected, f"consent redirected with {redirected.get('error')}."
            assert redirected.get("state", [""])[0] == state

            exchange = anon.post(
                "/api/auth/token",
                data={
                    "grant_type": "authorization_code",
                    "code": redirected["code"][0],
                    "redirect_uri": REDIRECT_URI,
                    "client_id": client_id,
                    "code_verifier": verifier,
                    "resource": mcp_resource,
                },
            )
            assert exchange.status_code == 200, f"the code exchange answered {exchange.status_code}."

            refreshed = refresh(session)
            assert refreshed.status_code == 200, (
                f"the refresh token no longer refreshes after authorize and consent read it "
                f"({refreshed.status_code}), so the lookup was not read only."
            )
            cookie = "; ".join(f"{name}={value}" for name, value in refreshed.cookies.items()) or cookie
        finally:
            anon.post("/api/auth/logout", json={}, headers={"cookie": cookie})


def _mint_token(anon: Any, api: Any, resource: str, workspace_id: str) -> str:
    """An MCP access token for the run-owned workspace, through register, consent and exchange.

    The workspace this run created is chosen when the consent screen offers it, so a
    destructive tool never runs in a tenant the run does not own.
    """
    verifier, challenge = _pkce_pair()
    client_id = _register(anon)
    state = secrets.token_urlsafe(16)
    authorize = api.get("/api/auth/authorize", params=_authorize_params(client_id, resource, challenge, state))
    assert authorize.status_code == 200, f"/authorize answered {authorize.status_code}: {authorize.text[:400]}"
    tenant_id = workspace_id if workspace_id in authorize.text else _first_tenant(authorize.text)
    assert tenant_id == workspace_id, f"consent did not offer the run-owned workspace {workspace_id}."
    consent = api.post(
        "/api/auth/authorize/consent",
        data={**_hidden_fields(authorize.text), "decision": "allow", "tenant_id": tenant_id},
    )
    assert consent.status_code == 303, f"the consent post answered {consent.status_code}: {consent.text[:400]}"
    redirected = parse_qs(urlsplit(consent.headers["location"]).query)
    assert "error" not in redirected, f"consent redirected with {redirected.get('error')}."
    exchange = anon.post(
        "/api/auth/token",
        data={
            "grant_type": "authorization_code",
            "code": redirected["code"][0],
            "redirect_uri": REDIRECT_URI,
            "client_id": client_id,
            "code_verifier": verifier,
            "resource": resource,
        },
    )
    assert exchange.status_code == 200, f"the code exchange answered {exchange.status_code}: {exchange.text[:400]}"
    return str(exchange.json()["access_token"])


class TestMcpDeleteTeam:
    """The one irreversible team tool, driven against a team this run creates for it."""

    @WRITES
    def test_delete_team_removes_a_team_the_run_created(
        self,
        anon: Any,
        api: Any,
        mcp_resource: str,
        mcp_workspace: "dict[str, Any]",
    ) -> None:
        """Create a team through MCP, delete it, and see it gone from every team read.

        The team is created here rather than taken from the listing, so the delete can
        only ever remove something this case made, and the workspace teardown catches it
        if an assertion fails before the delete.
        """
        token = _mint_token(anon, api, mcp_resource, str(mcp_workspace["id"]))
        prefix = "D" + "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ") for _ in range(4))
        created = _tool(api, token, 1, "create_team", {"name": f"E2E delete {prefix}", "key_prefix": prefix})

        deleted = _tool(api, token, 2, "delete_team", {"team_id": prefix})
        assert deleted == {
            "deleted": True,
            "team_id": created["team_id"],
            "name": created["name"],
            "key_prefix": prefix,
        }, f"delete_team answered {deleted}."

        listed = _tool(api, token, 3, "list_teams", {})
        assert created["team_id"] not in {row["team_id"] for row in listed["teams"]}, (
            "list_teams still shows the team delete_team just removed."
        )
        again = _rpc(api, token, "tools/call", 4, {"name": "get_team", "arguments": {"team_id": created["team_id"]}})
        assert again["result"]["isError"] is True, "get_team still reads the deleted team."
