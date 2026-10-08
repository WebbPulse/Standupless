"""SLA notices: the assignee hears once when an SLA turns at risk and once when it breaches.

They ride the hourly due date sweep, so these drive `run_due_reminders` with a
fixed clock against issues whose timers are set straight in the table.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.identity.email import RecordingEmailSender

from app.common.db.dynamo.team_config import default_sla_settings
from app.common.email import reset_email_sender
from app.domains.views.consumers.due_reminders import (
    OVERDUE_WINDOW,
    SLA_AT_RISK,
    SLA_BREACHED,
    run_due_reminders,
    sla_notice_for,
)
from tests.domains.helpers import MEMBER, OWNER, sign_in
from tests.domains.views.conftest import TEAM, seed_issue
from tests.domains.views.test_notify_consumer import flush_digests, inbox_of

START = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)

BREACH = START + timedelta(hours=24)

AT_RISK = START + timedelta(hours=18)


@pytest.fixture
def recorder() -> Iterator[RecordingEmailSender]:
    """A recording sender installed as the process-wide one for one test."""
    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


def _notices(repositories: Any, workspace: str, user_id: str) -> list[dict[str, Any]]:
    """The SLA notice rows one member holds, oldest first."""
    rows = [row for row in inbox_of(repositories, workspace, user_id) if row["kind"] in (SLA_AT_RISK, SLA_BREACHED)]
    return list(reversed(rows))


def _timed_issue(issues_client: TestClient, repositories: Any, workspace: str, **payload: Any) -> dict[str, Any]:
    """An urgent issue of `TEAM` assigned to `MEMBER`, its day-long timer started at `START`."""
    repositories.team_config.put_sla_settings(
        default_sla_settings(workspace, TEAM).model_copy(update={"enabled": True})
    )
    sign_in(issues_client, OWNER)
    body: dict[str, Any] = {"title": "Fix prod", "assignee_id": MEMBER, "priority": "urgent"}
    body.update(payload)
    issue = seed_issue(issues_client, workspace, **body)
    row = repositories.issues.get(workspace, issue["id"])
    repositories.issues.replace(row.model_copy(update={"sla_started_at": START, "sla_breaches_at": BREACH}))
    return issue


def test_the_window_of_each_notice(issues_client: TestClient, repositories: Any, workspace: str, statuses: Any) -> None:
    """Nothing on track, at risk from the last quarter, breached until the window closes."""
    issue = _timed_issue(issues_client, repositories, workspace)
    row = repositories.issues.get(workspace, issue["id"])

    assert sla_notice_for(row, AT_RISK - timedelta(minutes=1)) is None
    assert sla_notice_for(row, AT_RISK) == (SLA_AT_RISK, AT_RISK)
    assert sla_notice_for(row, BREACH) == (SLA_BREACHED, BREACH)
    assert sla_notice_for(row, BREACH + OVERDUE_WINDOW) == (SLA_BREACHED, BREACH)
    assert sla_notice_for(row, BREACH + OVERDUE_WINDOW + timedelta(hours=1)) is None


def test_the_assignee_hears_once_at_risk_and_once_at_breach(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """Repeated passes write one at risk and one breached row, each mailed."""
    issue = _timed_issue(issues_client, repositories, workspace)

    quiet = run_due_reminders(repositories, AT_RISK - timedelta(hours=1))
    first = run_due_reminders(repositories, AT_RISK + timedelta(minutes=5))
    run_due_reminders(repositories, AT_RISK + timedelta(hours=1))
    flush_digests(repositories)
    later = run_due_reminders(repositories, BREACH + timedelta(minutes=5))
    run_due_reminders(repositories, BREACH + timedelta(hours=2))
    flush_digests(repositories)

    assert (quiet.sla_at_risk, quiet.sla_breached) == (0, 0)
    assert (first.sla_at_risk, first.sla_breached) == (1, 0)
    assert (later.sla_at_risk, later.sla_breached) == (0, 1)
    at_risk, breached = _notices(repositories, workspace, MEMBER)
    assert at_risk["kind"] == SLA_AT_RISK
    assert breached["kind"] == SLA_BREACHED
    assert at_risk["issue_id"] == issue["id"]
    assert at_risk["team_id"] == TEAM
    assert at_risk["actor_id"] == ""
    texts = " ".join(message.text for message in recorder.sent)
    assert "This issue assigned to you is close to breaching its SLA." in texts
    assert "This issue assigned to you has breached its SLA." in texts


def test_a_long_breached_issue_is_left_alone(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any
) -> None:
    """Past the window, the first sweep sends nothing."""
    _timed_issue(issues_client, repositories, workspace)

    summary = run_due_reminders(repositories, BREACH + OVERDUE_WINDOW + timedelta(hours=2))

    assert (summary.sla_at_risk, summary.sla_breached) == (0, 0)
    assert _notices(repositories, workspace, MEMBER) == []


def test_an_unassigned_issue_sends_nothing(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any
) -> None:
    """With nobody to tell, a breach goes unannounced."""
    _timed_issue(issues_client, repositories, workspace, assignee_id=None)

    summary = run_due_reminders(repositories, BREACH + timedelta(hours=1))

    assert summary.sla_breached == 0


def test_a_moved_deadline_arms_fresh_notices(
    issues_client: TestClient, repositories: Any, workspace: str, statuses: Any
) -> None:
    """A deadline pushed out after an at risk notice earns another when it nears again."""
    issue = _timed_issue(issues_client, repositories, workspace)
    run_due_reminders(repositories, AT_RISK + timedelta(minutes=5))
    row = repositories.issues.get(workspace, issue["id"])
    repositories.issues.replace(row.model_copy(update={"sla_breaches_at": START + timedelta(hours=72)}))

    summary = run_due_reminders(repositories, START + timedelta(hours=60))

    assert summary.sla_at_risk == 1
    assert [row["kind"] for row in _notices(repositories, workspace, MEMBER)] == [SLA_AT_RISK, SLA_AT_RISK]
