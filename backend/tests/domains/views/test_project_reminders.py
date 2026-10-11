"""The project update reminder sweep the digest flush schedule runs every quarter hour.

The properties held are that a due project's lead gets one reminder per due date
however many passes run, even after deleting it; that exempt statuses, an off
cadence, a lead who cannot see the project and a long stale due date get none;
that posting an update starts a new due date; and that the due hook hears each
due date once.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

import pytest
from webbpulse.identity.email import RecordingEmailSender

from app.common.db.dynamo.planning import Project, project_key
from app.common.email import reset_email_sender
from app.common.project_cadence import (
    ProjectUpdateDue,
    register_update_due_listener,
    unregister_update_due_listener,
)
from app.domains.views.consumers.digest import NOTIFY_DIGEST_SOURCE
from app.domains.views.consumers.notify import handle_record
from app.domains.views.consumers.project_reminders import REMINDER_WINDOW, run_reminders, sweep_due
from app.domains.views.email import render_digest
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER
from tests.domains.views.conftest import OTHER_TEAM, TEAM
from tests.domains.views.test_notify_consumer import flush_digests, inbox_of

PROJECT_ID = "01JB000000000000000000PRJR"

CREATED = datetime(2026, 9, 1, 9, 0, tzinfo=timezone.utc)

DUE = CREATED + timedelta(days=7)


@pytest.fixture
def recorder() -> Iterator[RecordingEmailSender]:
    """A recording sender installed as the process-wide one for one test."""
    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


@pytest.fixture
def heard() -> Iterator[list[ProjectUpdateDue]]:
    """Every due event the hook hands out during one test."""
    events: list[ProjectUpdateDue] = []
    register_update_due_listener(events.append)
    yield events
    unregister_update_due_listener(events.append)


def _project(repositories: Any, workspace: str, **fields: Any) -> Project:
    """Store one in progress project led by `MEMBER`, made at `CREATED`."""
    values: dict[str, Any] = {
        "team_ids": [TEAM],
        "name": "Launch",
        "status": "in_progress",
        "lead_id": MEMBER,
        "created_by": OWNER,
        "created_at": CREATED,
    }
    values.update(fields)
    project = Project(workspace_id=workspace, planning_key=project_key(PROJECT_ID), project_id=PROJECT_ID, **values)
    return repositories.planning.create_project(project)


def _reminders(repositories: Any, workspace: str, user_id: str) -> list[dict[str, Any]]:
    """The reminder rows one member holds."""
    return [row for row in inbox_of(repositories, workspace, user_id) if row["kind"] == "project_update_due"]


def test_the_lead_gets_one_reminder_however_many_passes_run(
    repositories: Any, workspace: str, recorder: RecordingEmailSender, heard: list[ProjectUpdateDue]
) -> None:
    """Three passes past the due date write one row, mail it once and emit once."""
    _project(repositories, workspace)

    first = run_reminders(repositories, DUE + timedelta(minutes=5))
    run_reminders(repositories, DUE + timedelta(hours=1))
    run_reminders(repositories, DUE + timedelta(days=4))
    flush_digests(repositories)

    assert (first.due, first.notified) == (1, 1)
    [row] = _reminders(repositories, workspace, MEMBER)
    assert row["project_id"] == PROJECT_ID
    assert row["project_name"] == "Launch"
    assert row["team_id"] == TEAM
    assert row["actor_id"] == ""
    [message] = recorder.sent
    assert message.subject == "[Project] Launch"
    assert "A project update is due." in message.text
    assert f"/projects/{PROJECT_ID}?tab=updates" in message.text
    assert [event.project_id for event in heard] == [PROJECT_ID]
    assert heard[0].due_at == DUE


def test_a_deleted_reminder_is_not_sent_again(repositories: Any, workspace: str) -> None:
    """The marker outlives the row, so deleting the reminder does not bring it back."""
    _project(repositories, workspace)
    run_reminders(repositories, DUE + timedelta(minutes=1))
    [row] = _reminders(repositories, workspace, MEMBER)

    assert repositories.inbox.delete(workspace, MEMBER, row["notification_id"])
    summary = run_reminders(repositories, DUE + timedelta(hours=2))

    assert summary.due == 0
    assert _reminders(repositories, workspace, MEMBER) == []


def test_nothing_is_sent_before_the_due_date(repositories: Any, workspace: str) -> None:
    """A pass a second early writes nothing."""
    _project(repositories, workspace)

    summary = run_reminders(repositories, DUE - timedelta(seconds=1))

    assert summary.due == 0
    assert _reminders(repositories, workspace, MEMBER) == []


@pytest.mark.parametrize("status", ["completed", "canceled", "paused"])
def test_exempt_statuses_are_never_reminded(repositories: Any, workspace: str, status: str) -> None:
    """Completed, canceled and paused projects never come due."""
    _project(repositories, workspace, status=status)

    run_reminders(repositories, DUE + timedelta(hours=1))

    assert _reminders(repositories, workspace, MEMBER) == []


def test_an_off_cadence_is_never_reminded(repositories: Any, workspace: str) -> None:
    """Off on the project wins over the workspace default, and off on the workspace is inherited."""
    _project(repositories, workspace, update_interval_days=0)
    run_reminders(repositories, DUE + timedelta(hours=1))
    assert _reminders(repositories, workspace, MEMBER) == []

    repositories.planning.delete(workspace, project_key(PROJECT_ID))
    _project(repositories, workspace)
    repositories.workspaces.set_project_update_interval(workspace, 0)
    run_reminders(repositories, DUE + timedelta(hours=1))
    assert _reminders(repositories, workspace, MEMBER) == []


def test_the_workspace_default_sets_the_due_date(repositories: Any, workspace: str) -> None:
    """A monthly workspace is not due at seven days, and is at thirty."""
    _project(repositories, workspace)
    repositories.workspaces.set_project_update_interval(workspace, 30)

    assert run_reminders(repositories, DUE + timedelta(hours=1)).due == 0
    assert run_reminders(repositories, CREATED + timedelta(days=30, minutes=1)).notified == 1


def test_posting_an_update_starts_a_new_due_date(repositories: Any, workspace: str) -> None:
    """Each due date is reminded once, and the next one is counted from the latest update."""
    _project(repositories, workspace)
    run_reminders(repositories, DUE + timedelta(hours=1))

    posted = DUE + timedelta(days=1)
    repositories.planning.record_project_health(workspace, PROJECT_ID, health="on_track", last_update_at=posted)
    run_reminders(repositories, posted + timedelta(days=7, minutes=1))

    assert len(_reminders(repositories, workspace, MEMBER)) == 2


def test_a_stale_due_date_is_left_alone(repositories: Any, workspace: str) -> None:
    """A project untouched for months is not mailed when the sweep first sees it."""
    _project(repositories, workspace)

    summary = run_reminders(repositories, DUE + REMINDER_WINDOW + timedelta(minutes=1))

    assert summary.due == 0


def test_a_lead_who_cannot_see_the_project_is_not_reminded(
    repositories: Any, workspace: str, heard: list[ProjectUpdateDue]
) -> None:
    """A guest lead outside every team of the project gets nothing, while the hook still hears it."""
    _project(repositories, workspace, team_ids=[OTHER_TEAM], lead_id=GUEST)

    summary = run_reminders(repositories, DUE + timedelta(hours=1))

    assert (summary.due, summary.notified) == (1, 0)
    assert _reminders(repositories, workspace, GUEST) == []
    assert len(heard) == 1


def test_a_project_with_no_lead_still_emits(repositories: Any, workspace: str, heard: list[ProjectUpdateDue]) -> None:
    """No inbox row without a lead, but a team webhook hears the due date once."""
    _project(repositories, workspace, lead_id=None)

    run_reminders(repositories, DUE + timedelta(hours=1))
    run_reminders(repositories, DUE + timedelta(hours=2))

    assert [event.lead_id for event in heard] == [None]
    for user_id in (OWNER, ADMIN, MEMBER):
        assert _reminders(repositories, workspace, user_id) == []


def test_the_in_app_preference_is_honoured(repositories: Any, workspace: str, recorder: RecordingEmailSender) -> None:
    """Both channels off for the kind writes nothing."""
    _project(repositories, workspace)
    repositories.users.update(
        MEMBER, notification_preferences={"project_update_due": {"in_app": False, "email": False}}
    )

    run_reminders(repositories, DUE + timedelta(hours=1))
    flush_digests(repositories)

    assert _reminders(repositories, workspace, MEMBER) == []
    assert recorder.sent == []


def test_the_sweep_runs_every_quarter_hour(repositories: Any) -> None:
    """The minute flush runs the sweep on the first tick of each quarter hour alone."""
    hour = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)
    ran = [minute for minute in range(60) if sweep_due(repositories, hour.replace(minute=minute))]
    assert ran == [0, 15, 30, 45]


def test_a_late_tick_still_runs_the_sweep(repositories: Any) -> None:
    """A quarter hour whose first tick is late still gets its pass."""
    hour = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)
    assert sweep_due(repositories, hour)

    assert sweep_due(repositories, hour.replace(minute=17))
    assert not sweep_due(repositories, hour.replace(minute=18))


def test_the_schedule_record_runs_the_sweep(repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """The flush schedule's synthetic record reaches the sweep on a quarter hour."""
    _project(repositories, workspace, created_at=datetime.now(timezone.utc) - timedelta(days=7, hours=1))
    monkeypatch.setattr("app.domains.views.consumers.project_reminders.sweep_due", lambda repositories, now: True)

    handle_record(repositories, {"eventSource": NOTIFY_DIGEST_SOURCE, "eventName": "FLUSH", "eventID": "x"})

    assert len(_reminders(repositories, workspace, MEMBER)) == 1


def test_a_digest_line_names_the_reminder() -> None:
    """Grouped under the project with the other project notifications."""
    from app.common.db.dynamo.notify_digests import DigestEntry

    entries = [
        DigestEntry(
            workspace_id="W1",
            recipient_id=MEMBER,
            notification_id=f"N{number}",
            kind=kind,
            team_id=TEAM,
            actor_name="Ada",
            project_id=PROJECT_ID,
            project_name="Launch",
            health="on_track",
            created_at=CREATED + timedelta(seconds=number),
        )
        for number, kind in enumerate(("project_update_due", "project_update"))
    ]

    message = render_digest(entries, to="member@example.com", workspace_slug="acme")

    assert "Project: Launch" in message.text
    assert "A project update is due." in message.text
