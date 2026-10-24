"""Issue reminders: setting, listing and cancelling one, and delivering it into the inbox.

The properties worth holding are that a reminder is the caller's own and needs
only sight of the issue, that one issue holds one reminder per member, and that a
due reminder becomes exactly one `reminder` notification however many ticks run,
or none when the issue is gone or out of sight.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.identity.email import RecordingEmailSender

from app.common.email import reset_email_sender
from app.domains.views.consumers.digest import NOTIFY_DIGEST_SOURCE
from app.domains.views.consumers.issue_reminders import run_issue_reminders
from app.domains.views.consumers.notify import handle_record
from tests.domains.helpers import GUEST, MEMBER, OUTSIDER, OWNER, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM, seed_issue
from tests.domains.views.test_notify_consumer import flush_digests, inbox_of


@pytest.fixture
def recorder() -> Iterator[RecordingEmailSender]:
    """A recording sender installed as the process-wide one for one test."""
    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


def _issue(issues_client: TestClient, workspace: str, team_id: str = TEAM) -> dict[str, Any]:
    """One issue made by the owner."""
    sign_in(issues_client, OWNER)
    return seed_issue(issues_client, workspace, team_id=team_id, title="Follow up")


def _soon(minutes: int = 30) -> datetime:
    """A moment a little in the future, comfortably past the one minute floor."""
    return datetime.now(timezone.utc) + timedelta(minutes=minutes)


def _set(client: TestClient, workspace: str, issue_id: str, moment: datetime) -> Any:
    """Set the signed in caller's reminder on one issue."""
    return client.put(f"/api/workspaces/{workspace}/inbox/reminders/{issue_id}", json={"remind_at": moment.isoformat()})


def _reminder_rows(repositories: Any, workspace: str, user_id: str) -> list[dict[str, Any]]:
    """The `reminder` notifications one member holds."""
    return [row for row in inbox_of(repositories, workspace, user_id) if row["kind"] == "reminder"]


def test_setting_a_reminder_lists_it_on_the_issue(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """A reminder set on an issue reads back with the issue's key and title."""
    issue = _issue(issues_client, workspace)
    moment = _soon()

    sign_in(client, MEMBER)
    response = _set(client, workspace, issue["id"], moment)
    listed = client.get(f"/api/workspaces/{workspace}/inbox/reminders", params={"issue_id": issue["id"]})

    assert response.status_code == 200, response.text
    assert response.json()["issue_key"] == issue["key"]
    reminders = listed.json()["reminders"]
    assert [row["issue_id"] for row in reminders] == [issue["id"]]
    assert datetime.fromisoformat(reminders[0]["remind_at"]) == moment
    assert reminders[0]["issue_title"] == "Follow up"


def test_setting_again_replaces_the_reminder(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """One reminder per issue: a second set moves it rather than adding another."""
    issue = _issue(issues_client, workspace)
    first, second = _soon(30), _soon(90)

    sign_in(client, MEMBER)
    _set(client, workspace, issue["id"], first)
    _set(client, workspace, issue["id"], second)

    reminders = client.get(f"/api/workspaces/{workspace}/inbox/reminders").json()["reminders"]
    assert [datetime.fromisoformat(row["remind_at"]) for row in reminders] == [second]
    assert len(repositories.inbox.reminders.due(second + timedelta(minutes=1), limit=10)) == 1


def test_reminders_list_soonest_first(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """The list reads in the order the reminders come due."""
    late = _issue(issues_client, workspace)
    early = _issue(issues_client, workspace)

    sign_in(client, MEMBER)
    _set(client, workspace, late["id"], _soon(120))
    _set(client, workspace, early["id"], _soon(10))

    reminders = client.get(f"/api/workspaces/{workspace}/inbox/reminders").json()["reminders"]
    assert [row["issue_id"] for row in reminders] == [early["id"], late["id"]]


def test_a_reminder_is_the_callers_own(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """Another member sees none of it and cannot cancel it."""
    issue = _issue(issues_client, workspace)
    sign_in(client, MEMBER)
    _set(client, workspace, issue["id"], _soon())

    sign_in(client, OWNER)
    listed = client.get(f"/api/workspaces/{workspace}/inbox/reminders")
    cancelled = client.delete(f"/api/workspaces/{workspace}/inbox/reminders/{issue['id']}")

    assert listed.json()["reminders"] == []
    assert cancelled.status_code == 404


def test_cancelling_removes_the_reminder_and_its_delivery(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """A cancelled reminder neither lists nor ever lands in the inbox."""
    issue = _issue(issues_client, workspace)
    moment = _soon()
    sign_in(client, MEMBER)
    _set(client, workspace, issue["id"], moment)

    cancelled = client.delete(f"/api/workspaces/{workspace}/inbox/reminders/{issue['id']}")
    again = client.delete(f"/api/workspaces/{workspace}/inbox/reminders/{issue['id']}")
    run_issue_reminders(repositories, moment + timedelta(minutes=1))

    assert cancelled.status_code == 204
    assert again.status_code == 404
    assert client.get(f"/api/workspaces/{workspace}/inbox/reminders").json()["reminders"] == []
    assert _reminder_rows(repositories, workspace, MEMBER) == []


def test_an_issue_out_of_sight_cannot_be_reminded(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """A guest outside the team gets a 404, as for any issue they cannot see."""
    issue = _issue(issues_client, workspace, team_id=OTHER_TEAM)

    sign_in(client, GUEST)
    response = _set(client, workspace, issue["id"], _soon())

    assert response.status_code == 404


@pytest.mark.parametrize(
    "moment",
    [
        datetime(2020, 1, 1, tzinfo=timezone.utc).isoformat(),
        "2099-01-01T09:00:00+00:00",
        "2099-01-01T09:00:00",
    ],
)
def test_the_moment_must_be_aware_and_in_range(
    client: TestClient, issues_client: TestClient, workspace: str, moment: str
) -> None:
    """A past, far off or zoneless moment is refused."""
    issue = _issue(issues_client, workspace)

    sign_in(client, MEMBER)
    response = client.put(f"/api/workspaces/{workspace}/inbox/reminders/{issue['id']}", json={"remind_at": moment})

    assert response.status_code == 422


def test_a_due_reminder_lands_in_the_inbox_once(
    client: TestClient,
    issues_client: TestClient,
    workspace: str,
    repositories: Any,
    recorder: RecordingEmailSender,
) -> None:
    """At its moment the member gets one unread `reminder` row and one email, however many ticks run."""
    issue = _issue(issues_client, workspace)
    moment = _soon()
    sign_in(client, MEMBER)
    _set(client, workspace, issue["id"], moment)

    early = run_issue_reminders(repositories, moment - timedelta(minutes=1))
    on_time = run_issue_reminders(repositories, moment)
    later = run_issue_reminders(repositories, moment + timedelta(minutes=1))
    flush_digests(repositories)

    rows = _reminder_rows(repositories, workspace, MEMBER)
    assert (early, on_time, later) == (0, 1, 0)
    assert [row["issue_id"] for row in rows] == [issue["id"]]
    assert rows[0]["actor_id"] == ""
    assert client.get(f"/api/workspaces/{workspace}/inbox/reminders").json()["reminders"] == []
    assert len(recorder.sent) == 1
    assert "reminded" in recorder.sent[0].text


def test_the_reminder_reads_as_a_reminder(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """The inbox row's summary names it a reminder."""
    issue = _issue(issues_client, workspace)
    moment = _soon()
    sign_in(client, MEMBER)
    _set(client, workspace, issue["id"], moment)
    run_issue_reminders(repositories, moment)

    rows = client.get(f"/api/workspaces/{workspace}/inbox", params={"kind": "reminder"}).json()["notifications"]

    assert [row["summary"] for row in rows] == ["Reminder"]
    assert rows[0]["unread"] is True


def test_the_reminder_preference_decides_the_channels(
    client: TestClient,
    issues_client: TestClient,
    workspace: str,
    repositories: Any,
    recorder: RecordingEmailSender,
) -> None:
    """Reminder emails off still lands the inbox row and sends no mail."""
    repositories.users.update(MEMBER, notification_preferences={"reminder": {"in_app": True, "email": False}})
    issue = _issue(issues_client, workspace)
    moment = _soon()
    sign_in(client, MEMBER)
    _set(client, workspace, issue["id"], moment)

    run_issue_reminders(repositories, moment)
    flush_digests(repositories)

    assert len(_reminder_rows(repositories, workspace, MEMBER)) == 1
    assert recorder.sent == []


def test_a_reminder_on_a_deleted_issue_is_dropped(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """Nothing lands for an issue that is gone, and the reminder is not retried."""
    issue = _issue(issues_client, workspace)
    moment = _soon()
    sign_in(client, MEMBER)
    _set(client, workspace, issue["id"], moment)
    sign_in(issues_client, OWNER)
    assert issues_client.delete(f"/api/workspaces/{workspace}/issues/{issue['id']}").status_code == 204

    run_issue_reminders(repositories, moment)

    assert _reminder_rows(repositories, workspace, MEMBER) == []
    assert repositories.inbox.reminders.get(workspace, MEMBER, issue["id"]) is None
    assert repositories.inbox.reminders.due(moment + timedelta(days=1), limit=10) == []


def test_a_member_who_lost_sight_of_the_issue_hears_nothing(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """A guest who left the team gets no reminder about its issue."""
    issue = _issue(issues_client, workspace)
    moment = _soon()
    sign_in(client, GUEST)
    _set(client, workspace, issue["id"], moment)
    repositories.memberships.delete_team_membership(workspace, TEAM, GUEST)

    run_issue_reminders(repositories, moment)

    assert _reminder_rows(repositories, workspace, GUEST) == []


def test_moving_a_reminder_drops_the_old_moment(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """Only the newest moment delivers: the first one passing writes nothing."""
    issue = _issue(issues_client, workspace)
    first, second = _soon(30), _soon(90)
    sign_in(client, MEMBER)
    _set(client, workspace, issue["id"], first)
    _set(client, workspace, issue["id"], second)

    assert run_issue_reminders(repositories, first) == 0
    assert run_issue_reminders(repositories, second) == 1


def test_the_schedule_record_delivers_due_reminders(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """The flush schedule's synthetic record runs delivery on every tick."""
    issue = _issue(issues_client, workspace)
    moment = _soon(2)
    sign_in(client, MEMBER)
    _set(client, workspace, issue["id"], moment)
    pending = repositories.inbox.reminders.get(workspace, MEMBER, issue["id"])
    repositories.inbox.reminders.set(workspace, MEMBER, issue["id"], pending.remind_at - timedelta(minutes=10))

    handle_record(repositories, {"eventSource": NOTIFY_DIGEST_SOURCE, "eventName": "FLUSH", "eventID": "x"})

    assert len(_reminder_rows(repositories, workspace, MEMBER)) == 1


def test_purging_an_inbox_clears_its_reminders(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """The purges' inbox delete takes the member's reminders and their due markers with it."""
    issue = _issue(issues_client, workspace)
    moment = _soon()
    sign_in(client, MEMBER)
    _set(client, workspace, issue["id"], moment)

    repositories.inbox.delete_all(workspace, MEMBER)

    assert repositories.inbox.reminders.list(workspace, MEMBER) == []
    assert repositories.inbox.reminders.due(moment + timedelta(days=1), limit=10) == []


def test_a_non_member_cannot_set_a_reminder(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """Outside the workspace there is nothing to remind about."""
    issue = _issue(issues_client, workspace)

    sign_in(client, OUTSIDER)
    response = _set(client, workspace, issue["id"], _soon())

    assert response.status_code in (403, 404)
