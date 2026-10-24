"""The recurring issue sweep, run against real tables under a fixed clock.

The properties worth holding are that a due schedule creates one issue from its
template as its creator, that a schedule which missed several runs catches up
once, that a second sweep at the same moment creates nothing, that a paused
schedule is skipped, that a deleted template or a departed creator pauses the
schedule with the reason, and that the hourly trigger record runs the sweep.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

import pytest

from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import default_triage_settings
from app.common.db.dynamo.team_recurring import RecurringIssue, recurring_key
from app.common.db.dynamo.team_templates import IssueTemplate, template_key
from app.common.recurring_issues import CREATOR_GONE, TEMPLATE_GONE
from app.domains.issues.consumers.rollup import handle_record
from app.domains.issues.cycle_close import CYCLE_CLOSE_SOURCE
from app.domains.issues.recurring import sweep
from tests.domains.helpers import MEMBER, add_team_member, make_user
from tests.domains.issues.conftest import TEAM, WORKSPACE

NOW = datetime(2026, 10, 12, 9, 7, tzinfo=timezone.utc)

TEMPLATE = "01JB0000000000000000000TPL"

RECURRING = "01JB0000000000000000000REC"


@pytest.fixture
def schedule(repositories: Any, workspace: str) -> RecurringIssue:
    """A daily 09:00 UTC schedule from a team template, made by a member and due now."""
    make_user(repositories, MEMBER, "member@example.com", "Mia Member")
    repositories.team_config.create_template(
        IssueTemplate(
            workspace_id=WORKSPACE,
            config_key=template_key(TEAM, TEMPLATE),
            template_id=TEMPLATE,
            team_id=TEAM,
            name="Daily triage",
            title="Triage the inbox",
            body="Sweep new issues.",
            priority="high",
        )
    )
    return _put(repositories, next_run_at=datetime(2026, 10, 12, 9, 0, tzinfo=timezone.utc))


def _put(repositories: Any, **fields: Any) -> RecurringIssue:
    """Store the schedule with any fields replaced."""
    row = RecurringIssue(
        workspace_id=WORKSPACE,
        config_key=recurring_key(TEAM, RECURRING),
        recurring_id=RECURRING,
        team_id=TEAM,
        template_id=TEMPLATE,
        frequency="daily",
        time="09:00",
        timezone="UTC",
        starts_on=date(2026, 10, 1),
        created_by=MEMBER,
    ).model_copy(update=fields)
    if repositories.team_config.get_recurring(WORKSPACE, TEAM, RECURRING) is None:
        return repositories.team_config.create_recurring(row)
    stored = repositories.team_config.replace_recurring(row)
    assert stored is not None
    return stored


def _stored(repositories: Any) -> RecurringIssue:
    """The schedule as the table holds it now."""
    row = repositories.team_config.get_recurring(WORKSPACE, TEAM, RECURRING)
    assert row is not None
    return row


def _issues(repositories: Any) -> list[Issue]:
    """Every issue of the team."""
    page = repositories.issues.list_for_team(WORKSPACE, TEAM)
    return [Issue.model_validate(dict(item)) for item in page.items]


def test_a_due_schedule_creates_one_issue_from_its_template(repositories: Any, schedule: RecurringIssue) -> None:
    """The issue carries the template's title and fields, made by the schedule's creator."""
    summary = sweep(repositories, now=NOW)

    assert (summary.due, summary.created) == (1, 1)
    [issue] = _issues(repositories)
    assert issue.title == "Triage the inbox"
    assert issue.priority == "high"
    assert issue.created_by == MEMBER
    stored = _stored(repositories)
    assert stored.next_run_at == datetime(2026, 10, 13, 9, 0, tzinfo=timezone.utc)
    assert stored.last_issue_id == issue.issue_id
    assert stored.last_issue_key == issue.key
    assert stored.last_run_at is not None


def test_a_due_schedule_files_into_triage_while_the_team_has_it_on(repositories: Any, schedule: RecurringIssue) -> None:
    """A template with no status leaves the new issue in triage, even from a team member."""
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "member")
    repositories.team_config.put_triage_settings(
        default_triage_settings(WORKSPACE, TEAM).model_copy(update={"enabled": True})
    )

    sweep(repositories, now=NOW)

    issue_id = _stored(repositories).last_issue_id
    assert issue_id is not None
    stored = repositories.issues.get(WORKSPACE, issue_id)
    assert stored is not None and stored.in_triage is True


def test_a_second_sweep_at_the_same_moment_creates_nothing(repositories: Any, schedule: RecurringIssue) -> None:
    """The claim moved the next run on, so a retried sweep finds nothing due."""
    sweep(repositories, now=NOW)
    again = sweep(repositories, now=NOW)

    assert again.due == 0
    assert len(_issues(repositories)) == 1


def test_a_stale_claim_loses(repositories: Any, schedule: RecurringIssue) -> None:
    """A sweep holding a read from before another sweep's claim skips rather than creating twice."""
    from app.common.recurring_issues import run_due

    first, _ = run_due(repositories, schedule, NOW)
    second, issue = run_due(repositories, schedule, NOW)

    assert (first, second, issue) == ("created", "skipped", None)
    assert len(_issues(repositories)) == 1


def test_missed_runs_catch_up_once(repositories: Any, schedule: RecurringIssue) -> None:
    """A schedule five days behind creates one issue and moves to the next run after now."""
    _put(repositories, next_run_at=NOW - timedelta(days=5))

    summary = sweep(repositories, now=NOW)

    assert summary.created == 1
    assert len(_issues(repositories)) == 1
    assert _stored(repositories).next_run_at == datetime(2026, 10, 13, 9, 0, tzinfo=timezone.utc)


def test_a_schedule_not_yet_due_waits(repositories: Any, schedule: RecurringIssue) -> None:
    """A run later today is left alone."""
    _put(repositories, next_run_at=NOW + timedelta(minutes=30))

    assert sweep(repositories, now=NOW).due == 0
    assert _issues(repositories) == []


def test_a_paused_schedule_is_skipped(repositories: Any, schedule: RecurringIssue) -> None:
    """Pausing keeps the sweep away even with a past next run stored."""
    _put(repositories, paused=True)

    assert sweep(repositories, now=NOW).due == 0
    assert _issues(repositories) == []


def test_a_deleted_template_pauses_the_schedule(repositories: Any, schedule: RecurringIssue) -> None:
    """With the template gone the schedule pauses with the reason and creates nothing."""
    repositories.team_config.delete_template(WORKSPACE, TEAM, TEMPLATE)

    summary = sweep(repositories, now=NOW)

    assert summary.paused == 1
    assert _issues(repositories) == []
    stored = _stored(repositories)
    assert (stored.paused, stored.paused_reason, stored.next_run_at) == (True, TEMPLATE_GONE, None)


def test_a_creator_who_left_pauses_the_schedule(repositories: Any, schedule: RecurringIssue) -> None:
    """A creator no longer in the workspace pauses the schedule rather than acting for them."""
    repositories.memberships.delete(WORKSPACE, MEMBER)

    summary = sweep(repositories, now=NOW)

    assert summary.paused == 1
    assert _issues(repositories) == []
    assert _stored(repositories).paused_reason == CREATOR_GONE


def test_the_hourly_trigger_runs_the_sweep(repositories: Any, schedule: RecurringIssue) -> None:
    """The cycle close record creates the due issue."""
    _put(repositories, next_run_at=datetime(2020, 1, 1, tzinfo=timezone.utc))

    handle_record(repositories, {"eventSource": CYCLE_CLOSE_SOURCE, "eventName": "SWEEP", "eventID": "cycle-close"})

    assert len(_issues(repositories)) == 1
