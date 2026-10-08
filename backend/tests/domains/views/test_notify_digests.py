"""Notification email digests and the per event recipient cap.

The inbox row is written at once and the email is held, so these tests drive the
consumer and then the flush with a clock past the window, which is what the
minute schedule does in a deployed stack.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.identity.email import RecordingEmailSender

from app.common.core.config import settings
from app.common.db.dynamo.notify_digests import DIGEST_WINDOW, DigestEntry, window_start
from app.common.email import reset_email_sender
from app.domains.views.consumers import digest as digest_module
from app.domains.views.consumers import notify as notify_module
from app.domains.views.consumers.digest import NOTIFY_DIGEST_SOURCE, flush_due, flush_window
from app.domains.views.consumers.notify import MAX_RECIPIENTS_PER_EVENT, cap_recipients, handle_record
from app.domains.views.email import DIGEST_LINE_LIMIT, render_digest
from tests.domains.helpers import ADMIN, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import TEAM, seed_issue
from tests.domains.views.test_notify_consumer import COMMENTS_ARN, _image, _record, flush_digests, inbox_of
from tests.domains.views.test_notify_email import assignment
from tests.domains.views.test_notify_subscribers import comment_record, status_record


@pytest.fixture
def recorder() -> Iterator[RecordingEmailSender]:
    """A recording sender installed as the process-wide one for one test."""
    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


def _entry(number: int, **fields: Any) -> DigestEntry:
    """One held notification about issue `ENG-<number>`, stamped a second apart."""
    values: dict[str, Any] = {
        "workspace_id": "W1",
        "recipient_id": MEMBER,
        "notification_id": f"N{number:04d}",
        "kind": "commented",
        "team_id": TEAM,
        "actor_name": "Ada",
        "issue_id": f"I{number}",
        "issue_key": f"ENG-{number}",
        "issue_title": f"Issue {number}",
        "created_at": datetime(2026, 9, 28, 12, 0, tzinfo=timezone.utc) + timedelta(seconds=number),
    }
    values.update(fields)
    return DigestEntry(**values)


def test_a_burst_on_one_issue_becomes_one_email(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """An assignment, a comment and a status change in one window mail the assignee once."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Busy", assignee_id=MEMBER)

    handle_record(repositories, assignment(workspace, issue["id"]))
    handle_record(repositories, comment_record(repositories, workspace, issue["id"], OWNER, "01C000000000000000000009"))
    handle_record(repositories, status_record(workspace, issue["id"], OWNER, assignee=MEMBER))

    assert len(inbox_of(repositories, workspace, MEMBER)) == 3
    assert recorder.sent == []

    summary = flush_digests(repositories)

    assert (summary.windows, summary.sent) == (1, 1)
    [message] = recorder.sent
    assert message.to == "member@example.com"
    assert message.subject == f"[{issue['key']}] Busy"
    assert "You have 3 new notifications." in message.text
    assert "commented" in message.text
    assert message.tags == {"purpose": "notification", "kind": "digest"}


def test_a_digest_is_drawn_in_the_workspace_accent(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """A workspace with an accent mails its digests in that colour rather than the brand orange."""
    from app.common.email.brand import BRAND_ACCENT

    repositories.workspaces.set_accent_color(workspace, "#1d4ed8")
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Blue", assignee_id=MEMBER)

    handle_record(repositories, assignment(workspace, issue["id"]))
    flush_digests(repositories)

    [message] = recorder.sent
    assert 'bgcolor="#1d4ed8"' in message.html
    assert BRAND_ACCENT not in message.html


def test_a_digest_without_an_accent_keeps_the_brand_orange(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """No accent on the workspace means the default Standupless orange."""
    from app.common.email.brand import BRAND_ACCENT

    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Orange", assignee_id=MEMBER)

    handle_record(repositories, assignment(workspace, issue["id"]))
    flush_digests(repositories)

    [message] = recorder.sent
    assert f'bgcolor="{BRAND_ACCENT}"' in message.html


def test_activity_on_two_issues_is_listed_under_each(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """A window across issues gets a summary subject and a section per issue."""
    sign_in(issues_client, OWNER)
    first = seed_issue(issues_client, workspace, title="First", assignee_id=MEMBER)
    second = seed_issue(issues_client, workspace, title="Second", assignee_id=MEMBER)

    handle_record(repositories, assignment(workspace, first["id"]))
    handle_record(repositories, assignment(workspace, second["id"]))
    flush_digests(repositories)

    [message] = recorder.sent
    assert message.subject == f"2 new notifications in {settings.PROJECT_NAME}"
    assert f"{first['key']} First" in message.text
    assert f"{second['key']} Second" in message.text


def test_an_open_window_is_not_flushed(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """Nothing goes out until the window has closed and the grace has passed."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Waiting", assignee_id=MEMBER)

    handle_record(repositories, assignment(workspace, issue["id"]))
    summary = flush_due(repositories, now=datetime.now(timezone.utc))

    assert summary.windows == 0
    assert recorder.sent == []


def test_email_turned_off_during_the_window_is_honoured(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """The preference is read again at flush time, and the held entries are dropped."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Muted later", assignee_id=MEMBER)

    handle_record(repositories, assignment(workspace, issue["id"]))
    repositories.users.update(MEMBER, email_notifications=False)
    summary = flush_digests(repositories)

    assert (summary.windows, summary.sent, summary.skipped) == (1, 0, 1)
    assert recorder.sent == []
    assert flush_digests(repositories).windows == 0


def test_losing_the_team_during_the_window_drops_its_lines(
    issues_client: TestClient,
    workspace: str,
    repositories: Any,
    statuses: Any,
    recorder: RecordingEmailSender,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Visibility is checked again at flush time, so a removed member hears nothing more."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Private now", assignee_id=MEMBER)

    handle_record(repositories, assignment(workspace, issue["id"]))
    monkeypatch.setattr(notify_module, "can_receive", lambda *args, **kwargs: False)
    flush_digests(repositories)

    assert recorder.sent == []


def test_a_claimed_window_is_mailed_once(repositories: Any, workspace: str, recorder: RecordingEmailSender) -> None:
    """Two overlapping flushes race on the conditional delete, and only one sends."""
    store = repositories.inbox.digests
    store.add(_entry(1, workspace_id=workspace), now=datetime.now(timezone.utc) - timedelta(hours=1))
    [due] = store.due(datetime.now(timezone.utc), limit=10)

    assert store.claim(due) is True
    assert store.claim(due) is False
    assert flush_window(repositories, due) is False
    assert recorder.sent == []


def test_a_late_entry_in_a_flushed_window_is_mailed_alone(
    repositories: Any, workspace: str, recorder: RecordingEmailSender
) -> None:
    """Clearing after the send means a straggler re-opens the window with only itself."""
    store = repositories.inbox.digests
    moment = datetime.now(timezone.utc) - timedelta(hours=1)
    store.add(_entry(1, workspace_id=workspace), now=moment)
    store.add(_entry(2, workspace_id=workspace), now=moment)
    flush_digests(repositories)
    store.add(_entry(3, workspace_id=workspace), now=moment)
    flush_digests(repositories)

    assert [message.subject for message in recorder.sent] == [
        f"2 new notifications in {settings.PROJECT_NAME}",
        "[ENG-3] Issue 3",
    ]


def test_a_failed_compose_puts_the_window_back(
    repositories: Any, workspace: str, recorder: RecordingEmailSender, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failure before the send leaves the entries and the marker for the next run."""
    store = repositories.inbox.digests
    store.add(_entry(1, workspace_id=workspace), now=datetime.now(timezone.utc) - timedelta(hours=1))

    def broken(*args: Any, **kwargs: Any) -> Any:
        """Stand in for a render that fails."""
        raise RuntimeError("render failed")

    monkeypatch.setattr(digest_module, "render_digest", broken)
    assert flush_digests(repositories).failed == 1
    monkeypatch.undo()

    assert flush_digests(repositories).sent == 1
    assert [message.subject for message in recorder.sent] == ["[ENG-1] Issue 1"]


def test_windows_are_fixed_five_minute_buckets() -> None:
    """Two moments in one bucket share a window and the next bucket starts a new one."""
    start = datetime(2026, 9, 28, 12, 0, tzinfo=timezone.utc)

    assert window_start(start) == window_start(start + timedelta(minutes=4, seconds=59))
    assert window_start(start + DIGEST_WINDOW) == window_start(start) + int(DIGEST_WINDOW.total_seconds())


def test_the_schedule_record_runs_the_flush(repositories: Any, workspace: str, recorder: RecordingEmailSender) -> None:
    """The synthetic record carries no stream ARN and is routed to the flush first."""
    repositories.inbox.digests.add(
        _entry(1, workspace_id=workspace), now=datetime.now(timezone.utc) - timedelta(hours=1)
    )

    handle_record(repositories, {"eventSource": NOTIFY_DIGEST_SOURCE, "eventName": "FLUSH", "eventID": "x"})

    assert [message.subject for message in recorder.sent] == ["[ENG-1] Issue 1"]


def test_the_cap_keeps_the_first_recipients_and_logs_the_rest(caplog: pytest.LogCaptureFixture) -> None:
    """An audience past the cap is cut in order and the overflow is counted in the log."""
    audience = [f"U{number:03d}" for number in range(MAX_RECIPIENTS_PER_EVENT + 5)]

    with caplog.at_level(logging.WARNING):
        kept = cap_recipients(audience, workspace_id="W1", source="issue#I1")

    assert kept == audience[:MAX_RECIPIENTS_PER_EVENT]
    [entry] = [record for record in caplog.records if getattr(record, "event", "") == "views.notify.recipients_capped"]
    assert getattr(entry, "dropped") == 5
    assert cap_recipients(audience[:3], workspace_id="W1", source="issue#I1") == audience[:3]


def test_direct_recipients_come_before_the_cap(
    issues_client: TestClient,
    workspace: str,
    repositories: Any,
    statuses: Any,
    recorder: RecordingEmailSender,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With room for one, the mentioned member is kept over the assignee and gets both channels."""
    monkeypatch.setattr(notify_module, "MAX_RECIPIENTS_PER_EVENT", 1)
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Crowded", assignee_id=MEMBER)

    handle_record(
        repositories,
        _record(
            COMMENTS_ARN,
            "INSERT",
            new=_image(
                workspace_id=workspace,
                issue_id=issue["id"],
                comment_id="01C000000000000000000007",
                author_id=OWNER,
                mentions=[ADMIN],
            ),
        ),
    )
    flush_digests(repositories)

    assert [row["kind"] for row in inbox_of(repositories, workspace, ADMIN)] == ["mentioned"]
    assert inbox_of(repositories, workspace, MEMBER) == []
    assert [message.to for message in recorder.sent] == ["admin@example.com"]


def test_a_digest_escapes_what_members_wrote() -> None:
    """Titles and excerpts are member input, so the HTML part escapes them."""
    entries = [
        _entry(1, issue_title="<script>x</script>", excerpt="a <b>bold</b> claim"),
        _entry(2, issue_title="<script>x</script>", issue_id="I1", issue_key="ENG-1"),
    ]

    message = render_digest(entries, to="member@example.com", workspace_slug="acme")

    assert "<script>" not in (message.html or "")
    assert "&lt;script&gt;" in (message.html or "")
    assert "&lt;b&gt;bold&lt;/b&gt;" in (message.html or "")


def test_a_long_digest_points_at_the_inbox() -> None:
    """Past the line limit the email stops listing and counts the rest."""
    entries = [_entry(number) for number in range(DIGEST_LINE_LIMIT + 7)]

    message = render_digest(entries, to="member@example.com", workspace_slug="acme")

    assert f"You have {DIGEST_LINE_LIMIT + 7} new notifications." in message.text
    assert "And 7 more in your inbox." in message.text
    assert f"ENG-{DIGEST_LINE_LIMIT + 6} " not in message.text


def test_a_project_update_line_names_the_health() -> None:
    """A project update in a mixed window says who posted and how the project stands."""
    entries = [
        _entry(1),
        _entry(2, kind="project_update", project_id="P1", project_name="Launch", health="at_risk", issue_id=""),
    ]

    message = render_digest(entries, to="member@example.com", workspace_slug="acme")

    assert "Project: Launch" in message.text
    assert "Ada posted a project update." in message.text
