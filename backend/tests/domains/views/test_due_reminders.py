"""The issue due date reminder sweep the digest flush schedule runs every hour.

The properties held are that an assignee gets one due soon reminder from the day
before and one overdue reminder after the date, however many passes run and even
after deleting them; that moving the due date or the assignee arms a fresh one;
that completed, archived and unassigned issues, an assignee who cannot see the team,
an assignee who turned the kind off and a long stale due date get none; that the
day is the assignee's own, from their timezone, else the team's, else UTC, with
the once only marker holding across zones; that the sweep claims each hourly
window once, however late its tick lands; and that the email names the reminder.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterator
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from webbpulse.identity.email import RecordingEmailSender

from app.common.db.dynamo.team_config import default_standup_settings
from app.common.email import reset_email_sender
from app.domains.views.consumers.digest import NOTIFY_DIGEST_SOURCE
from app.domains.views.consumers.due_reminders import (
    DUE_SOON,
    OVERDUE,
    OVERDUE_WINDOW,
    SWEEP_INTERVAL,
    reminder_for,
    run_due_reminders,
    sweep_due,
)
from app.domains.views.consumers.notify import handle_record
from app.domains.views.consumers.sweeps import window_start
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import TEAM, seed_issue
from tests.domains.views.test_notify_consumer import flush_digests, inbox_of

DUE = "2026-09-10"

DAY_BEFORE = datetime(2026, 9, 9, 8, 0, tzinfo=timezone.utc)

DAY_AFTER = datetime(2026, 9, 11, 8, 0, tzinfo=timezone.utc)

PACIFIC = "America/Los_Angeles"

TOKYO = "Asia/Tokyo"


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


def _noon(day: date) -> datetime:
    """Midday UTC on one day, well clear of any UTC day boundary."""
    return datetime(day.year, day.month, day.day, 12, 0, tzinfo=timezone.utc)


def _zone_of(repositories: Any, user_id: str, name: str) -> None:
    """Store one person's own timezone."""
    repositories.users.update(user_id, timezone=name)


def test_the_window_of_each_reminder() -> None:
    """Due soon from the day before through the day, overdue after it until the window closes."""
    due = date(2026, 9, 10)
    soon_at = datetime(2026, 9, 9, tzinfo=timezone.utc)
    overdue_at = datetime(2026, 9, 11, tzinfo=timezone.utc)

    assert reminder_for(DUE, _noon(due - timedelta(days=2))) is None
    assert reminder_for(DUE, _noon(due - timedelta(days=1))) == (DUE_SOON, soon_at, soon_at)
    assert reminder_for(DUE, _noon(due)) == (DUE_SOON, soon_at, soon_at)
    assert reminder_for(DUE, _noon(due + timedelta(days=1))) == (OVERDUE, overdue_at, overdue_at)
    assert reminder_for(DUE, _noon(due + OVERDUE_WINDOW)) is not None
    assert reminder_for(DUE, _noon(due + OVERDUE_WINDOW + timedelta(days=1))) is None
    assert reminder_for("not a date", _noon(due)) is None


def test_a_zone_behind_utc_turns_overdue_at_its_own_midnight() -> None:
    """In Los Angeles the evening of the due date is still not overdue, though UTC has moved on."""
    zone = ZoneInfo(PACIFIC)
    evening = datetime(2026, 9, 11, 2, 0, tzinfo=timezone.utc)
    local_midnight = datetime(2026, 9, 11, 7, 0, tzinfo=timezone.utc)

    assert reminder_for(DUE, evening) is not None and reminder_for(DUE, evening).kind == OVERDUE
    owed = reminder_for(DUE, evening, zone)
    assert owed is not None and owed.kind == DUE_SOON
    late = reminder_for(DUE, local_midnight, zone)
    assert late is not None
    assert late.kind == OVERDUE
    assert late.stamp == local_midnight
    assert late.marker == datetime(2026, 9, 11, tzinfo=timezone.utc)
    early = reminder_for(DUE, datetime(2026, 9, 9, 6, 59, tzinfo=timezone.utc), zone)
    assert early is None


def test_a_zone_ahead_of_utc_turns_overdue_before_utc_does() -> None:
    """In Tokyo the due date is over while UTC is still on it."""
    zone = ZoneInfo(TOKYO)
    tokyo_morning = datetime(2026, 9, 10, 16, 0, tzinfo=timezone.utc)

    utc_view = reminder_for(DUE, tokyo_morning)
    assert utc_view is not None and utc_view.kind == DUE_SOON
    owed = reminder_for(DUE, tokyo_morning, zone)
    assert owed is not None
    assert owed.kind == OVERDUE
    assert owed.stamp == datetime(2026, 9, 10, 15, 0, tzinfo=timezone.utc)
    assert owed.marker == datetime(2026, 9, 11, tzinfo=timezone.utc)
    soon = reminder_for(DUE, datetime(2026, 9, 8, 15, 0, tzinfo=timezone.utc), zone)
    assert soon is not None and soon.kind == DUE_SOON
    assert soon.stamp == datetime(2026, 9, 8, 15, 0, tzinfo=timezone.utc)


def test_a_pacific_assignee_is_reminded_on_their_own_day(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any
) -> None:
    """The overdue reminder waits for midnight in Los Angeles, not in UTC."""
    _zone_of(repositories, MEMBER, PACIFIC)
    _due_issue(issues_client, workspace)

    evening = run_due_reminders(repositories, datetime(2026, 9, 11, 2, 0, tzinfo=timezone.utc))
    after_midnight = run_due_reminders(repositories, datetime(2026, 9, 11, 7, 30, tzinfo=timezone.utc))

    assert (evening.due_soon, evening.overdue) == (1, 0)
    assert (after_midnight.due_soon, after_midnight.overdue) == (0, 1)
    soon, overdue = _reminders(repositories, workspace, MEMBER)
    assert soon["created_at"].startswith("2026-09-09T07:00:00")
    assert overdue["created_at"].startswith("2026-09-11T07:00:00")


def test_a_tokyo_assignee_is_reminded_on_their_own_day(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any
) -> None:
    """The overdue reminder arrives at midnight in Tokyo, while UTC is still on the due date."""
    _zone_of(repositories, MEMBER, TOKYO)
    _due_issue(issues_client, workspace)

    before = run_due_reminders(repositories, datetime(2026, 9, 10, 14, 0, tzinfo=timezone.utc))
    after = run_due_reminders(repositories, datetime(2026, 9, 10, 15, 30, tzinfo=timezone.utc))

    assert (before.due_soon, before.overdue) == (1, 0)
    assert (after.due_soon, after.overdue) == (0, 1)


def test_the_team_timezone_is_the_fallback(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any
) -> None:
    """An assignee with no timezone of their own is judged on the team's standup timezone."""
    settings = default_standup_settings(workspace, TEAM).model_copy(update={"timezone": TOKYO})
    repositories.team_config.put_standup_settings(settings)
    _due_issue(issues_client, workspace)

    summary = run_due_reminders(repositories, datetime(2026, 9, 10, 15, 30, tzinfo=timezone.utc))

    assert summary.overdue == 1


def test_an_unknown_stored_zone_falls_back_to_utc(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any
) -> None:
    """A name the zone database does not know reads as UTC rather than failing the sweep."""
    _zone_of(repositories, MEMBER, "Mars/Olympus")
    _due_issue(issues_client, workspace)

    summary = run_due_reminders(repositories, datetime(2026, 9, 11, 0, 30, tzinfo=timezone.utc))

    assert summary.overdue == 1


def test_changing_zone_near_a_day_boundary_does_not_send_twice(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any
) -> None:
    """The marker is keyed on the due date, so a reminder sent in one zone is not sent again in another."""
    _zone_of(repositories, MEMBER, TOKYO)
    _due_issue(issues_client, workspace)
    first = run_due_reminders(repositories, datetime(2026, 9, 10, 15, 5, tzinfo=timezone.utc))

    _zone_of(repositories, MEMBER, PACIFIC)
    again = run_due_reminders(repositories, datetime(2026, 9, 11, 7, 5, tzinfo=timezone.utc))
    _zone_of(repositories, MEMBER, "UTC")
    utc = run_due_reminders(repositories, datetime(2026, 9, 11, 0, 5, tzinfo=timezone.utc))

    assert first.overdue == 1
    assert (again.overdue, utc.overdue) == (0, 0)
    assert [row["kind"] for row in _reminders(repositories, workspace, MEMBER)].count(OVERDUE) == 1


def test_the_assignee_gets_one_of_each_however_many_passes_run(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """Passes the day before, on the day and after write one due soon and one overdue row."""
    issue = _due_issue(issues_client, workspace)

    first = run_due_reminders(repositories, DAY_BEFORE)
    run_due_reminders(repositories, DAY_BEFORE + timedelta(hours=1))
    run_due_reminders(repositories, datetime(2026, 9, 10, 15, 0, tzinfo=timezone.utc))
    flush_digests(repositories)
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


def test_a_completed_issue_is_never_reminded(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any
) -> None:
    """A completed issue is not due any more."""
    _due_issue(issues_client, workspace, status_id=statuses["completed"].status_id)

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
    repositories.users.update(
        MEMBER,
        notification_preferences={
            "due_soon": {"in_app": False, "email": False},
            "overdue": {"in_app": True, "email": False},
        },
    )
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


def test_the_sweep_runs_once_an_hour(repositories: Any) -> None:
    """The first tick of each hour claims it and the rest of that hour's ticks do not."""
    hour = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)
    ran = [minute for minute in range(120) if sweep_due(repositories, hour + timedelta(minutes=minute))]
    assert ran == [0, 60]
    assert repositories.inbox.last_sweep("due_reminders") == window_start(hour + timedelta(hours=1), SWEEP_INTERVAL)


def test_a_late_tick_still_runs_the_sweep(repositories: Any) -> None:
    """A tick that misses the top of the hour still runs that hour's pass, once."""
    hour = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)
    assert sweep_due(repositories, hour)

    assert sweep_due(repositories, hour + timedelta(hours=1, minutes=7, seconds=13))
    assert not sweep_due(repositories, hour + timedelta(hours=1, minutes=8))
    assert sweep_due(repositories, hour + timedelta(hours=3, minutes=59))


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
    monkeypatch.setattr("app.domains.views.consumers.due_reminders.sweep_due", lambda repositories, now: True)

    handle_record(repositories, {"eventSource": NOTIFY_DIGEST_SOURCE, "eventName": "FLUSH", "eventID": "x"})

    assert [row["kind"] for row in _reminders(repositories, workspace, MEMBER)] == [DUE_SOON]
