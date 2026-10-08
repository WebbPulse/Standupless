"""The issue due date reminder sweep, run from the notify digest flush schedule.

As in Linear, the assignee of an open issue hears about its due date twice: a
`due_soon` reminder from the day before it is due, and an `overdue` one once the
date has passed. Due dates are calendar days, read in UTC. The sweep rides the
digest flush every `SWEEP_EVERY_MINUTES`, the way the project update reminders
do, because the views notify consumer already holds the inbox grant and reads
issues, teams, statuses and users.

Each pass walks the open status columns of every live team, which leaves out
completed, canceled, archived and triage issues by construction. A marker per
kind, issue, assignee and due date makes each reminder once only, so moving the
due date or handing the issue to someone else arms a fresh one, and a person who
deletes a reminder is not sent it again. A pass that dies between the write and
the marker is finished by the next one, the conditional inbox put turning the
repeat into a no-op. An overdue reminder is only sent within `OVERDUE_WINDOW` of
the due date, so turning this on never mails about issues long forgotten.

The same walk sends the SLA notices: `sla_at_risk` once an issue's SLA turns at
risk and `sla_breached` once it breaches, each once per deadline and assignee,
and a breach only within `OVERDUE_WINDOW` of the deadline.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.issues import Issue
from app.common.sla import at_risk_from
from app.domains.views.consumers.notify import write_notification

DUE_SOON = "due_soon"

OVERDUE = "overdue"

SLA_AT_RISK = "sla_at_risk"

SLA_BREACHED = "sla_breached"

OPEN_CATEGORIES: tuple[str, ...] = ("backlog", "unstarted", "started")
"""The status categories an issue can still be due in."""

SWEEP_EVERY_MINUTES = 60
"""How often, in minutes of the hour, the flush schedule also runs this sweep.

Due dates are whole days, so an hourly pass is soon enough and costs a quarter
of a quarter hourly one.
"""

DUE_SOON_LEAD = timedelta(days=1)
"""How long before its due date an issue counts as due soon."""

OVERDUE_WINDOW = timedelta(days=7)
"""How long after its due date an overdue reminder may still go out."""

_log = logging.getLogger(__name__)


@dataclass
class DueReminderSummary:
    """What one sweep did, for its log line."""

    workspaces: int = 0
    teams: int = 0
    due_soon: int = 0
    overdue: int = 0
    sla_at_risk: int = 0
    sla_breached: int = 0

    def add(self, other: "DueReminderSummary") -> None:
        """Fold one team's counts into this summary."""
        self.teams += other.teams
        self.due_soon += other.due_soon
        self.overdue += other.overdue
        self.sla_at_risk += other.sla_at_risk
        self.sla_breached += other.sla_breached

    @property
    def sent(self) -> bool:
        """Whether the sweep sent anything worth a log line."""
        return bool(self.due_soon or self.overdue or self.sla_at_risk or self.sla_breached)


def sweep_due(now: datetime) -> bool:
    """Whether the flush tick at `now` also runs the due date sweep."""
    return now.minute % SWEEP_EVERY_MINUTES == 0


def _midnight(day: date) -> datetime:
    """The start of one UTC calendar day."""
    return datetime.combine(day, time.min, tzinfo=timezone.utc)


def reminder_for(due_date: str, today: date) -> tuple[str, datetime] | None:
    """Which reminder an issue due on `due_date` is owed today, and when it is stamped.

    Answers `None` before the due soon lead, on a date that cannot be read, and
    once an overdue issue is past the window. The stamp is the moment the
    reminder became owed rather than the clock, so every pass writes the same
    notification id.
    """
    try:
        due = date.fromisoformat(due_date)
    except ValueError:
        return None
    if today > due:
        if today - due > OVERDUE_WINDOW:
            return None
        return OVERDUE, _midnight(due + timedelta(days=1))
    if due - today <= DUE_SOON_LEAD:
        return DUE_SOON, _midnight(due - DUE_SOON_LEAD)
    return None


def remind_issue(repositories: Repositories, issue: Issue, today: date, now: datetime) -> str | None:
    """Send one issue's owed reminder to its assignee, answering the kind sent or `None`.

    The assignee must still see the issue's team and want the kind on some
    channel, which `write_notification` decides. The marker is set either way, so
    an assignee who turned the kind off is not reconsidered every hour.
    """
    assignee_id = issue.assignee_id or ""
    if not assignee_id or not issue.due_date:
        return None
    owed = reminder_for(issue.due_date, today)
    if owed is None:
        return None
    kind, stamp = owed
    subject = f"{kind}#{issue.issue_id}#{assignee_id}"
    if repositories.inbox.reminded(issue.workspace_id, subject, stamp):
        return None
    written = write_notification(
        repositories,
        workspace_id=issue.workspace_id,
        recipient_id=assignee_id,
        kind=kind,
        issue=issue,
        comment_id=None,
        actor_id="",
        actor_display="",
        created_at=stamp,
        source_id=f"{issue.issue_id}#{issue.due_date}",
    )
    repositories.inbox.mark_reminded(issue.workspace_id, subject, stamp, now)
    return kind if written else None


def sla_notice_for(issue: Issue, now: datetime) -> tuple[str, datetime] | None:
    """Which SLA notice an issue is owed at `now`, and the moment it became owed.

    Answers `None` while the SLA is on track, when the issue carries none, and
    once a breach is older than the overdue window.
    """
    breaches_at = issue.sla_breaches_at
    if breaches_at is None:
        return None
    if now >= breaches_at:
        if now - breaches_at > OVERDUE_WINDOW:
            return None
        return SLA_BREACHED, breaches_at
    turned = at_risk_from(issue.sla_started_at or breaches_at, breaches_at)
    if now >= turned:
        return SLA_AT_RISK, turned
    return None


def remind_sla_issue(repositories: Repositories, issue: Issue, now: datetime) -> str | None:
    """Send one issue's owed SLA notice to its assignee, answering the kind sent or `None`.

    Marked once per kind, issue, assignee and the moment the notice became owed,
    which follows the deadline, so a deadline moved by a priority change arms
    fresh notices.
    """
    assignee_id = issue.assignee_id or ""
    if not assignee_id or issue.sla_breaches_at is None:
        return None
    owed = sla_notice_for(issue, now)
    if owed is None:
        return None
    kind, stamp = owed
    subject = f"{kind}#{issue.issue_id}#{assignee_id}"
    if repositories.inbox.reminded(issue.workspace_id, subject, stamp):
        return None
    written = write_notification(
        repositories,
        workspace_id=issue.workspace_id,
        recipient_id=assignee_id,
        kind=kind,
        issue=issue,
        comment_id=None,
        actor_id="",
        actor_display="",
        created_at=stamp,
        source_id=f"{issue.issue_id}#sla#{issue.sla_breaches_at.isoformat()}",
    )
    repositories.inbox.mark_reminded(issue.workspace_id, subject, stamp, now)
    return kind if written else None


def remind_team(
    repositories: Repositories, workspace_id: str, team_id: str, today: date, now: datetime
) -> DueReminderSummary:
    """Send the owed due date and SLA reminders of one team's open issues."""
    summary = DueReminderSummary(teams=1)
    for status in repositories.team_config.list_statuses(workspace_id, team_id, include_hidden=True):
        if status.category not in OPEN_CATEGORIES:
            continue
        for issue in repositories.issues.iter_assigned_with_due_date(workspace_id, team_id, status.status_id):
            sent = remind_issue(repositories, issue, today, now)
            if sent == DUE_SOON:
                summary.due_soon += 1
            elif sent == OVERDUE:
                summary.overdue += 1
        for issue in repositories.issues.iter_assigned_with_sla(workspace_id, team_id, status.status_id):
            notice = remind_sla_issue(repositories, issue, now)
            if notice == SLA_AT_RISK:
                summary.sla_at_risk += 1
            elif notice == SLA_BREACHED:
                summary.sla_breached += 1
    return summary


def run_due_reminders(repositories: Repositories, now: datetime | None = None) -> DueReminderSummary:
    """Remind assignees of every open issue across live workspaces that is due soon, overdue or near its SLA."""
    moment = now or datetime.now(timezone.utc)
    today = moment.astimezone(timezone.utc).date()
    summary = DueReminderSummary()
    for workspace in repositories.workspaces.list_active():
        if workspace.is_purging:
            continue
        summary.workspaces += 1
        for team in repositories.teams.list_for_workspace(workspace.id):
            summary.add(remind_team(repositories, workspace.id, team.team_id, today, moment))
    if summary.sent:
        _log.info(
            "Sent issue due date reminders.",
            extra={
                "event": "views.notify.issue_due",
                "workspaces": summary.workspaces,
                "teams": summary.teams,
                "due_soon": summary.due_soon,
                "overdue": summary.overdue,
                "sla_at_risk": summary.sla_at_risk,
                "sla_breached": summary.sla_breached,
            },
        )
    return summary
