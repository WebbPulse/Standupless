"""The MCP endpoint: the challenge handshake, the dispatch table, and scope refusals.

The property under test throughout is that MCP is not a second authorization
system. A tool reaches exactly what its credential would reach over HTTP, so the
tests seed two teams and check that a key bound to one never sees the other,
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
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM, WORKSPACE


def mint(repositories: Any, user_id: str, scopes: tuple[str, ...]) -> str:
    """One API key, returning the plaintext an MCP client would present."""
    from webbpulse.identity.api_keys import mint as mint_key

    return mint_key(
        user_id=user_id,
        tenant_id=WORKSPACE,
        scopes=scopes,
        name="An MCP key",
        store=repositories.api_keys,
        created_by=OWNER,
    ).plaintext


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


def test_the_contract_fixes_the_tool_set() -> None:
    """The contract names every tool, so adding or dropping one is a deliberate edit."""
    assert {row.name for row in TOOLS} == {
        "add_comment",
        "add_issues_to_cycle",
        "add_team_member",
        "archive_issue",
        "assign_issue",
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
        "list_audit_events",
        "list_invites",
        "list_issue_activity",
        "list_issue_relations",
        "list_issue_subscribers",
        "list_issues",
        "list_labels",
        "list_my_issues",
        "list_my_reviews",
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
        "backfill_releases",
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
        "list_approved_domains",
        "add_approved_domain",
        "remove_approved_domain",
    }
    assert len(TOOLS) == 146


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

    body = tool(client, secret, "create_issue", {"team_id": TEAM, "title": "Nope"}).json()

    assert body["error"]["code"] == INSUFFICIENT_SCOPE
    assert "issues:write" in str(body["error"])


def test_a_granted_scope_runs_the_tool(client: TestClient, workspace: str, repositories: Any) -> None:
    """A key carrying `issues:write` creates an issue through the same path HTTP uses."""
    secret = mint(repositories, MEMBER, ("issues:write", "issues:read"))

    body = tool(client, secret, "create_issue", {"team_id": TEAM, "title": "From a tool"}).json()

    assert "error" not in body, body
    assert body["result"]["isError"] is False
    assert "From a tool" in body["result"]["content"][0]["text"]


def test_a_tool_reaches_only_what_the_credential_can_see(
    client: TestClient, workspace: str, repositories: Any, hidden_issue: Any
) -> None:
    """A guest's key sees their team and not the one they are outside of.

    This is the project's central claim in its sharpest form: the tool runs the
    same visibility check the HTTP route does, so a credential cannot reach further
    through MCP than it could through the API.
    """
    from tests.domains.helpers import add_team_member

    add_team_member(repositories, WORKSPACE, TEAM, GUEST, "member")
    secret = mint(repositories, GUEST, ("teams:read",))

    body = tool(client, secret, "list_teams").json()

    text = body["result"]["content"][0]["text"]
    assert TEAM in text
    assert OTHER_TEAM not in text


def test_a_read_only_team_membership_cannot_write_through_a_tool(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A guest who may read a team but not write in it is refused by MCP too.

    The scope says what kind of write the credential carries; the membership says
    whether its holder may write here at all. Without the second check the
    transport would decide what a person can do, and a guest refused over HTTP
    would succeed over MCP.
    """
    from tests.domains.helpers import add_team_member

    add_team_member(repositories, WORKSPACE, TEAM, GUEST, "viewer")
    secret = mint(repositories, GUEST, ("issues:write", "issues:read"))

    body = tool(client, secret, "create_issue", {"team_id": TEAM, "title": "Not allowed"}).json()

    assert body["result"]["isError"] is True
    assert "may not write" in body["result"]["content"][0]["text"]


def test_a_tool_write_records_its_activity_row(client: TestClient, workspace: str, repositories: Any) -> None:
    """Creating an issue through a tool leaves the same history a person's create does.

    The row is what makes an agent's change visible in the feed. It is the row the
    create route writes, actor kind included, so the activity read can render it:
    an MCP-only kind or actor kind would fail that read's schema.
    """
    from app.common.api.schemas.issues import ActivityRead
    from app.common.db.dynamo.activity import as_activity

    secret = mint(repositories, MEMBER, ("issues:write", "issues:read"))

    body = tool(client, secret, "create_issue", {"team_id": TEAM, "title": "With history"}).json()
    assert "error" not in body, body

    issue_id = json.loads(body["result"]["content"][0]["text"])["issue_id"]
    rows = repositories.activity.list_for_issue(WORKSPACE, issue_id).items

    assert [row["kind"] for row in rows] == ["created"]
    assert rows[0]["actor_kind"] == "user"
    assert ActivityRead.from_row(as_activity(rows[0])).kind == "created"


def test_an_unknown_tool_is_a_protocol_error(client: TestClient, workspace: str, repositories: Any) -> None:
    """A tool that does not exist is refused by name."""
    secret = mint(repositories, MEMBER, API_KEY_SCOPES)

    body = tool(client, secret, "delete_everything").json()

    assert body["error"]["code"] == METHOD_NOT_FOUND


def test_a_revoked_key_stops_working(client: TestClient, workspace: str, repositories: Any) -> None:
    """Revocation closes the MCP session on the next request."""
    secret = mint(repositories, MEMBER, API_KEY_SCOPES)
    assert call(client, secret, "initialize").status_code == 200

    row = repositories.api_keys.list_for_tenant(WORKSPACE)[0]
    repositories.api_keys.revoke_by_id(WORKSPACE, row.key_id)

    assert call(client, secret, "initialize").status_code == 401


def test_delete_ends_a_session_cleanly(client: TestClient, workspace: str, repositories: Any) -> None:
    """A clean disconnect answers 204 rather than looking like a failure."""
    secret = mint(repositories, MEMBER, API_KEY_SCOPES)

    response = client.delete("/api/mcp", headers={"authorization": f"Bearer {secret}"})

    assert response.status_code == 204


def test_every_tool_declares_known_scopes() -> None:
    """Each tool names at least one scope and only scopes a key or grant can carry."""
    for row in TOOLS:
        assert row.scopes, row.name
        assert set(row.scopes) <= set(API_KEY_SCOPES), row.name


def test_no_destructive_tool_claims_to_be_read_only() -> None:
    """A destructive tool is never read-only, and a read-only tool is never destructive."""
    for row in TOOLS:
        assert not (row.destructive and row.read_only), row.name
