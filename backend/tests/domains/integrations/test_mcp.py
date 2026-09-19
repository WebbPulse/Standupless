"""The MCP endpoint: the challenge handshake, the dispatch table, and scope refusals.

The property under test throughout is that MCP is not a second authorization
system. A tool reaches exactly what its credential would reach over HTTP, so the
tests seed two projects and check that a key bound to one never sees the other,
and that a scope the key does not carry refuses before any table is read.

The unauthenticated path matters as much as the authorized one. A client with no
token must receive the `WWW-Authenticate` challenge rather than a bare 401, because
that header is the whole discovery handshake.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from fastapi.testclient import TestClient

from app.common.db.dynamo.api_keys import API_KEY_SCOPES
from app.domains.integrations.mcp.tools import TOOLS
from app.domains.integrations.mcp.transport import INSUFFICIENT_SCOPE, METHOD_NOT_FOUND, PROTOCOL_VERSION
from tests.domains.helpers import GUEST, MEMBER, OWNER
from tests.domains.integrations.conftest import OTHER_PROJECT, PROJECT, WORKSPACE


def mint(repositories: Any, user_id: str, scopes: tuple[str, ...]) -> str:
    """One API key row, returning the plaintext an MCP client would present."""
    from webbpulse.identity.api_keys import display_prefix, hash_key, new_key

    from app.common.db.dynamo.api_keys import ApiKey, new_key_id

    secret = new_key()
    repositories.api_keys.create(
        ApiKey(
            workspace_id=WORKSPACE,
            key_id=new_key_id(),
            key_hash=hash_key(secret),
            prefix=display_prefix(secret),
            name="An MCP key",
            scopes=list(scopes),
            user_id=user_id,
            created_by=OWNER,
        )
    )
    return secret


def call(client: TestClient, secret: Optional[str], method: str, params: Any = None, request_id: Any = 1) -> Any:
    """One JSON-RPC request, with or without a bearer."""
    payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
    if request_id is not None:
        payload["id"] = request_id
    if params is not None:
        payload["params"] = params
    headers = {"authorization": f"Bearer {secret}"} if secret else {}
    return client.post("/api/mcp", json=payload, headers=headers)


def tool(client: TestClient, secret: str, name: str, arguments: Any = None) -> Any:
    """One `tools/call`, which is how every tool is exercised."""
    return call(client, secret, "tools/call", {"name": name, "arguments": arguments or {}})


def test_an_unauthenticated_post_is_challenged(client: TestClient, workspace: str) -> None:
    """A caller with no bearer gets the discovery challenge, not a bare refusal."""
    response = call(client, None, "initialize")

    assert response.status_code == 401
    assert "resource_metadata=" in response.headers["www-authenticate"]


def test_a_get_is_refused_but_still_challenges(client: TestClient, workspace: str) -> None:
    """There is no stream to open, and the challenge still starts discovery from a GET."""
    response = client.get("/api/mcp")

    assert response.status_code == 405
    assert "resource_metadata=" in response.headers["www-authenticate"]


def test_an_unknown_bearer_is_challenged(client: TestClient, workspace: str) -> None:
    """A forged key authenticates as nobody, and cannot be told from an absent one."""
    response = call(client, "wpk_notarealkeyatallnotreal", "initialize")

    assert response.status_code == 401


def test_a_session_cannot_drive_tools(client: TestClient, workspace: str) -> None:
    """A browser session carries no tenant claim, so it is refused here.

    Without this the endpoint would be a way for a cookie to reach tools while
    bypassing the scope system entirely.
    """
    from tests.domains.helpers import sign_in

    sign_in(client, MEMBER)
    response = call(client, None, "initialize")

    assert response.status_code == 401


def test_initialize_advertises_tools_only(client: TestClient, workspace: str, repositories: Any) -> None:
    """The handshake names the protocol version and offers tools and nothing else."""
    secret = mint(repositories, MEMBER, API_KEY_SCOPES)

    body = call(client, secret, "initialize").json()

    assert body["result"]["protocolVersion"] == PROTOCOL_VERSION
    assert set(body["result"]["capabilities"]) == {"tools"}


def test_tools_list_matches_the_tool_table(client: TestClient, workspace: str, repositories: Any) -> None:
    """Every declared tool is advertised, so the table and the wire cannot drift."""
    secret = mint(repositories, MEMBER, API_KEY_SCOPES)

    body = call(client, secret, "tools/list").json()

    assert {row["name"] for row in body["result"]["tools"]} == {row.name for row in TOOLS}


def test_the_contract_fixes_eight_tools() -> None:
    """The contract names eight, so adding a ninth is a deliberate edit."""
    assert len(TOOLS) == 8


def test_a_notification_gets_no_body(client: TestClient, workspace: str, repositories: Any) -> None:
    """A message with no id is answered with 202 and nothing else."""
    secret = mint(repositories, MEMBER, API_KEY_SCOPES)

    response = call(client, secret, "ping", request_id=None)

    assert response.status_code == 202
    assert not response.content


def test_an_unknown_method_is_a_protocol_error(client: TestClient, workspace: str, repositories: Any) -> None:
    """An unknown method answers a JSON-RPC error rather than an HTTP one."""
    secret = mint(repositories, MEMBER, API_KEY_SCOPES)

    body = call(client, secret, "resources/list").json()

    assert body["error"]["code"] == METHOD_NOT_FOUND


def test_invalid_json_is_a_parse_error(client: TestClient, workspace: str, repositories: Any) -> None:
    """A malformed body answers a parse error, not a 500."""
    secret = mint(repositories, MEMBER, API_KEY_SCOPES)

    response = client.post(
        "/api/mcp",
        content=b"{not json",
        headers={"authorization": f"Bearer {secret}", "content-type": "application/json"},
    )

    assert response.status_code == 200
    assert response.json()["error"]["code"] == -32700


def test_a_missing_scope_refuses_before_the_tool_runs(client: TestClient, workspace: str, repositories: Any) -> None:
    """A read-only key cannot create, and is told so as a protocol error.

    A protocol error rather than an error result, because no retry of the same call
    can succeed: the credential itself is too narrow.
    """
    secret = mint(repositories, MEMBER, ("issues:read",))

    body = tool(client, secret, "create_issue", {"project_id": PROJECT, "title": "Nope"}).json()

    assert body["error"]["code"] == INSUFFICIENT_SCOPE
    assert "issues:write" in str(body["error"])


def test_a_granted_scope_runs_the_tool(client: TestClient, workspace: str, repositories: Any) -> None:
    """A key carrying `issues:write` creates an issue through the same path HTTP uses."""
    secret = mint(repositories, MEMBER, ("issues:write", "issues:read"))

    body = tool(client, secret, "create_issue", {"project_id": PROJECT, "title": "From a tool"}).json()

    assert "error" not in body, body
    assert body["result"]["isError"] is False
    assert "From a tool" in body["result"]["content"][0]["text"]


def test_a_tool_reaches_only_what_the_credential_can_see(
    client: TestClient, workspace: str, repositories: Any, hidden_issue: Any
) -> None:
    """A guest's key sees their project and not the one they are outside of.

    This is the milestone's central claim in its sharpest form: the tool runs the
    same visibility check the HTTP route does, so a credential cannot reach further
    through MCP than it could through the API.
    """
    from tests.domains.helpers import add_project_member

    add_project_member(repositories, WORKSPACE, PROJECT, GUEST, "member")
    secret = mint(repositories, GUEST, ("projects:read",))

    body = tool(client, secret, "list_projects").json()

    text = body["result"]["content"][0]["text"]
    assert PROJECT in text
    assert OTHER_PROJECT not in text


def test_a_read_only_project_membership_cannot_write_through_a_tool(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A guest who may read a project but not write in it is refused by MCP too.

    The scope says what kind of write the credential carries; the membership says
    whether its holder may write here at all. Without the second check the
    transport would decide what a person can do, and a guest refused over HTTP
    would succeed over MCP.
    """
    from tests.domains.helpers import add_project_member

    add_project_member(repositories, WORKSPACE, PROJECT, GUEST, "viewer")
    secret = mint(repositories, GUEST, ("issues:write", "issues:read"))

    body = tool(client, secret, "create_issue", {"project_id": PROJECT, "title": "Not allowed"}).json()

    assert body["result"]["isError"] is True
    assert "may not write" in body["result"]["content"][0]["text"]


def test_a_tool_write_records_its_activity_row(client: TestClient, workspace: str, repositories: Any) -> None:
    """Creating an issue through a tool leaves the same history a person's create does.

    The row is what makes an agent's change visible in the feed, and it carries the
    actor kind so it does not read as its owner sitting at the product.
    """
    secret = mint(repositories, MEMBER, ("issues:write", "issues:read"))

    body = tool(client, secret, "create_issue", {"project_id": PROJECT, "title": "With history"}).json()
    assert "error" not in body, body

    issue_id = json.loads(body["result"]["content"][0]["text"])["issue_id"]
    rows = repositories.activity.list_for_issue(WORKSPACE, issue_id).items

    assert [row["kind"] for row in rows] == ["created"]
    assert rows[0]["actor_kind"] == "api_key"


def test_an_unknown_tool_is_a_protocol_error(client: TestClient, workspace: str, repositories: Any) -> None:
    """A tool that does not exist is refused by name."""
    secret = mint(repositories, MEMBER, API_KEY_SCOPES)

    body = tool(client, secret, "delete_everything").json()

    assert body["error"]["code"] == METHOD_NOT_FOUND


def test_a_revoked_key_stops_working(client: TestClient, workspace: str, repositories: Any) -> None:
    """Revocation closes the MCP session on the next request."""
    secret = mint(repositories, MEMBER, API_KEY_SCOPES)
    assert call(client, secret, "initialize").status_code == 200

    row = repositories.api_keys.list_for_workspace(WORKSPACE)[0]
    repositories.api_keys.revoke(WORKSPACE, row.key_id)

    assert call(client, secret, "initialize").status_code == 401


def test_delete_ends_a_session_cleanly(client: TestClient, workspace: str, repositories: Any) -> None:
    """A clean disconnect answers 204 rather than looking like a failure."""
    secret = mint(repositories, MEMBER, API_KEY_SCOPES)

    response = client.delete("/api/mcp", headers={"authorization": f"Bearer {secret}"})

    assert response.status_code == 204
