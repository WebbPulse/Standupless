"""Integration routes that send a team's content out hold the private team rule.

A workspace owner or admin outside a private team still administers its settings,
but pointing a webhook, a channel or a GitHub repository at it would publish issues
they cannot read, so each of those writes is a 403 until they join the team.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, add_team_member, sign_in
from tests.domains.integrations.conftest import REPOSITORY_ID, TEAM, WORKSPACE
from tests.domains.integrations.test_channels import SLACK_URL, make_channel
from tests.domains.integrations.test_webhook_delivery import make_endpoint

WEBHOOKS = f"/api/workspaces/{WORKSPACE}/webhooks"

TEAM_WEBHOOKS = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/webhooks"

CHANNELS = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/webhooks/channels"

SYNC = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/github-sync"

REPOSITORY = f"/api/workspaces/{WORKSPACE}/github/repositories/{REPOSITORY_ID}"

HOOK = {"url": "https://example.test/hook", "label": "Receiver", "resource_types": ["issues"]}


@pytest.fixture
def private_team(repositories: Any, workspace: str, public_dns: None) -> str:
    """`TEAM` made private, with the workspace admin outside it."""
    repositories.memberships.set_team_private(WORKSPACE, TEAM, True)
    return TEAM


def refused(response: Any) -> None:
    """Hold that a response is the private team 403."""
    assert response.status_code == 403, response.text
    assert response.json()["detail"]["error_code"] == "PRIVATE_TEAM"


def test_an_outside_admin_cannot_add_a_webhook_to_a_private_team(client: TestClient, private_team: str) -> None:
    """Neither the team route nor a workspace webhook scoped to the team is accepted."""
    sign_in(client, ADMIN)

    refused(client.post(TEAM_WEBHOOKS, json=HOOK))
    refused(client.post(WEBHOOKS, json={**HOOK, "team_id": TEAM}))
    assert client.post(WEBHOOKS, json=HOOK).status_code == 201


def test_an_outside_admin_cannot_point_or_reenable_a_webhook_on_a_private_team(
    client: TestClient, repositories: Any, private_team: str
) -> None:
    """Moving a workspace webhook onto the team or turning the team's one on is refused; turning it off is not."""
    wide = make_endpoint(repositories)
    scoped = make_endpoint(repositories, team_id=TEAM, active=False)
    sign_in(client, ADMIN)

    refused(client.patch(f"{WEBHOOKS}/{wide.webhook_id}", json={"team_id": TEAM}))
    refused(client.patch(f"{TEAM_WEBHOOKS}/{scoped.webhook_id}", json={"enabled": True}))
    assert client.patch(f"{TEAM_WEBHOOKS}/{scoped.webhook_id}", json={"enabled": False}).status_code == 200


def test_a_member_admin_still_adds_a_webhook_to_a_private_team(
    client: TestClient, repositories: Any, private_team: str
) -> None:
    """Joining the team is all it takes."""
    add_team_member(repositories, WORKSPACE, TEAM, ADMIN, "member")
    sign_in(client, ADMIN)

    assert client.post(TEAM_WEBHOOKS, json=HOOK).status_code == 201


def test_an_outside_admin_cannot_add_or_reenable_a_channel_on_a_private_team(
    client: TestClient, repositories: Any, private_team: str, github_env: None
) -> None:
    """Adding a Slack channel or changing one other than turning it off is refused."""
    channel = make_channel(repositories, enabled=False)
    sign_in(client, ADMIN)

    refused(client.post(CHANNELS, json={"url": SLACK_URL, "events": ["issue_created"]}))
    refused(client.patch(f"{CHANNELS}/{channel.channel_id}", json={"enabled": True}))
    assert client.patch(f"{CHANNELS}/{channel.channel_id}", json={"enabled": False}).status_code == 200


def test_an_outside_admin_cannot_link_a_repository_or_sync_a_private_team(
    client: TestClient, installed: str, private_team: str
) -> None:
    """Pinning a repository to the team and turning on two way sync are both refused."""
    sign_in(client, ADMIN)

    refused(client.patch(REPOSITORY, json={"team_id": TEAM}))
    refused(client.put(SYNC, json={"repository_id": REPOSITORY_ID, "direction": "two_way"}))
