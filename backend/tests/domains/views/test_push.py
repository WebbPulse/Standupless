"""Native push: registering a device, who gets an alert, and what the badge says.

No test reaches Apple. `sender_for` is replaced with a recorder, and the sender's own
request is tested on its own in `tests/common/test_push_senders.py`.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common import push as push_module
from app.common.db.dynamo.inbox import Notification, inbox_partition, instant
from app.common.db.dynamo.push_devices import MAX_DEVICES_PER_USER, device_id_for
from app.common.push import deliver_push, sync_push_badge
from app.common.push_senders import PushMessage, PushOutcome
from app.domains.views.consumers.notify import handle_record
from tests.domains.helpers import MEMBER, OWNER, sign_in
from tests.domains.views.conftest import seed_issue
from tests.domains.views.test_notify_email import assignment

TOKEN = "ab" * 32
OTHER_TOKEN = "cd" * 32


class RecordingSender:
    """Keeps each send, and answers whatever a test set."""

    def __init__(self) -> None:
        """Start empty, answering that each send worked."""
        self.sent: list[tuple[str, PushMessage]] = []
        self.outcome = PushOutcome.SENT

    def send(self, token: str, message: PushMessage) -> PushOutcome:
        """Record one message."""
        self.sent.append((token, message))
        return self.outcome


@pytest.fixture
def sender(monkeypatch: pytest.MonkeyPatch) -> RecordingSender:
    """Every message push would send, instead of sending it."""
    recording = RecordingSender()
    monkeypatch.setattr(push_module, "sender_for", lambda _platform: recording)
    return recording


def _register(repositories: Any, workspace: str, user_id: str = MEMBER, token: str = TOKEN) -> None:
    """Register one device straight in, so a fan out test needs no route call."""
    repositories.inbox.push_devices.register(user_id, "ios", token, workspace)


def _set_preferences(repositories: Any, user_id: str, **fields: Any) -> None:
    """Write fields onto a user's row, as the preferences route does."""
    repositories.users.update(user_id, **fields)


def _assign(issues_client: TestClient, repositories: Any, workspace: str) -> dict[str, Any]:
    """Assign an issue to the member through the notify consumer."""
    sign_in(issues_client, OWNER)
    issue: dict[str, Any] = seed_issue(issues_client, workspace, title="Ship push", assignee_id=MEMBER)
    handle_record(repositories, assignment(workspace, issue["id"]))
    return issue


def test_registering_keeps_each_workspace_on_one_device(client: TestClient, repositories: Any, workspace: str) -> None:
    """Opening the app again does not add a device, and the row names the token by hash only."""
    sign_in(client, MEMBER)
    for _ in range(2):
        response = client.post(f"/api/workspaces/{workspace}/inbox/devices", json={"platform": "ios", "token": TOKEN})
        assert response.status_code == 204

    [device] = repositories.inbox.push_devices.for_user(MEMBER)
    assert device.device_id == device_id_for(TOKEN)
    assert TOKEN not in device.device_id
    assert device.workspace_ids == [workspace]


def test_a_token_that_is_not_one_is_refused(client: TestClient, workspace: str) -> None:
    """The route only stores what could be a provider token."""
    sign_in(client, MEMBER)
    response = client.post(f"/api/workspaces/{workspace}/inbox/devices", json={"platform": "ios", "token": "nope"})
    assert response.status_code == 422
    response = client.post(f"/api/workspaces/{workspace}/inbox/devices", json={"platform": "web", "token": TOKEN})
    assert response.status_code == 422


def test_a_phone_that_changes_hands_leaves_the_earlier_person(
    repositories: Any, workspace: str, sender: RecordingSender
) -> None:
    """A sign-out that never reached the server cannot leave one person's alerts on the next one's phone."""
    _register(repositories, workspace, MEMBER)
    _register(repositories, workspace, OWNER)

    assert repositories.inbox.push_devices.for_user(MEMBER) == []
    assert len(repositories.inbox.push_devices.for_user(OWNER)) == 1


def test_unregistering_only_touches_the_callers_devices(client: TestClient, repositories: Any, workspace: str) -> None:
    """Naming another person's token removes nothing, and naming your own removes it."""
    _register(repositories, workspace, OWNER)
    _register(repositories, workspace, MEMBER, OTHER_TOKEN)
    sign_in(client, MEMBER)

    path = f"/api/workspaces/{workspace}/inbox/devices/unregister"
    assert client.post(path, json={"token": TOKEN}).status_code == 204
    assert len(repositories.inbox.push_devices.for_user(OWNER)) == 1

    assert client.post(path, json={"token": OTHER_TOKEN}).status_code == 204
    assert repositories.inbox.push_devices.for_user(MEMBER) == []


def test_signing_out_zeroes_the_badge(
    client: TestClient, repositories: Any, workspace: str, sender: RecordingSender
) -> None:
    """The icon should not keep counting a person who has left the phone."""
    _register(repositories, workspace)
    sign_in(client, MEMBER)

    client.post(f"/api/workspaces/{workspace}/inbox/devices/unregister", json={"token": TOKEN})

    [(token, message)] = sender.sent
    assert token == TOKEN
    assert message.badge == 0


def test_the_oldest_device_gives_way_at_the_limit(repositories: Any, workspace: str) -> None:
    """A person's devices stay bounded, which also bounds what one notification sends."""
    tokens = [f"{index:064x}" for index in range(MAX_DEVICES_PER_USER + 1)]
    for token in tokens:
        _register(repositories, workspace, MEMBER, token)

    devices = repositories.inbox.push_devices.for_user(MEMBER)
    assert len(devices) == MAX_DEVICES_PER_USER
    assert device_id_for(tokens[0]) not in {device.device_id for device in devices}


def test_a_new_row_alerts_with_the_badge_and_the_issue(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any, sender: RecordingSender
) -> None:
    """An assignment reaches the phone, counts in the badge and opens the issue when tapped."""
    _register(repositories, workspace)

    issue = _assign(issues_client, repositories, workspace)

    [(token, message)] = sender.sent
    assert token == TOKEN
    assert message.badge == 1
    assert message.alert is not None
    assert message.alert.path.endswith(f"/issues/{issue['key']}")
    assert message.alert.path.startswith("/w/")
    assert issue["key"] in message.alert.title


def test_nothing_is_sent_without_a_device(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any, sender: RecordingSender
) -> None:
    """Someone who never installed the app costs a read and no send."""
    _assign(issues_client, repositories, workspace)
    assert sender.sent == []


def test_the_push_switch_leaves_the_badge_moving(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any, sender: RecordingSender
) -> None:
    """Turning a kind's push off stops the alert, while the row it wrote still counts."""
    _register(repositories, workspace)
    _set_preferences(repositories, MEMBER, notification_preferences={"assigned": {"push": False}})

    _assign(issues_client, repositories, workspace)

    [(_, message)] = sender.sent
    assert message.alert is None
    assert message.badge == 1


def test_a_pause_holds_the_alert_but_not_the_badge(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any, sender: RecordingSender
) -> None:
    """While notifications are paused nothing shows, and the icon still counts the row."""
    _register(repositories, workspace)
    until = datetime.now(timezone.utc) + timedelta(hours=2)
    _set_preferences(repositories, MEMBER, notifications_paused_until=until.isoformat())

    _assign(issues_client, repositories, workspace)

    [(_, message)] = sender.sent
    assert message.alert is None
    assert message.badge == 1


def test_a_finished_token_removes_its_device(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any, sender: RecordingSender
) -> None:
    """When the provider says a token will never work, it does not get asked again."""
    _register(repositories, workspace)
    sender.outcome = PushOutcome.GONE

    _assign(issues_client, repositories, workspace)

    assert repositories.inbox.push_devices.for_user(MEMBER) == []


def test_a_sender_that_fails_never_fails_the_consumer(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Push is best effort, so the inbox row survives any failure on the way out."""

    class Broken:
        """A sender that raises, which the real one should not."""

        def send(self, _token: str, _message: PushMessage) -> PushOutcome:
            """Fail."""
            raise RuntimeError("boom")

    monkeypatch.setattr(push_module, "sender_for", lambda _platform: Broken())
    _register(repositories, workspace)

    _assign(issues_client, repositories, workspace)

    assert repositories.inbox.unread_count(workspace, MEMBER) == 1


def test_no_sender_turns_push_off_cleanly(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Credentials that are missing leave no sender, and the fan out carries on untouched."""
    monkeypatch.setattr(push_module, "sender_for", lambda _platform: None)
    _register(repositories, workspace)

    _assign(issues_client, repositories, workspace)

    assert repositories.inbox.unread_count(workspace, MEMBER) == 1
    assert len(repositories.inbox.push_devices.for_user(MEMBER)) == 1


def test_reading_the_inbox_clears_the_badge(
    client: TestClient,
    issues_client: TestClient,
    repositories: Any,
    workspace: str,
    statuses: Any,
    sender: RecordingSender,
) -> None:
    """Marking everything read sets the icon to zero on the person's phones, showing nothing."""
    _register(repositories, workspace)
    _assign(issues_client, repositories, workspace)
    sender.sent.clear()
    sign_in(client, MEMBER)

    response = client.post(f"/api/workspaces/{workspace}/inbox/read", json={"all": True})

    assert response.status_code == 200
    [(_, message)] = sender.sent
    assert message.badge == 0
    assert message.alert is None


def test_the_badge_counts_every_workspace_on_the_device(
    repositories: Any, workspace: str, sender: RecordingSender
) -> None:
    """A row from a workspace not yet opened on the phone joins the count, and stays in it."""
    _register(repositories, workspace)
    other = "01JB00000000000000000OTHER1"
    moment = datetime.now(timezone.utc)
    row = Notification(
        ws_user=inbox_partition(other, MEMBER),
        notification_id="n1",
        workspace_id=other,
        kind="assigned",
        issue_id="i1",
        issue_key="ABC-1",
        issue_title="An issue",
        team_id="t1",
        actor_id=OWNER,
        actor_name="Olive Owner",
        recipient_id=MEMBER,
        created_at=moment,
        unread_at=instant(moment),
    )
    assert repositories.inbox.create(row)

    deliver_push(repositories, row)
    sync_push_badge(repositories, MEMBER)

    [(_, first), (_, second)] = sender.sent
    assert first.badge == 1
    assert second.badge == 1


def test_a_purge_takes_the_workspace_off_the_device(repositories: Any, workspace: str) -> None:
    """Leaving the only workspace on a phone removes the device, since nothing can reach it."""
    _register(repositories, workspace)

    repositories.inbox.delete_all(workspace, MEMBER)

    assert repositories.inbox.push_devices.for_user(MEMBER) == []
