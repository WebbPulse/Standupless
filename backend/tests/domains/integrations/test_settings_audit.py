"""Integration settings in the workspace audit log.

Outgoing webhooks, team channels, GitHub sync, pull request transitions and pinned
repositories each leave an entry naming who changed what, on the routes and on the
MCP tools alike. A channel's entry carries the masked tail and never the URL, and
a webhook's carries its URL without the query string.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient
from webbpulse.audit import AuditEvent, AuditQuery

from app.domains.integrations.mcp.audit_tools import AUDIT_TOOLS
from tests.domains.helpers import ADMIN, OWNER, sign_in
from tests.domains.integrations.conftest import REPOSITORY_FULL_NAME, REPOSITORY_ID, TEAM, WORKSPACE

SLACK_URL = "https://hooks.slack.com/services/T0001/B0002/abcdEFGHijkl1234"

WEBHOOKS = f"/api/workspaces/{WORKSPACE}/webhooks"

CHANNELS = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/webhooks/channels"

SYNC = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/github-sync"

TRANSITIONS = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/github-transitions"

REPOSITORY = f"/api/workspaces/{WORKSPACE}/github/repositories/{REPOSITORY_ID}"


def logged(repositories: Any, action: str) -> list[AuditEvent]:
    """The workspace's audit entries of one kind, newest first."""
    return repositories.audit.list_events(WORKSPACE, AuditQuery(action=action)).events


def test_a_webhook_is_recorded_from_create_to_delete(client: TestClient, workspace: str, repositories: Any) -> None:
    """Each step names the admin, and an update keeps only what changed."""
    sign_in(client, ADMIN)
    created = client.post(
        WEBHOOKS,
        json={"url": "https://example.test/hook?token=abc", "label": "Receiver", "resource_types": ["issues"]},
    )
    assert created.status_code == 201, created.text
    webhook_id = created.json()["webhook_id"]
    assert client.patch(f"{WEBHOOKS}/{webhook_id}", json={"label": "Renamed"}).status_code == 200
    assert client.post(f"{WEBHOOKS}/{webhook_id}/rotate").status_code == 200
    assert client.delete(f"{WEBHOOKS}/{webhook_id}").status_code == 204

    [added] = logged(repositories, "webhook.created")
    [changed] = logged(repositories, "webhook.updated")
    [rotated] = logged(repositories, "webhook.secret_rotated")
    [deleted] = logged(repositories, "webhook.deleted")
    assert added.actor.id == ADMIN and added.target.id == webhook_id
    assert added.after is not None and added.after["url"] == "https://example.test/hook"
    assert "abc" not in json.dumps(dict(added.after))
    assert changed.before == {"label": "Receiver"} and changed.after == {"label": "Renamed"}
    assert rotated.target.id == webhook_id
    assert deleted.before is not None and deleted.before["label"] == "Renamed"


def test_a_channel_is_recorded_without_its_url(client: TestClient, workspace: str, repositories: Any) -> None:
    """Adding, changing and removing a channel each leave an entry holding only the masked tail."""
    sign_in(client, ADMIN)
    created = client.post(CHANNELS, json={"url": SLACK_URL, "label": "#eng", "events": ["issue_created"]})
    assert created.status_code == 201, created.text
    channel_id = created.json()["channel_id"]
    assert client.patch(f"{CHANNELS}/{channel_id}", json={"enabled": False}).status_code == 200
    assert client.patch(f"{CHANNELS}/{channel_id}", json={"label": "#eng"}).status_code == 200
    assert client.delete(f"{CHANNELS}/{channel_id}").status_code == 204

    [added] = logged(repositories, "channel.created")
    changes = logged(repositories, "channel.updated")
    [removed] = logged(repositories, "channel.deleted")
    assert added.actor.id == ADMIN and added.target.id == channel_id
    assert added.after is not None
    assert added.after["team_id"] == TEAM and added.after["destination"] == "hooks.slack.com/…1234"
    assert [(row.before, row.after) for row in changes] == [
        ({"team_id": TEAM, "enabled": True}, {"team_id": TEAM, "enabled": False})
    ]
    assert removed.before is not None and removed.before["enabled"] is False
    for row in (added, *changes, removed):
        assert "abcdEFGH" not in json.dumps([row.before, row.after], default=str)


def test_github_sync_settings_are_recorded(
    client: TestClient, workspace: str, repositories: Any, installed: str
) -> None:
    """Linking a team, changing one switch and unlinking each leave an entry on the team."""
    sign_in(client, ADMIN)
    body = {"repository_id": REPOSITORY_ID, "direction": "two_way", "enabled": False, "sync_labels": False}
    assert client.put(SYNC, json=body).status_code == 200
    assert client.put(SYNC, json={**body, "sync_labels": True}).status_code == 200
    assert client.put(SYNC, json={**body, "sync_labels": True}).status_code == 200
    assert client.delete(SYNC).status_code == 204

    saved = logged(repositories, "github.sync_updated")
    [linked] = [row for row in saved if row.before is None]
    [changed] = [row for row in saved if row.before is not None]
    [removed] = logged(repositories, "github.sync_removed")
    assert linked.target.id == TEAM and linked.before is None
    assert linked.after is not None and linked.after["repository"] == REPOSITORY_FULL_NAME
    assert changed.before == {"sync_labels": False} and changed.after == {"sync_labels": True}
    assert removed.actor.id == ADMIN and removed.before is not None and removed.before["sync_labels"] is True


def test_transition_rules_are_recorded_as_readable_lines(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Replacing the defaults names each rule's trigger, branch and status, before and after."""
    statuses = {row.category: row for row in repositories.team_config.list_statuses(WORKSPACE, TEAM)}
    done = statuses["completed"]
    sign_in(client, ADMIN)
    rules = [{"trigger": "pr_merged", "status_id": done.status_id, "branch_pattern": "main"}]
    assert client.put(TRANSITIONS, json={"rules": rules}).status_code == 200
    assert client.put(TRANSITIONS, json={"rules": rules}).status_code == 200

    [row] = logged(repositories, "github.transitions_changed")
    assert row.actor.id == ADMIN and row.target.id == TEAM
    assert row.before is not None and row.before["using_defaults"] is True
    assert row.after == {"rules": [f"pr_merged into main: {done.name}"], "using_defaults": False}


def test_pinning_and_unpinning_a_repository_are_recorded(
    client: TestClient, workspace: str, repositories: Any, installed: str
) -> None:
    """The entry targets the repository and names the team on each side."""
    sign_in(client, OWNER)
    assert client.patch(REPOSITORY, json={"team_id": TEAM}).status_code == 200
    assert client.patch(REPOSITORY, json={"team_id": TEAM}).status_code == 200
    assert client.patch(REPOSITORY, json={"team_id": None}).status_code == 200

    [pinned] = logged(repositories, "github.repository_pinned")
    [unpinned] = logged(repositories, "github.repository_unpinned")
    assert pinned.target.id == REPOSITORY_ID and pinned.target.label == REPOSITORY_FULL_NAME
    assert pinned.before == {"team_id": None, "team": None}
    assert pinned.after is not None and pinned.after["team_id"] == TEAM
    assert unpinned.after == {"team_id": None, "team": None}


def test_the_mcp_tool_describes_the_new_events() -> None:
    """The audit tool's description and event filter cover the integration settings."""
    [tool] = AUDIT_TOOLS
    events = tool.schema["properties"]["event"]["enum"]

    assert "share links" in tool.description and "GitHub" in tool.description
    for name in ("channel.created", "webhook.secret_rotated", "github.transitions_changed", "team_member.joined"):
        assert name in events
