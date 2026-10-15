"""The project and initiative update reminder sweep, run from the notify digest flush schedule.

The digest flush already fires every minute on the views notify consumer, which
holds the inbox grant and reads workspaces, memberships, users and planning, so
the sweep rides it once per `SWEEP_INTERVAL` window, claimed through `sweeps`,
rather than needing a schedule of its own. Each pass reads every live workspace's projects, finds the ones whose
update has come due, and sends each lead one inbox reminder per due date. The same pass reads every
live workspace's initiatives and sends each owner a reminder when an update
comes due and another when it goes overdue, once per due date and stage.

A marker per project and due date is what makes the reminder once only: it is
checked before the reminder is written and set after, so a lead who deletes the
reminder is not sent it again, and a pass that dies between the two leaves no
marker and the next pass finishes the job, the conditional inbox put turning
the repeat into a no-op. Due dates older than `REMINDER_WINDOW` are left alone,
so turning this on never mails a reminder for a project nobody has touched in
months.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.inbox import Notification, expires_at, inbox_partition
from app.common.db.dynamo.planning import Initiative, Project
from app.common.project_cadence import (
    OVERDUE_GRACE,
    ProjectUpdateDue,
    effective_interval,
    emit_update_due,
    next_update_due_at,
    queue_update_due_announcement,
)
from app.domains.views.consumers.notify import (
    can_receive_workspace_subject,
    hold_for_digest,
    notification_id,
    receiving_team,
)
from app.domains.views.consumers.sweeps import claim_pass

PROJECT_UPDATE_DUE = "project_update_due"

INITIATIVE_UPDATE_DUE = "initiative_update_due"

SWEEP_NAME = "project_reminders"
"""The name this sweep claims its passes under."""

SWEEP_INTERVAL = timedelta(minutes=15)
"""How often the flush schedule also runs the sweep."""

REMINDER_WINDOW = timedelta(days=7)
"""How long after its due date a reminder may still go out, covering a paused schedule."""

_log = logging.getLogger(__name__)


@dataclass
class ReminderSummary:
    """What one sweep did, for its log line."""

    workspaces: int = 0
    due: int = 0
    notified: int = 0
    initiatives_due: int = 0
    initiatives_notified: int = 0


def sweep_due(repositories: Repositories, now: datetime) -> bool:
    """Whether the flush tick at `now` also runs the reminder sweep, claiming its window when it does."""
    return claim_pass(repositories, SWEEP_NAME, SWEEP_INTERVAL, now)


def write_reminder(repositories: Repositories, project: Project, due_at: datetime) -> bool:
    """Write the lead's reminder for one due date under their preferences, answering whether one was written.

    The lead must still see one of the project's teams, which is the team the row
    carries. The row is stamped at the due date, so its id is the same on every
    pass and a repeat write is dropped by the conditional put.
    """
    lead_id = project.lead_id or ""
    if not lead_id:
        return False
    team_id = receiving_team(repositories, project, lead_id)
    if not team_id:
        return False
    lead = repositories.users.get(lead_id)
    in_app = lead.wants_notification(PROJECT_UPDATE_DUE, "in_app") if lead is not None else True
    email = lead is not None and lead.wants_notification(PROJECT_UPDATE_DUE, "email")
    if not in_app and not email:
        return False

    row = Notification(
        ws_user=inbox_partition(project.workspace_id, lead_id),
        notification_id=notification_id(
            due_at, PROJECT_UPDATE_DUE, lead_id, f"{project.project_id}#{due_at.isoformat()}"
        ),
        workspace_id=project.workspace_id,
        kind=PROJECT_UPDATE_DUE,
        team_id=team_id,
        project_id=project.project_id,
        project_name=project.name,
        actor_id="",
        actor_name="",
        recipient_id=lead_id,
        created_at=due_at,
        unread_at=due_at.isoformat() if in_app else None,
        expires_at=expires_at(due_at),
    )
    if not repositories.inbox.create(row):
        return False
    if email:
        hold_for_digest(repositories, row)
    return True


def announce(event: ProjectUpdateDue) -> bool:
    """Queue the team channel announcement of one due update, logging rather than raising on failure.

    A queue that cannot be reached must not hold back the lead's reminder or the
    marker, so the announcement is the one part of a reminder that may be lost.
    """
    try:
        return queue_update_due_announcement(event)
    except Exception:
        _log.exception(
            "Could not queue a project update due announcement.",
            extra={
                "event": "views.notify.project_update_due.announce_failed",
                "workspace_id": event.workspace_id,
                "project_id": event.project_id,
            },
        )
        return False


def remind_project(repositories: Repositories, project: Project, default_days: int, now: datetime) -> bool | None:
    """Send one project's reminder when its update is due and not yet reminded.

    Answers `None` when nothing was due, and otherwise whether the lead got an
    inbox row. The due event goes to the listeners and the team channels either
    way, so a team webhook or Slack channel hears of a project with no lead too.
    """
    due_at = next_update_due_at(project, default_days)
    if due_at is None or due_at > now or now - due_at > REMINDER_WINDOW:
        return None
    if repositories.inbox.reminded(project.workspace_id, project.project_id, due_at):
        return None
    written = write_reminder(repositories, project, due_at)
    event = ProjectUpdateDue(
        workspace_id=project.workspace_id,
        project_id=project.project_id,
        project_name=project.name,
        team_ids=tuple(project.team_ids),
        lead_id=project.lead_id,
        due_at=due_at,
        interval_days=effective_interval(project, default_days),
    )
    emit_update_due(event)
    announce(event)
    repositories.inbox.mark_reminded(project.workspace_id, project.project_id, due_at, now)
    return written


def initiative_stage(initiative: Initiative, default_days: int, now: datetime) -> tuple[str, datetime, datetime] | None:
    """The reminder stage an initiative is in at `now`, with its due date and the moment the stage began.

    An update comes due at its due date and goes overdue once `OVERDUE_GRACE` has
    passed it, each stage reminded once. Answers `None` when nothing is due, or
    when the current stage began more than `REMINDER_WINDOW` ago.
    """
    due_at = next_update_due_at(initiative, default_days)
    if due_at is None or due_at > now:
        return None
    overdue_at = due_at + OVERDUE_GRACE
    stage, stage_at = ("overdue", overdue_at) if now >= overdue_at else ("due", due_at)
    if now - stage_at > REMINDER_WINDOW:
        return None
    return stage, due_at, stage_at


def write_initiative_reminder(
    repositories: Repositories, initiative: Initiative, stage: str, due_at: datetime, stage_at: datetime
) -> bool:
    """Write the owner's reminder for one initiative stage under their preferences, answering whether one was written.

    An initiative belongs to the workspace rather than a team, so the row carries
    no team and the owner must be a workspace member other than a guest. The row
    is stamped at the stage's start, so its id is the same on every pass and a
    repeat write is dropped by the conditional put.
    """
    owner_id = initiative.owner_id or ""
    if not owner_id:
        return False
    if not can_receive_workspace_subject(repositories, initiative.workspace_id, owner_id):
        return False
    owner = repositories.users.get(owner_id)
    if owner is None or owner.disabled:
        return False
    in_app = owner.wants_notification(INITIATIVE_UPDATE_DUE, "in_app")
    email = owner.wants_notification(INITIATIVE_UPDATE_DUE, "email")
    if not in_app and not email:
        return False

    row = Notification(
        ws_user=inbox_partition(initiative.workspace_id, owner_id),
        notification_id=notification_id(
            stage_at,
            INITIATIVE_UPDATE_DUE,
            owner_id,
            f"{initiative.initiative_id}#{stage}#{due_at.isoformat()}",
        ),
        workspace_id=initiative.workspace_id,
        kind=INITIATIVE_UPDATE_DUE,
        team_id="",
        initiative_id=initiative.initiative_id,
        initiative_name=initiative.name,
        due_state=stage,
        actor_id="",
        actor_name="",
        recipient_id=owner_id,
        created_at=stage_at,
        unread_at=stage_at.isoformat() if in_app else None,
        expires_at=expires_at(stage_at),
    )
    if not repositories.inbox.create(row):
        return False
    if email:
        hold_for_digest(repositories, row)
    return True


def remind_initiative(
    repositories: Repositories, initiative: Initiative, default_days: int, now: datetime
) -> bool | None:
    """Send one initiative's reminder when its update is due or overdue and that stage is not yet reminded.

    Answers `None` when nothing was due, and otherwise whether the owner got an
    inbox row. The marker is set either way, so an initiative with no owner is
    not read again for the same stage.
    """
    staged = initiative_stage(initiative, default_days, now)
    if staged is None:
        return None
    stage, due_at, stage_at = staged
    subject_id = f"initiative#{initiative.initiative_id}#{stage}"
    if repositories.inbox.reminded(initiative.workspace_id, subject_id, due_at):
        return None
    written = write_initiative_reminder(repositories, initiative, stage, due_at, stage_at)
    repositories.inbox.mark_reminded(initiative.workspace_id, subject_id, due_at, now)
    return written


def run_reminders(repositories: Repositories, now: datetime | None = None) -> ReminderSummary:
    """Remind the lead of every project and the owner of every initiative across live workspaces whose update has come due."""
    moment = now or datetime.now(timezone.utc)
    summary = ReminderSummary()
    for workspace in repositories.workspaces.list_active():
        if workspace.is_purging:
            continue
        summary.workspaces += 1
        for project in repositories.planning.list_projects(workspace.id):
            outcome = remind_project(repositories, project, workspace.project_update_interval_days, moment)
            if outcome is None:
                continue
            summary.due += 1
            if outcome:
                summary.notified += 1
        for initiative in repositories.planning.list_initiatives(workspace.id):
            outcome = remind_initiative(repositories, initiative, workspace.project_update_interval_days, moment)
            if outcome is None:
                continue
            summary.initiatives_due += 1
            if outcome:
                summary.initiatives_notified += 1
    if summary.due or summary.initiatives_due:
        _log.info(
            "Sent project update reminders.",
            extra={
                "event": "views.notify.project_update_due",
                "workspaces": summary.workspaces,
                "due": summary.due,
                "notified": summary.notified,
                "initiatives_due": summary.initiatives_due,
                "initiatives_notified": summary.initiatives_notified,
            },
        )
    return summary
