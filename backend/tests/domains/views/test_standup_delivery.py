"""The scheduled standup digest delivery the digest flush schedule runs every five minutes.

The properties held are that a team's digest is due once its local send time has
passed on a day its cadence covers, in any timezone; that each team member gets
one inbox row and one email per digest however many passes run, even after
deleting the row; that an empty digest goes to nobody; that the `standup_digest`
preference turns either channel off; and that the project update reminder also
queues the channel announcement.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterator

import pytest
from webbpulse.identity.email import RecordingEmailSender

from app.common.core.config import settings
from app.common.db.dynamo.inbox import NOTIFICATION_KINDS
from app.common.db.dynamo.team_config import StandupSettings, default_standup_settings
from app.common.email import reset_email_sender
from app.common.project_cadence import CHANNEL_UPDATE_DUE_JOB, ProjectUpdateDue, queue_update_due_announcement
from app.domains.views.consumers import standups
from app.domains.views.consumers.digest import NOTIFY_DIGEST_SOURCE
from app.domains.views.consumers.notify import handle_record
from app.domains.views.consumers.standups import SEND_WINDOW, due_date, run_standups, sweep_due
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_team_member
from tests.domains.views.conftest import TEAM
from tests.domains.views.test_notify_consumer import inbox_of

TUESDAY = date(2026, 10, 6)

NEW_YORK_SEND = datetime(2026, 10, 6, 13, 0, tzinfo=timezone.utc)

AFTER_SEND = NEW_YORK_SEND + timedelta(minutes=5)


@pytest.fixture
def recorder() -> Iterator[RecordingEmailSender]:
    """A recording sender installed as the process-wide one for one test."""
    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


def schedule(workspace: str, **fields: Any) -> StandupSettings:
    """Standup settings for the team, a daily 09:00 New York digest unless told otherwise."""
    values: dict[str, Any] = {"cadence": "daily", "timezone": "America/New_York", "send_time": "09:00"}
    values.update(fields)
    return default_standup_settings(workspace, TEAM).model_copy(update=values)


def enable(repositories: Any, workspace: str, **fields: Any) -> StandupSettings:
    """Store a schedule for the team, give it two members and a note so the digest has content."""
    stored = repositories.team_config.put_standup_settings(schedule(workspace, **fields))
    add_team_member(repositories, workspace, TEAM, MEMBER, "member")
    add_team_member(repositories, workspace, TEAM, ADMIN, "member")
    return stored


def note(repositories: Any, workspace: str, day: date = TUESDAY) -> None:
    """Leave the member's note on the digest of `day`."""
    repositories.team_config.put_standup_note(workspace, TEAM, day.isoformat(), MEMBER, "Shipped the importer.")


def standup_rows(repositories: Any, workspace: str, user_id: str) -> list[dict[str, Any]]:
    """The standup digest rows one member holds."""
    return [row for row in inbox_of(repositories, workspace, user_id) if row["kind"] == "standup_digest"]


def test_standup_digest_is_a_preference_kind() -> None:
    """The preferences API lists the new kind, so a member can turn it off."""
    assert "standup_digest" in NOTIFICATION_KINDS


def test_a_new_york_digest_is_due_after_its_local_send_time(workspace: str) -> None:
    """09:00 in New York is 13:00 UTC in October, and the digest is not due a minute before."""
    settings_ = schedule(workspace)
    assert due_date(settings_, AFTER_SEND) == TUESDAY
    assert due_date(settings_, NEW_YORK_SEND - timedelta(minutes=1)) is None


def test_a_tokyo_digest_is_due_on_its_own_local_date(workspace: str) -> None:
    """09:00 in Tokyo is midnight UTC, so the due date is the Tokyo date, not the UTC one."""
    settings_ = schedule(workspace, timezone="Asia/Tokyo")
    assert due_date(settings_, datetime(2026, 10, 6, 0, 5, tzinfo=timezone.utc)) == TUESDAY
    assert due_date(settings_, datetime(2026, 10, 5, 23, 55, tzinfo=timezone.utc)) is None


def test_a_daily_digest_skips_the_weekend(workspace: str) -> None:
    """Saturday and Sunday get no daily digest."""
    settings_ = schedule(workspace)
    saturday = datetime(2026, 10, 10, 13, 5, tzinfo=timezone.utc)
    assert due_date(settings_, saturday) is None
    assert due_date(settings_, saturday + timedelta(days=1)) is None
    assert due_date(settings_, saturday + timedelta(days=2)) == date(2026, 10, 12)


def test_a_weekly_digest_goes_out_on_its_weekday_only(workspace: str) -> None:
    """A Tuesday weekly digest is due on Tuesday and not on Wednesday."""
    settings_ = schedule(workspace, cadence="weekly", weekday=1)
    assert due_date(settings_, AFTER_SEND) == TUESDAY
    assert due_date(settings_, AFTER_SEND + timedelta(days=1)) is None


def test_a_send_time_long_past_is_not_due(workspace: str) -> None:
    """Turning a schedule on in the afternoon does not mail that morning's digest."""
    settings_ = schedule(workspace)
    assert due_date(settings_, NEW_YORK_SEND + SEND_WINDOW) == TUESDAY
    assert due_date(settings_, NEW_YORK_SEND + SEND_WINDOW + timedelta(minutes=1)) is None


def test_an_off_cadence_or_a_bad_timezone_is_never_due(workspace: str) -> None:
    """Settings that cannot place a send time are skipped rather than raised on."""
    assert due_date(schedule(workspace, cadence="off"), AFTER_SEND) is None
    assert due_date(schedule(workspace, timezone="Mars/Olympus"), AFTER_SEND) is None


def test_the_sweep_runs_every_five_minutes() -> None:
    """The flush schedule ticks every minute and the sweep rides one tick in five."""
    hour = datetime(2026, 10, 6, 13, 0, tzinfo=timezone.utc)
    ran = [minute for minute in range(60) if sweep_due(hour.replace(minute=minute))]
    assert ran == list(range(0, 60, 5))


def test_each_member_gets_the_digest_in_the_inbox_and_by_email(
    repositories: Any, workspace: str, recorder: RecordingEmailSender
) -> None:
    """Every team member who can see the team gets one row and one email, and outsiders get none."""
    enable(repositories, workspace)
    note(repositories, workspace)

    summary = run_standups(repositories, AFTER_SEND)

    assert (summary.due, summary.sent, summary.empty) == (1, 1, 0)
    for user_id in (MEMBER, ADMIN, GUEST):
        rows = standup_rows(repositories, workspace, user_id)
        assert len(rows) == 1
        assert rows[0]["issue_key"] == "ABC"
        assert rows[0]["standup_date"] == TUESDAY.isoformat()
        assert rows[0]["team_id"] == TEAM
    assert standup_rows(repositories, workspace, OWNER) == []
    recipients = sorted(str(message.to) for message in recorder.sent)
    assert recipients == ["admin@example.com", "guest@example.com", "member@example.com"]
    assert all("[ABC] Standup for" in message.subject for message in recorder.sent)


def test_repeated_passes_deliver_once(repositories: Any, workspace: str, recorder: RecordingEmailSender) -> None:
    """The marker stops a second pass, and a deleted row is not sent again."""
    enable(repositories, workspace)
    note(repositories, workspace)

    run_standups(repositories, AFTER_SEND)
    sent = len(recorder.sent)
    row = standup_rows(repositories, workspace, MEMBER)[0]
    repositories.inbox.delete(workspace, MEMBER, row["notification_id"])

    again = run_standups(repositories, AFTER_SEND + timedelta(minutes=5))

    assert again.due == 0
    assert standup_rows(repositories, workspace, MEMBER) == []
    assert len(recorder.sent) == sent


def test_a_pass_that_died_before_the_marker_finishes_without_duplicates(
    repositories: Any, workspace: str, recorder: RecordingEmailSender
) -> None:
    """With no marker the next pass rebuilds the digest, and the row ids drop what already landed."""
    stored = enable(repositories, workspace)
    note(repositories, workspace)
    standups.write_standup(
        repositories,
        standups.build_digest(repositories, workspace, TEAM, TUESDAY, settings=stored, now=AFTER_SEND),
        workspace_id=workspace,
        workspace_slug="acme",
        recipient_id=MEMBER,
        sent_at=NEW_YORK_SEND,
    )

    run_standups(repositories, AFTER_SEND)

    assert len(standup_rows(repositories, workspace, MEMBER)) == 1
    assert sorted(str(message.to) for message in recorder.sent).count("member@example.com") == 1


def test_an_empty_digest_is_not_sent(repositories: Any, workspace: str, recorder: RecordingEmailSender) -> None:
    """A day with nothing to report is marked done and reaches nobody."""
    enable(repositories, workspace)

    summary = run_standups(repositories, AFTER_SEND)

    assert (summary.due, summary.sent, summary.empty) == (1, 0, 1)
    assert standup_rows(repositories, workspace, MEMBER) == []
    assert recorder.sent == []
    assert repositories.inbox.standup_sent(workspace, TEAM, TUESDAY.isoformat())


def test_a_team_with_no_schedule_gets_nothing(
    repositories: Any, workspace: str, recorder: RecordingEmailSender
) -> None:
    """A team that never saved settings, or turned the digest off, is skipped."""
    add_team_member(repositories, workspace, TEAM, MEMBER, "member")
    note(repositories, workspace)
    assert run_standups(repositories, AFTER_SEND).teams == 0

    repositories.team_config.put_standup_settings(schedule(workspace, cadence="off"))
    assert run_standups(repositories, AFTER_SEND).teams == 0
    assert recorder.sent == []


def test_turning_off_the_email_keeps_the_inbox_row(
    repositories: Any, workspace: str, recorder: RecordingEmailSender
) -> None:
    """The email preference stops the mail and leaves the row."""
    enable(repositories, workspace)
    note(repositories, workspace)
    repositories.users.update(MEMBER, notification_preferences={"standup_digest": {"in_app": True, "email": False}})

    run_standups(repositories, AFTER_SEND)

    assert len(standup_rows(repositories, workspace, MEMBER)) == 1
    assert "member@example.com" not in [str(message.to) for message in recorder.sent]
    assert "admin@example.com" in [str(message.to) for message in recorder.sent]


def test_turning_off_both_channels_sends_nothing(
    repositories: Any, workspace: str, recorder: RecordingEmailSender
) -> None:
    """A member who opted out of both channels gets neither a row nor an email."""
    enable(repositories, workspace)
    note(repositories, workspace)
    repositories.users.update(MEMBER, notification_preferences={"standup_digest": {"in_app": False, "email": False}})

    run_standups(repositories, AFTER_SEND)

    assert standup_rows(repositories, workspace, MEMBER) == []
    assert "member@example.com" not in [str(message.to) for message in recorder.sent]
    assert len(standup_rows(repositories, workspace, ADMIN)) == 1


def test_the_schedule_record_runs_the_standup_sweep(repositories: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """The flush schedule's synthetic record also runs the standup sweep when its tick is due."""
    calls: list[datetime] = []
    monkeypatch.setattr(standups, "sweep_due", lambda now: True)
    monkeypatch.setattr(standups, "run_standups", lambda repositories, now: calls.append(now))

    handle_record(repositories, {"eventSource": NOTIFY_DIGEST_SOURCE, "eventName": "FLUSH", "eventID": "x"})

    assert len(calls) == 1


def test_a_due_reminder_queues_the_channel_announcement(monkeypatch: pytest.MonkeyPatch) -> None:
    """The reminder hands the channel post to the dispatch queue, and does nothing without one."""
    sent: list[tuple[str, Any]] = []
    event = ProjectUpdateDue(
        workspace_id="W1",
        project_id="P1",
        project_name="Launch",
        team_ids=(TEAM,),
        lead_id=MEMBER,
        due_at=datetime(2026, 10, 6, tzinfo=timezone.utc),
        interval_days=7,
    )

    monkeypatch.setattr(settings, "WEBHOOK_DISPATCH_QUEUE_URL", "")
    assert queue_update_due_announcement(event, send=lambda url, envelope: sent.append((url, envelope))) is False

    monkeypatch.setattr(settings, "WEBHOOK_DISPATCH_QUEUE_URL", "https://sqs.test/dispatch")
    assert queue_update_due_announcement(event, send=lambda url, envelope: sent.append((url, envelope))) is True

    assert len(sent) == 1
    url, envelope = sent[0]
    assert url == "https://sqs.test/dispatch"
    assert envelope.payload["kind"] == CHANNEL_UPDATE_DUE_JOB
    assert envelope.payload["project_id"] == "P1"
    assert envelope.payload["due_at"] == "2026-10-06T00:00:00+00:00"
