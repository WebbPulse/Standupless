"""The issue due date reminder sweep the digest flush schedule runs every hour.

The properties held are that an assignee gets one due soon reminder from the day
before and one overdue reminder after the date, however many passes run and even
after deleting them; that moving the due date or the assignee arms a fresh one;
that closed, archived and unassigned issues, an assignee who cannot see the team,
an assignee who turned the kind off and a long stale due date get none; and that
the email names the reminder.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.identity.email import RecordingEmailSender

from app.common.email import reset_email_sender
from app.domains.views.consumers.digest import NOTIFY_DIGEST_SOURCE
from app.domains.views.consumers.due_reminders import (
    DUE_SOON,
    OVERDUE,
    OVERDUE_WINDOW,
    reminder_for,
    run_due_reminders,
    sweep_due,
)
from app.domains.views.consumers.notify import handle_record
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import TEAM, seed_issue
from tests.domains.views.test_notify_consumer import flush_digests, inbox_of

DUE = "2026-09-10"

DAY_BEFORE = datetime(2026, 9, 9, 8, 0, tzinfo=timezone.utc)

DAY_AFTER = datetime(2026, 9, 11, 8, 0, tzinfo=timezone.utc)


@pytest.fixture
def recorder() -> Iterator[RecordingEmailSender]:
    """A recording sender installed as the process-wide one for one test."""
    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


def _reminders(repositories: Any, workspace: str, user_id: str) -> list[dict[str, Any]]:
    """The due date reminder rows one member holds, oldest first."""
    rows = [row for row in inbox_of(repositories, workspace, user_id) if row["kind"] in (DUE_SOON, OVERDUE)]
    return list(reversed(rows))


def _due_issue(issues_client: TestClient, workspace: str, **payload: Any) -> dict[str, Any]:
    """An open issue of `TEAM` assigned to `MEMBER` and due on `DUE`, made by the owner."""
    sign_in(issues_client, OWNER)
    body: dict[str, Any] = {"title": "Ship it", "assignee_id": MEMBER, "due_date": DUE}
    body.update(payload)
    return seed_issue(issues_client, workspace, **body)


def test_the_window_of_each_reminder() -> None:
    """Due soon from the day before through the day, overdue after it until the window closes."""
    due = date(2026, 9, 10)

    assert reminder_for(DUE, due - timedelta(days=2)) is None
    assert reminder_for(DUE, due - timedelta(days=1)) == (DUE_SOON, datetime(2026, 9, 9, tzinfo=timezone.utc))
    assert reminder_for(DUE, due) == (DUE_SOON, datetime(2026, 9, 9, tzinfo=timezone.utc))
    assert reminder_for(DUE, due + timedelta(days=1)) == (OVERDUE, datetime(2026, 9, 11, tzinfo=timezone.utc))
    assert reminder_for(DUE, due + OVERDUE_WINDOW) is not None
    assert reminder_for(DUE, due + OVERDUE_WINDOW + timedelta(days=1)) is None
    assert reminder_for("not a date", due) is None


def test_the_assignee_gets_one_of_each_however_many_passes_run(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """Passes the day before, on the day and after write one due soon and one overdue row."""
    issue = _due_issue(issues_client, workspace)

    first = run_due_reminders(repositories, DAY_BEFORE)
    run_due_reminders(repositories, DAY_BEFORE + timedelta(hours=1))
    run_due_reminders(repositories, datetime(2026, 9, 10, 15, 0, tzinfo=timezone.utc))
    later = run_due_reminders(repositories, DAY_AFTER)
    run_due_reminders(repositories, DAY_AFTER + timedelta(days=2))
    flush_digests(repositories)

    assert (first.due_soon, first.overdue) == (1, 0)
    assert (later.due_soon, later.overdue) == (0, 1)
    soon, overdue = _reminders(repositories, workspace, MEMBER)
    assert soon["kind"] == DUE_SOON
    assert overdue["kind"] == OVERDUE
    assert soon["issue_id"] == issue["id"]
    assert soon["issue_key"] == issue["key"]
    assert soon["issue_title"] == "Ship it"
    assert soon["team_id"] == TEAM
    assert soon["actor_id"] == ""
    assert soon["unread_at"]
    subjects = sorted(message.subject for message in recorder.sent)
    assert subjects == [f"[{issue['key']}] Ship it"] * 2
    texts = " ".join(message.text for message in recorder.sent)
    assert "This issue assigned to you is due soon." in texts
    assert "This issue assigned to you is overdue." in texts
    assert "because this issue is assigned to you" in texts


def test_nothing_is_sent_two_days_out(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any
) -> None:
    """An issue due later than tomorrow is not due soon yet."""
    _due_issue(issues_client, workspace)

    summary = run_due_reminders(repositories, DAY_BEFORE - timedelta(days=1))

    assert (summary.due_soon, summary.overdue) == (0, 0)
    assert _reminders(repositories, workspace, MEMBER) == []


def test_a_deleted_reminder_is_not_sent_again(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any
) -> None:
    """The marker outlives the row, so deleting the reminder does not bring it back."""
    _due_issue(issues_client, workspace)
    run_due_reminders(repositories, DAY_BEFORE)
    [row] = _reminders(repositories, workspace, MEMBER)

    assert repositories.inbox.delete(workspace, MEMBER, row["notification_id"])
    summary = run_due_reminders(repositories, DAY_BEFORE + timedelta(hours=3))

    assert summary.due_soon == 0
    assert _reminders(repositories, workspace, MEMBER) == []


def test_moving_the_due_date_arms_a_fresh_reminder(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any
) -> None:
    """A new due date is a new reminder, even after the old one went out."""
    issue = _due_issue(issues_client, workspace)
    run_due_reminders(repositories, DAY_BEFORE)

    response = issues_client.patch(f"/api/workspaces/{workspace}/issues/{issue['id']}", json={"due_date": "2026-09-12"})
    assert response.status_code == 200, response.text
    run_due_reminders(repositories, datetime(2026, 9, 11, 9, 0, tzinfo=timezone.utc))

    rows = _reminders(repositories, workspace, MEMBER)
    assert [row["kind"] for row in rows] == [DUE_SOON, DUE_SOON]
    assert rows[0]["notification_id"] != rows[1]["notification_id"]


def test_a_new_assignee_is_reminded_too(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any
) -> None:
    """Handing the issue on after the reminder went out reminds the new assignee."""
    issue = _due_issue(issues_client, workspace)
    run_due_reminders(repositories, DAY_BEFORE)

    response = issues_client.patch(f"/api/workspaces/{workspace}/issues/{issue['id']}", json={"assignee_id": ADMIN})
    assert response.status_code == 200, response.text
    run_due_reminders(repositories, DAY_BEFORE + timedelta(hours=1))

    assert [row["kind"] for row in _reminders(repositories, workspace, MEMBER)] == [DUE_SOON]
    assert [row["kind"] for row in _reminders(repositories, workspace, ADMIN)] == [DUE_SOON]


@pytest.mark.parametrize("category", ["completed", "canceled"])
def test_a_closed_issue_is_never_reminded(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any, category: str
) -> None:
    """Completed and canceled issues are not due any more."""
    _due_issue(issues_client, workspace, status_id=statuses[category].status_id)

    summary = run_due_reminders(repositories, DAY_AFTER)

    assert summary.overdue == 0
    assert _reminders(repositories, workspace, MEMBER) == []


def test_an_archived_issue_is_never_reminded(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any
) -> None:
    """An archived issue has left the status column the sweep reads."""
    seeded = _due_issue(issues_client, workspace, status_id=statuses["completed"].status_id)
    issue = repositories.issues.get(workspace, seeded["id"])
    assert repositories.issues.archive(issue, DAY_BEFORE) is not None

    run_due_reminders(repositories, DAY_AFTER)

    assert _reminders(repositories, workspace, MEMBER) == []


def test_an_unassigned_issue_is_never_reminded(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any
) -> None:
    """Nobody is owed a reminder for an issue nobody holds."""
    sign_in(issues_client, OWNER)
    seed_issue(issues_client, workspace, title="Loose end", due_date=DUE)

    summary = run_due_reminders(repositories, DAY_AFTER)

    assert summary.overdue == 0
    for user_id in (OWNER, ADMIN, MEMBER, GUEST):
        assert _reminders(repositories, workspace, user_id) == []


def test_an_assignee_who_cannot_see_the_team_is_not_reminded(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any
) -> None:
    """A guest who has left the team hears nothing about its issues."""
    _due_issue(issues_client, workspace, assignee_id=GUEST)
    repositories.memberships.delete_team_membership(workspace, TEAM, GUEST)

    run_due_reminders(repositories, DAY_BEFORE)

    assert _reminders(repositories, workspace, GUEST) == []


def test_preferences_decide_the_channels(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """Both channels off sends nothing, and email off still leaves the inbox row."""
    repositories.users.update(MEMBER, notification_preferences={"due_soon": {"in_app": False, "email": False}})
    repositories.users.update(MEMBER, notification_preferences={"overdue": {"in_app": True, "email": False}})
    _due_issue(issues_client, workspace)

    run_due_reminders(repositories, DAY_BEFORE)
    run_due_reminders(repositories, DAY_AFTER)
    flush_digests(repositories)

    assert [row["kind"] for row in _reminders(repositories, workspace, MEMBER)] == [OVERDUE]
    assert recorder.sent == []


def test_a_long_overdue_issue_is_left_alone(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any
) -> None:
    """Past the window, turning the sweep on mails nothing."""
    _due_issue(issues_client, workspace)

    run_due_reminders(repositories, DAY_AFTER + OVERDUE_WINDOW + timedelta(days=1))

    assert _reminders(repositories, workspace, MEMBER) == []


def test_the_sweep_runs_on_the_hour() -> None:
    """One flush tick in sixty also runs the sweep."""
    hour = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)
    ran = [minute for minute in range(60) if sweep_due(hour.replace(minute=minute))]
    assert ran == [0]


def test_the_schedule_record_runs_the_sweep(
    issues_client: TestClient,
    repositories: Any,
    workspace: str,
    statuses: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The flush schedule's synthetic record reaches the sweep on the hour."""
    today = datetime.now(timezone.utc).date()
    _due_issue(issues_client, workspace, due_date=(today + timedelta(days=1)).isoformat())
    monkeypatch.setattr("app.domains.views.consumers.due_reminders.sweep_due", lambda now: True)

    handle_record(repositories, {"eventSource": NOTIFY_DIGEST_SOURCE, "eventName": "FLUSH", "eventID": "x"})

    assert [row["kind"] for row in _reminders(repositories, workspace, MEMBER)] == [DUE_SOON]
