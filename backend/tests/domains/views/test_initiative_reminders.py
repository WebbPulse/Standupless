"""The initiative update reminders the project reminder sweep also sends.

The properties held are that an initiative's owner gets one reminder when its
update comes due and one more when it goes overdue, however many passes run;
that an off cadence, a missing owner, a guest owner, a completed initiative and
a long stale stage get none; that the owner's preferences are honoured; and
that the reminder reaches the inbox and the email digest as a workspace level
subject with no team.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

import pytest
from webbpulse.identity.email import RecordingEmailSender

from app.common.api.schemas.views import NotificationRead
from app.common.db.dynamo.inbox import Notification
from app.common.db.dynamo.notify_digests import DigestEntry
from app.common.db.dynamo.planning import Initiative, initiative_key
from app.common.email import reset_email_sender
from app.common.project_cadence import OVERDUE_GRACE
from app.domains.views.consumers.notify import can_receive
from app.domains.views.consumers.project_reminders import REMINDER_WINDOW, run_reminders
from app.domains.views.email import render_digest
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER
from tests.domains.views.conftest import TEAM
from tests.domains.views.test_notify_consumer import flush_digests, inbox_of

INITIATIVE_ID = "01JB000000000000000000INIT"

CREATED = datetime(2026, 9, 1, 9, 0, tzinfo=timezone.utc)

DUE = CREATED + timedelta(days=7)

OVERDUE = DUE + OVERDUE_GRACE

KIND = "initiative_update_due"


@pytest.fixture
def recorder() -> Iterator[RecordingEmailSender]:
    """A recording sender installed as the process-wide one for one test."""
    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


def _initiative(repositories: Any, workspace: str, **fields: Any) -> Initiative:
    """Store one active initiative owned by `MEMBER`, made at `CREATED`."""
    values: dict[str, Any] = {
        "name": "Expand to Europe",
        "status": "active",
        "owner_id": MEMBER,
        "created_by": OWNER,
        "created_at": CREATED,
    }
    values.update(fields)
    initiative = Initiative(
        workspace_id=workspace,
        planning_key=initiative_key(INITIATIVE_ID),
        initiative_id=INITIATIVE_ID,
        **values,
    )
    return repositories.planning.create_initiative(initiative)


def _change(repositories: Any, workspace: str, **fields: Any) -> None:
    """Rewrite the stored initiative with `fields` changed."""
    current = repositories.planning.get_initiative(workspace, INITIATIVE_ID)
    repositories.planning.replace_initiative(current.model_copy(update=fields))


def _reminders(repositories: Any, workspace: str, user_id: str) -> list[dict[str, Any]]:
    """The initiative reminder rows one member holds, newest first."""
    return [row for row in inbox_of(repositories, workspace, user_id) if row["kind"] == KIND]


def test_the_owner_gets_one_due_reminder_however_many_passes_run(
    repositories: Any, workspace: str, recorder: RecordingEmailSender
) -> None:
    """Three passes inside the due stage write one workspace level row and mail it once."""
    _initiative(repositories, workspace)

    first = run_reminders(repositories, DUE + timedelta(minutes=5))
    run_reminders(repositories, DUE + timedelta(hours=1))
    run_reminders(repositories, DUE + timedelta(days=2))
    flush_digests(repositories)

    assert (first.initiatives_due, first.initiatives_notified) == (1, 1)
    [row] = _reminders(repositories, workspace, MEMBER)
    assert row["initiative_id"] == INITIATIVE_ID
    assert row["initiative_name"] == "Expand to Europe"
    assert row["due_state"] == "due"
    assert row["team_id"] == ""
    assert row["actor_id"] == ""
    [message] = recorder.sent
    assert message.subject == "[Initiative] Expand to Europe"
    assert "An initiative update is due." in message.text
    assert f"/initiatives/{INITIATIVE_ID}?tab=updates" in message.text


def test_an_overdue_update_sends_a_second_reminder_once(
    repositories: Any, workspace: str, recorder: RecordingEmailSender
) -> None:
    """Going overdue is its own stage, reminded once on top of the due reminder."""
    _initiative(repositories, workspace)

    run_reminders(repositories, DUE + timedelta(minutes=1))
    flush_digests(repositories)
    overdue = run_reminders(repositories, OVERDUE + timedelta(minutes=1))
    run_reminders(repositories, OVERDUE + timedelta(days=1))
    flush_digests(repositories)

    assert overdue.initiatives_notified == 1
    rows = _reminders(repositories, workspace, MEMBER)
    assert sorted(row["due_state"] for row in rows) == ["due", "overdue"]
    assert len(recorder.sent) == 2
    assert "An initiative update is overdue." in recorder.sent[-1].text


def test_a_pass_that_starts_overdue_sends_only_the_overdue_reminder(repositories: Any, workspace: str) -> None:
    """A sweep that first sees the initiative past its grace skips the due stage."""
    _initiative(repositories, workspace)

    run_reminders(repositories, OVERDUE + timedelta(hours=1))

    [row] = _reminders(repositories, workspace, MEMBER)
    assert row["due_state"] == "overdue"


def test_nothing_is_sent_before_the_due_date(repositories: Any, workspace: str) -> None:
    """A pass a second early writes nothing."""
    _initiative(repositories, workspace)

    summary = run_reminders(repositories, DUE - timedelta(seconds=1))

    assert summary.initiatives_due == 0
    assert _reminders(repositories, workspace, MEMBER) == []


def test_a_deleted_reminder_is_not_sent_again(repositories: Any, workspace: str) -> None:
    """The marker outlives the row, so deleting the reminder does not bring it back."""
    _initiative(repositories, workspace)
    run_reminders(repositories, DUE + timedelta(minutes=1))
    [row] = _reminders(repositories, workspace, MEMBER)

    assert repositories.inbox.delete(workspace, MEMBER, row["notification_id"])
    summary = run_reminders(repositories, DUE + timedelta(hours=2))

    assert summary.initiatives_due == 0
    assert _reminders(repositories, workspace, MEMBER) == []


def test_an_off_cadence_is_never_reminded(repositories: Any, workspace: str) -> None:
    """Off on the initiative wins over the workspace default, and off on the workspace is inherited."""
    _initiative(repositories, workspace, update_interval_days=0)
    run_reminders(repositories, OVERDUE + timedelta(hours=1))
    assert _reminders(repositories, workspace, MEMBER) == []

    _change(repositories, workspace, update_interval_days=None)
    repositories.workspaces.set_project_update_interval(workspace, 0)
    run_reminders(repositories, OVERDUE + timedelta(hours=2))
    assert _reminders(repositories, workspace, MEMBER) == []


def test_the_initiative_cadence_overrides_the_workspace_default(repositories: Any, workspace: str) -> None:
    """A thirty day initiative is not due at seven days, and is at thirty."""
    _initiative(repositories, workspace, update_interval_days=30)

    run_reminders(repositories, DUE + timedelta(hours=1))
    assert _reminders(repositories, workspace, MEMBER) == []

    run_reminders(repositories, CREATED + timedelta(days=30, minutes=1))
    assert len(_reminders(repositories, workspace, MEMBER)) == 1


def test_an_initiative_with_no_owner_reminds_nobody(repositories: Any, workspace: str) -> None:
    """The stage is marked, but no member gets a row."""
    _initiative(repositories, workspace, owner_id=None)

    summary = run_reminders(repositories, DUE + timedelta(hours=1))
    again = run_reminders(repositories, DUE + timedelta(hours=2))

    assert (summary.initiatives_due, summary.initiatives_notified) == (1, 0)
    assert again.initiatives_due == 0
    for user_id in (OWNER, ADMIN, MEMBER, GUEST):
        assert _reminders(repositories, workspace, user_id) == []


def test_a_guest_owner_is_never_reminded(repositories: Any, workspace: str, recorder: RecordingEmailSender) -> None:
    """A guest cannot see initiatives, so a guest owner gets neither the row nor the email."""
    _initiative(repositories, workspace, owner_id=GUEST)

    run_reminders(repositories, OVERDUE + timedelta(hours=1))
    flush_digests(repositories)

    assert _reminders(repositories, workspace, GUEST) == []
    assert recorder.sent == []


def test_an_owner_who_left_the_workspace_is_never_reminded(repositories: Any, workspace: str) -> None:
    """Someone with no membership is not a workspace member, whatever the initiative says."""
    _initiative(repositories, workspace, owner_id="01JB0000000000000000STRNGR")

    summary = run_reminders(repositories, DUE + timedelta(hours=1))

    assert summary.initiatives_notified == 0


def test_a_completed_initiative_is_never_reminded(repositories: Any, workspace: str) -> None:
    """A completed initiative never comes due."""
    _initiative(repositories, workspace, status="completed")

    run_reminders(repositories, OVERDUE + timedelta(hours=1))

    assert _reminders(repositories, workspace, MEMBER) == []


def test_a_long_stale_stage_is_left_alone(repositories: Any, workspace: str) -> None:
    """An overdue stage that began more than the window ago sends nothing."""
    _initiative(repositories, workspace)

    summary = run_reminders(repositories, OVERDUE + REMINDER_WINDOW + timedelta(minutes=1))

    assert summary.initiatives_due == 0
    assert _reminders(repositories, workspace, MEMBER) == []


def test_posting_an_update_starts_a_new_due_date(repositories: Any, workspace: str) -> None:
    """An update moves the next due date a full interval out, which is reminded afresh."""
    _initiative(repositories, workspace)
    run_reminders(repositories, DUE + timedelta(minutes=1))

    posted = DUE + timedelta(days=1)
    _change(repositories, workspace, last_update_at=posted)
    quiet = run_reminders(repositories, OVERDUE + timedelta(minutes=1))
    later = run_reminders(repositories, posted + timedelta(days=7, minutes=1))

    assert quiet.initiatives_due == 0
    assert later.initiatives_notified == 1
    assert [row["due_state"] for row in _reminders(repositories, workspace, MEMBER)] == ["due", "due"]


def test_the_preferences_are_honoured(repositories: Any, workspace: str, recorder: RecordingEmailSender) -> None:
    """Both channels off writes nothing, and email off alone keeps the inbox row unmailed."""
    _initiative(repositories, workspace)
    repositories.users.update(MEMBER, notification_preferences={KIND: {"in_app": False, "email": False}})

    run_reminders(repositories, DUE + timedelta(hours=1))
    flush_digests(repositories)
    assert _reminders(repositories, workspace, MEMBER) == []

    repositories.users.update(MEMBER, notification_preferences={KIND: {"in_app": True, "email": False}})
    run_reminders(repositories, OVERDUE + timedelta(hours=1))
    flush_digests(repositories)

    [row] = _reminders(repositories, workspace, MEMBER)
    assert row["due_state"] == "overdue"
    assert recorder.sent == []


def test_a_workspace_level_subject_is_visible_to_members_and_not_guests(repositories: Any, workspace: str) -> None:
    """An empty team reads as the workspace: every member but a guest, and nobody outside."""
    assert can_receive(repositories, workspace, "", MEMBER)
    assert can_receive(repositories, workspace, "", OWNER)
    assert not can_receive(repositories, workspace, "", GUEST)
    assert not can_receive(repositories, workspace, "", "01JB0000000000000000STRNGR")
    assert can_receive(repositories, workspace, TEAM, GUEST)


def test_the_inbox_shape_carries_the_initiative() -> None:
    """The read shape names the initiative and whether the update is due or overdue."""
    row = Notification(
        ws_user=f"W1#{MEMBER}",
        notification_id="N1",
        workspace_id="W1",
        kind=KIND,
        team_id="",
        initiative_id=INITIATIVE_ID,
        initiative_name="Expand to Europe",
        due_state="overdue",
        actor_id="",
        actor_name="",
        recipient_id=MEMBER,
        created_at=OVERDUE,
        unread_at=OVERDUE.isoformat(),
        expires_at=0,
    )

    read = NotificationRead.from_row(row)

    assert read.kind == KIND
    assert read.initiative_id == INITIATIVE_ID
    assert read.initiative_name == "Expand to Europe"
    assert read.due_state == "overdue"
    assert read.team_id == ""


def test_a_digest_line_names_the_initiative() -> None:
    """Grouped under the initiative, apart from the project notifications."""
    entries = [
        DigestEntry(
            workspace_id="W1",
            recipient_id=MEMBER,
            notification_id="N1",
            kind=KIND,
            team_id="",
            initiative_id=INITIATIVE_ID,
            initiative_name="Expand to Europe",
            due_state="overdue",
            created_at=CREATED,
        ),
        DigestEntry(
            workspace_id="W1",
            recipient_id=MEMBER,
            notification_id="N2",
            kind="project_update_due",
            team_id=TEAM,
            project_id="P1",
            project_name="Launch",
            created_at=CREATED + timedelta(seconds=1),
        ),
    ]

    message = render_digest(entries, to="member@example.com", workspace_slug="acme")

    assert message.subject.startswith("2 new notifications")
    assert "Initiative: Expand to Europe" in message.text
    assert "An initiative update is overdue." in message.text
    assert "Project: Launch" in message.text
