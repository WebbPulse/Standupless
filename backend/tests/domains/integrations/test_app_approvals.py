"""The admin approval routes for third-party OAuth apps: requests, decisions and who hears about them.

The consent gate that sends a member here lives in identity and is tested there.
These tests start from the ticket it mints, so they exercise the request page and
the decisions exactly as the stopped member and the admin reach them.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.audit import AuditQuery

from app.common.app_approvals import mint_request_ticket
from tests.domains.helpers import ADMIN, MEMBER, OWNER, sign_in
from tests.domains.integrations.conftest import OTHER_WORKSPACE, WORKSPACE

CLIENT_ID = "third-party-client"

RESUME = "https://api.example.test/authorize?client_id=third-party-client"


@pytest.fixture
def recorder() -> Iterator[Any]:
    """A recording sender installed as the process-wide one for one test."""
    from webbpulse.identity.email import RecordingEmailSender

    from app.common.email import reset_email_sender

    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


@pytest.fixture
def enabled(repositories: Any, workspace: str) -> str:
    """The shared workspace with admin approval for third-party apps turned on."""
    repositories.workspaces.set_third_party_app_approvals(workspace, True)
    return workspace


def ticket(workspace_id: str = WORKSPACE) -> str:
    """A request ticket like the one the consent gate mints for the test app."""
    return mint_request_ticket(workspace_id, CLIENT_ID, "Acme Sync", RESUME)


def request_access(client: TestClient, reason: str = "For syncing") -> Any:
    """Send the stopped member's request for the test app."""
    return client.post(
        f"/api/workspaces/{WORKSPACE}/app-approvals/requests", json={"ticket": ticket(), "reason": reason}
    )


def decide(client: TestClient, action: str, reason: str = "") -> Any:
    """An admin decision on the test app."""
    return client.post(f"/api/workspaces/{WORKSPACE}/app-approvals/{CLIENT_ID}/{action}", json={"reason": reason})


def kinds(repositories: Any, user_id: str) -> list[str]:
    """The kinds of every notification a member holds in the workspace."""
    return [row["kind"] for row in repositories.inbox.list(WORKSPACE, user_id).items]


def actions(repositories: Any) -> list[str]:
    """Every app approval action the workspace audit log holds."""
    events = repositories.audit.list_events(WORKSPACE, AuditQuery()).events
    return [event.action for event in events if event.action.startswith("app_approval.")]


def test_the_request_page_names_the_app_from_the_ticket(client: TestClient, enabled: str) -> None:
    """A member reads the app, the workspace and where to resume without any record existing yet."""
    sign_in(client, MEMBER)

    response = client.get(f"/api/workspaces/{WORKSPACE}/app-approvals/request", params={"ticket": ticket()})

    assert response.status_code == 200
    body = response.json()
    assert body["client_id"] == CLIENT_ID
    assert body["client_name"] == "Acme Sync"
    assert body["return_to"] == RESUME
    assert body["enabled"] is True
    assert body["approval"] is None


def test_a_bad_or_foreign_ticket_is_a_404(client: TestClient, enabled: str) -> None:
    """A forged ticket and one minted for another workspace are refused alike."""
    sign_in(client, MEMBER)
    url = f"/api/workspaces/{WORKSPACE}/app-approvals/request"

    assert client.get(url, params={"ticket": "not-a-ticket"}).status_code == 404
    assert client.get(url, params={"ticket": ticket(OTHER_WORKSPACE)}).status_code == 404


def test_a_request_is_pending_audited_and_reaches_every_admin(
    client: TestClient, enabled: str, repositories: Any, recorder: Any
) -> None:
    """The record moves to pending under the member, and owners and admins hear about it."""
    sign_in(client, MEMBER)

    response = request_access(client)

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "pending"
    assert body["request_reason"] == "For syncing"
    assert body["requested_by"]["id"] == MEMBER
    assert "app_approval_requested" in kinds(repositories, OWNER)
    assert "app_approval_requested" in kinds(repositories, ADMIN)
    assert "app_approval_requested" not in kinds(repositories, MEMBER)
    assert sorted(message.to for message in recorder.sent) == ["admin@example.com", "owner@example.com"]
    assert actions(repositories) == ["app_approval.requested"]


def test_asking_again_while_pending_does_not_notify_twice(client: TestClient, enabled: str, repositories: Any) -> None:
    """A second request from the same member updates the reason without a second notice."""
    sign_in(client, MEMBER)
    request_access(client)
    request_access(client, "Still needed")

    assert kinds(repositories, ADMIN).count("app_approval_requested") == 1
    row = repositories.memberships.get_app_approval(WORKSPACE, CLIENT_ID)
    assert row.request_reason == "Still needed"


def test_only_an_admin_lists_and_decides(client: TestClient, enabled: str) -> None:
    """A member can ask but cannot read the list or approve their own request."""
    sign_in(client, MEMBER)
    request_access(client)

    assert client.get(f"/api/workspaces/{WORKSPACE}/app-approvals").status_code == 403
    assert decide(client, "approve").status_code == 403


def test_an_admin_lists_by_status(client: TestClient, enabled: str) -> None:
    """The list carries the switch and filters to one status when asked."""
    sign_in(client, MEMBER)
    request_access(client)
    sign_in(client, ADMIN)

    listed = client.get(f"/api/workspaces/{WORKSPACE}/app-approvals").json()
    pending = client.get(f"/api/workspaces/{WORKSPACE}/app-approvals", params={"status": "pending"}).json()
    approved = client.get(f"/api/workspaces/{WORKSPACE}/app-approvals", params={"status": "approved"}).json()

    assert listed["enabled"] is True
    assert [row["client_id"] for row in listed["approvals"]] == [CLIENT_ID]
    assert [row["client_id"] for row in pending["approvals"]] == [CLIENT_ID]
    assert approved["approvals"] == []


def test_approving_tells_the_requester(client: TestClient, enabled: str, repositories: Any, recorder: Any) -> None:
    """The record is approved under the admin, audited, and the member is told."""
    sign_in(client, MEMBER)
    request_access(client)
    recorder.sent.clear()
    sign_in(client, ADMIN)

    response = decide(client, "approve")

    assert response.status_code == 200
    assert response.json()["status"] == "approved"
    assert response.json()["decided_by"]["id"] == ADMIN
    assert "app_approval_decided" in kinds(repositories, MEMBER)
    assert [message.to for message in recorder.sent] == ["member@example.com"]
    assert "app_approval.approved" in actions(repositories)


def test_a_denial_keeps_its_reason_for_the_next_request(client: TestClient, enabled: str, repositories: Any) -> None:
    """The member sees why they were denied and may ask again, which goes back to pending."""
    sign_in(client, MEMBER)
    request_access(client)
    sign_in(client, ADMIN)
    denied = decide(client, "deny", "Not reviewed yet")
    assert denied.json()["status"] == "denied"
    assert denied.json()["decision_reason"] == "Not reviewed yet"

    sign_in(client, MEMBER)
    page = client.get(f"/api/workspaces/{WORKSPACE}/app-approvals/request", params={"ticket": ticket()}).json()
    assert page["approval"]["status"] == "denied"
    assert page["approval"]["decision_reason"] == "Not reviewed yet"

    again = request_access(client, "Reviewed now")
    assert again.json()["status"] == "pending"
    assert again.json()["decision_reason"] == "Not reviewed yet"


def test_revoking_an_app_without_a_record_needs_its_name(client: TestClient, enabled: str, repositories: Any) -> None:
    """An app authorized before approvals were on can be revoked, which records it denied."""
    sign_in(client, ADMIN)

    missing = decide(client, "revoke")
    named = client.post(
        f"/api/workspaces/{WORKSPACE}/app-approvals/{CLIENT_ID}/revoke",
        json={"reason": "", "client_name": "Acme Sync"},
    )

    assert missing.status_code == 404
    assert named.status_code == 200
    assert named.json()["status"] == "denied"
    assert repositories.memberships.get_app_approval(WORKSPACE, CLIENT_ID).client_name == "Acme Sync"
    assert actions(repositories) == ["app_approval.revoked"]


def test_an_api_key_is_refused(client: TestClient, enabled: str) -> None:
    """A delegated credential neither asks for an app nor decides on one."""
    sign_in(client, OWNER, actor="api_key", workspace_id=WORKSPACE)

    assert request_access(client).status_code in (401, 403)
    assert client.get(f"/api/workspaces/{WORKSPACE}/app-approvals").status_code in (401, 403)
    assert decide(client, "approve").status_code in (401, 403)
