"""The Pulse digest sweep the digest flush schedule runs every hour.

The properties held are that a daily digest is owed from 08:00 on the reader's
own calendar for two hours and a weekly one only on Mondays; that it lists what
others posted in the period on what the reader follows, and nothing of their
own, older or unfollowed; that it goes once however many passes run; that an
empty digest is not sent; that a reader who left it off or turned email off gets
none; and that the flush schedule's record reaches the sweep.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterator
from zoneinfo import ZoneInfo

import pytest
from webbpulse.dynamodb import new_ulid
from webbpulse.identity.email import RecordingEmailSender

from app.common.db.dynamo.planning import Project, PulseEvent, project_key, pulse_key
from app.common.email import reset_email_sender
from app.domains.views.consumers.digest import NOTIFY_DIGEST_SOURCE
from app.domains.views.consumers.notify import handle_record
from app.domains.views.consumers.pulse_digest import run_pulse_digests, send_moment
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER
from tests.domains.views.conftest import OTHER_TEAM, TEAM

LED = "01JB000000000000000000PRJL"

UNFOLLOWED = "01JB000000000000000000PRJU"

MONDAY_SEND = datetime(2026, 9, 14, 8, 0, tzinfo=timezone.utc)

TUESDAY_SEND = datetime(2026, 9, 15, 8, 0, tzinfo=timezone.utc)


@pytest.fixture
def recorder() -> Iterator[RecordingEmailSender]:
    """A recording sender installed as the process-wide one for one test."""
    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


def _project(repositories: Any, workspace: str, project_id: str, name: str, **fields: Any) -> Project:
    """Store one project row directly, since `views` only ever reads the planning table."""
    values: "dict[str, Any]" = {"team_ids": [TEAM], "name": name, "created_by": OWNER}
    values.update(fields)
    project = Project(workspace_id=workspace, planning_key=project_key(project_id), project_id=project_id, **values)
    return repositories.planning.create_project(project)


def _event(repositories: Any, workspace: str, project_id: str, at: datetime, actor: str, body: str) -> None:
    """Store one project update entry posted at `at`."""
    event_id = new_ulid(at)
    repositories.planning.create_pulse_event(
        PulseEvent(
            workspace_id=workspace,
            planning_key=pulse_key(event_id),
            event_id=event_id,
            event_type="project_update",
            subject_type="project",
            project_id=project_id,
            update_id=event_id,
            body=body,
            health="at_risk",
            actor_id=actor,
            created_at=at,
        )
    )


def _opt_in(repositories: Any, user_id: str, cadence: str) -> None:
    """Turn one person's Pulse digest to `cadence`."""
    repositories.users.update(user_id, pulse_digest=cadence)


def test_the_send_moment_of_each_cadence() -> None:
    """Daily from 08:00 for two hours, weekly only on a Monday, and never when off."""
    assert send_moment("daily", TUESDAY_SEND) == TUESDAY_SEND
    assert send_moment("daily", TUESDAY_SEND + timedelta(minutes=119)) == TUESDAY_SEND
    assert send_moment("daily", TUESDAY_SEND + timedelta(hours=2)) is None
    assert send_moment("daily", TUESDAY_SEND - timedelta(minutes=1)) is None
    assert send_moment("weekly", TUESDAY_SEND) is None
    assert send_moment("weekly", MONDAY_SEND + timedelta(minutes=30)) == MONDAY_SEND
    assert send_moment("off", TUESDAY_SEND) is None


def test_the_send_moment_follows_the_readers_zone() -> None:
    """In Los Angeles the daily digest goes at 08:00 there, which is 15:00 UTC in September."""
    zone = ZoneInfo("America/Los_Angeles")
    local = datetime(2026, 9, 15, 15, 0, tzinfo=timezone.utc)
    assert send_moment("daily", TUESDAY_SEND, zone) is None
    assert send_moment("daily", local + timedelta(minutes=5), zone) == local


def test_a_daily_digest_lists_what_others_posted_on_what_the_reader_follows(
    repositories: Any, workspace: str, recorder: RecordingEmailSender
) -> None:
    """One email, with others' updates of the day on followed projects, sent once across passes."""
    _project(repositories, workspace, LED, "Launch", lead_id=MEMBER)
    _project(repositories, workspace, UNFOLLOWED, "Elsewhere")
    yesterday = TUESDAY_SEND - timedelta(hours=10)
    _event(repositories, workspace, LED, TUESDAY_SEND - timedelta(days=2), ADMIN, "Too old")
    _event(repositories, workspace, UNFOLLOWED, yesterday, ADMIN, "Not followed")
    _event(repositories, workspace, LED, yesterday, MEMBER, "My own")
    _event(repositories, workspace, LED, yesterday + timedelta(hours=1), ADMIN, "Slipping a week")
    _event(repositories, workspace, LED, TUESDAY_SEND + timedelta(minutes=5), ADMIN, "After the moment")
    _opt_in(repositories, MEMBER, "daily")

    summary = run_pulse_digests(repositories, TUESDAY_SEND + timedelta(minutes=10))
    run_pulse_digests(repositories, TUESDAY_SEND + timedelta(minutes=70))

    assert summary.sent == 1
    assert len(recorder.sent) == 1
    message = recorder.sent[0]
    assert str(message.to) == "member@example.com"
    assert message.subject == "Daily Pulse for Acme"
    assert "Adam Admin posted an update on Launch, at risk" in message.text
    assert "Slipping a week" in message.text
    for missing in ("Too old", "Not followed", "My own", "After the moment"):
        assert missing not in message.text
    assert "/w/acme/pulse" in message.text


def test_an_empty_digest_is_not_sent(repositories: Any, workspace: str, recorder: RecordingEmailSender) -> None:
    """Nothing new means no email, and the moment is still marked so later passes skip it."""
    _project(repositories, workspace, LED, "Launch", lead_id=MEMBER)
    _opt_in(repositories, MEMBER, "daily")

    summary = run_pulse_digests(repositories, TUESDAY_SEND)

    assert summary.empty == 1
    assert summary.sent == 0
    assert recorder.sent == []
    assert run_pulse_digests(repositories, TUESDAY_SEND + timedelta(minutes=30)).due == 0


def test_a_weekly_digest_covers_the_week_on_monday(
    repositories: Any, workspace: str, recorder: RecordingEmailSender
) -> None:
    """A weekly reader gets nothing midweek and the past seven days on Monday."""
    _project(repositories, workspace, LED, "Launch", lead_id=MEMBER)
    _event(repositories, workspace, LED, MONDAY_SEND - timedelta(days=6), ADMIN, "Early in the week")
    _opt_in(repositories, MEMBER, "weekly")

    run_pulse_digests(repositories, MONDAY_SEND - timedelta(days=6) + timedelta(hours=24))
    assert recorder.sent == []
    run_pulse_digests(repositories, MONDAY_SEND)

    assert [message.subject for message in recorder.sent] == ["Weekly Pulse for Acme"]
    assert "Early in the week" in recorder.sent[0].text


def test_a_reader_who_has_not_opted_in_or_turned_email_off_gets_none(
    repositories: Any, workspace: str, recorder: RecordingEmailSender
) -> None:
    """The digest is off by default, and the email switch overrides it."""
    _project(repositories, workspace, LED, "Launch", lead_id=MEMBER)
    _event(repositories, workspace, LED, TUESDAY_SEND - timedelta(hours=1), ADMIN, "News")
    _opt_in(repositories, MEMBER, "daily")
    repositories.users.update(MEMBER, email_notifications=False)

    assert run_pulse_digests(repositories, TUESDAY_SEND).due == 0
    assert recorder.sent == []


def test_a_project_on_a_team_the_reader_cannot_see_is_left_out(
    repositories: Any, workspace: str, recorder: RecordingEmailSender
) -> None:
    """A guest following a project outside their team gets nothing from it."""
    _project(repositories, workspace, LED, "Hidden", lead_id=GUEST, team_ids=[OTHER_TEAM])
    _event(repositories, workspace, LED, TUESDAY_SEND - timedelta(hours=1), ADMIN, "Secret")
    _opt_in(repositories, GUEST, "daily")

    summary = run_pulse_digests(repositories, TUESDAY_SEND)

    assert summary.empty == 1
    assert recorder.sent == []


def test_the_schedule_record_runs_the_sweep(repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """The flush schedule's synthetic record reaches the Pulse digest sweep when its window is due."""
    ran: list[datetime] = []
    monkeypatch.setattr("app.domains.views.consumers.pulse_digest.sweep_due", lambda repositories, now: True)
    monkeypatch.setattr(
        "app.domains.views.consumers.pulse_digest.run_pulse_digests",
        lambda repositories, now: ran.append(now),
    )

    handle_record(repositories, {"eventSource": NOTIFY_DIGEST_SOURCE, "eventName": "FLUSH", "eventID": "x"})

    assert len(ran) == 1
