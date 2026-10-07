"""Which client a change came through, as history records and filters it.

The source is read off the verified credential, so a browser session, an API key
and an OAuth client each land their own label, and a body field naming another
source changes nothing. Rows written before sources existed still read.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.activity import build_activity
from tests.domains.helpers import OWNER, sign_in
from tests.domains.issues.conftest import create_issue

KEY_SCOPES = "issues:read issues:write"


def activity(client: TestClient, workspace: str, issue_id: str, **params: Any) -> list[dict[str, Any]]:
    """The issue's history, newest first, as the route answers it."""
    response = client.get(f"/api/workspaces/{workspace}/issues/{issue_id}/activity", params=params)
    assert response.status_code == 200, response.text
    return response.json()["activity"]


def sign_in_with_key(client: TestClient, workspace: str) -> None:
    """Arrive as the owner holding an API key, in the shape `claims_for_key` stamps."""
    sign_in(client, OWNER, actor_kind="api_key", tenant_id=workspace, scope=KEY_SCOPES)


def test_a_browser_change_is_recorded_as_web(client: TestClient, workspace: str, statuses: Any) -> None:
    """A signed in session is the web source, which the UI leaves unlabelled."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)
    client.patch(f"/api/workspaces/{workspace}/issues/{issue['id']}", json={"title": "Renamed"})

    assert {row["source"] for row in activity(client, workspace, issue["id"])} == {"web"}


def test_an_api_key_change_is_recorded_as_api(client: TestClient, workspace: str, statuses: Any) -> None:
    """A change made with a personal API key says it came through the API."""
    sign_in_with_key(client, workspace)
    issue = create_issue(client, workspace)
    response = client.patch(f"/api/workspaces/{workspace}/issues/{issue['id']}", json={"priority": "high"})
    assert response.status_code == 200, response.text

    rows = activity(client, workspace, issue["id"])
    assert {row["source"] for row in rows} == {"api"}


def test_a_cli_change_is_recorded_as_cli(client: TestClient, workspace: str, statuses: Any) -> None:
    """A personal API key sent by the CLI says it came through the CLI."""
    sign_in_with_key(client, workspace)
    client.headers["User-Agent"] = "standupless-cli/0.1.0"
    issue = create_issue(client, workspace)

    assert [row["source"] for row in activity(client, workspace, issue["id"])] == ["cli"]


def test_an_oauth_client_change_is_recorded_as_mcp(client: TestClient, workspace: str, statuses: Any) -> None:
    """A token minted for an OAuth client is an MCP client's credential."""
    sign_in(client, OWNER, tenant_id=workspace, scope=KEY_SCOPES, client_id="mcp-client")
    issue = create_issue(client, workspace)

    assert [row["source"] for row in activity(client, workspace, issue["id"])] == ["mcp"]


def test_a_request_field_cannot_claim_a_source(client: TestClient, workspace: str, statuses: Any) -> None:
    """A body naming another source is ignored, because the credential decides."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, source="mcp")
    client.patch(
        f"/api/workspaces/{workspace}/issues/{issue['id']}",
        json={"title": "Renamed", "source": "cli"},
    )

    assert {row["source"] for row in activity(client, workspace, issue["id"])} == {"web"}


def test_history_filters_on_the_source(client: TestClient, workspace: str, statuses: Any) -> None:
    """Asking for one source answers only the rows that came through it."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)
    sign_in_with_key(client, workspace)
    client.patch(f"/api/workspaces/{workspace}/issues/{issue['id']}", json={"title": "By key"})

    api_rows = activity(client, workspace, issue["id"], source="api")
    web_rows = activity(client, workspace, issue["id"], source="web")

    assert [row["kind"] for row in api_rows] == ["field_changed"]
    assert [row["kind"] for row in web_rows] == ["created"]


def test_an_unknown_source_filter_is_refused(client: TestClient, workspace: str, statuses: Any) -> None:
    """The filter takes only the known sources."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)

    response = client.get(f"/api/workspaces/{workspace}/issues/{issue['id']}/activity", params={"source": "fax"})

    assert response.status_code == 422


def test_a_row_written_before_sources_reads_unattributed(
    client: TestClient, workspace: str, statuses: Any, repositories: Any
) -> None:
    """A legacy row carries no source and renders exactly as it did."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)
    legacy = build_activity(
        workspace, issue["team_id"], issue["id"], OWNER, "field_changed", field="title", from_value="a", to_value="b"
    )
    repositories.activity.record(legacy)

    rows = activity(client, workspace, issue["id"])
    legacy_rows = [entry for entry in rows if entry["activity_id"] == legacy.activity_id]

    assert legacy_rows and legacy_rows[0]["source"] is None
