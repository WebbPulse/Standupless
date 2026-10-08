"""The scheduled standup digest delivery, run from the notify digest flush schedule.

Rides the every minute flush on the views notify consumer, every
`SWEEP_EVERY_MINUTES`, the way the project update reminder sweep does. Each pass
reads every live workspace's teams and their standup settings, and a team whose
local send time has passed today, on a day its cadence covers, gets that date's
digest built once and delivered to each member who can still see the team: an
inbox row, and an email when their `standup_digest` preference allows it.

A marker per team and date makes the delivery once only. It is checked before
the digest is built and set after the rows are written, so a pass that dies in
between leaves no marker and the next one finishes the job, the deterministic
row id and the conditional inbox put turning each repeat into a no-op and the
email hanging off that put. An empty digest is marked and not sent. A send time
more than `SEND_WINDOW` in the past is left alone, so turning a schedule on in
the afternoon does not mail that morning's digest late.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.inbox import Notification, expires_at, inbox_partition
from app.common.db.dynamo.team_config import StandupSettings
from app.common.email import deliver
from app.common.standup import StandupDigest, StandupWindowError, build_digest, parse_send_time, resolve_zone
from app.domains.views.consumers.notify import can_receive, notification_id
from app.domains.views.email import STANDUP_DIGEST, render_standup_digest

SWEEP_EVERY_MINUTES = 5
"""How often, in minutes of the hour, the flush schedule also runs the standup sweep."""

SEND_WINDOW = timedelta(hours=2)
"""How long after a team's send time its digest may still go out, covering a paused schedule."""

_log = logging.getLogger(__name__)


@dataclass
class StandupSummary:
    """What one sweep did, for its log line and the tests."""

    teams: int = 0
    due: int = 0
    sent: int = 0
    empty: int = 0
    notified: int = 0


def sweep_due(now: datetime) -> bool:
    """Whether the flush tick at `now` also runs the standup sweep."""
    return now.minute % SWEEP_EVERY_MINUTES == 0


def send_moment(settings: StandupSettings, day: date) -> datetime:
    """The UTC instant the digest dated `day` goes out at, in the team's timezone."""
    zone = resolve_zone(settings.timezone)
    return datetime.combine(day, parse_send_time(settings.send_time), tzinfo=zone).astimezone(timezone.utc)


def due_date(settings: StandupSettings, now: datetime) -> date | None:
    """The team local date whose digest is due at `now`, or `None` when none is.

    A daily digest goes out on weekdays and a weekly one on its `weekday`, each
    once its local send time has passed and for `SEND_WINDOW` after. Settings
    with an unknown timezone or a malformed send time are never due.
    """
    if settings.cadence not in ("daily", "weekly"):
        return None
    try:
        day = now.astimezone(resolve_zone(settings.timezone)).date()
        moment = send_moment(settings, day)
    except StandupWindowError:
        return None
    fits = day.weekday() == settings.weekday if settings.cadence == "weekly" else day.weekday() < 5
    if not fits or moment > now or now - moment > SEND_WINDOW:
        return None
    return day


def write_standup(
    repositories: Repositories,
    digest: StandupDigest,
    *,
    workspace_id: str,
    workspace_slug: str,
    recipient_id: str,
    sent_at: datetime,
) -> bool:
    """Write one member's inbox row for a digest under their preferences, mailing it when the row is new.

    The row is stamped at the send time, so its id is the same on every pass and
    a repeat is dropped by the conditional put, which is also what keeps the
    email from going twice.
    """
    if not can_receive(repositories, workspace_id, digest.team_id, recipient_id):
        return False
    recipient = repositories.users.get(recipient_id)
    if recipient is None or recipient.disabled:
        return False
    in_app = recipient.wants_notification(STANDUP_DIGEST, "in_app")
    email = recipient.wants_notification(STANDUP_DIGEST, "email")
    if not in_app and not email:
        return False

    row = Notification(
        ws_user=inbox_partition(workspace_id, recipient_id),
        notification_id=notification_id(sent_at, STANDUP_DIGEST, recipient_id, f"{digest.team_id}#{digest.date}"),
        workspace_id=workspace_id,
        kind=STANDUP_DIGEST,
        issue_key=digest.team_key,
        issue_title=digest.team_name,
        team_id=digest.team_id,
        standup_date=digest.date,
        actor_id="",
        actor_name="",
        recipient_id=recipient_id,
        created_at=sent_at,
        unread_at=sent_at.isoformat() if in_app else None,
        expires_at=expires_at(sent_at),
    )
    if not repositories.inbox.create(row):
        return False
    if email and recipient.email:
        deliver(
            render_standup_digest(digest, to=str(recipient.email), workspace_slug=workspace_slug),
            event=f"views.notify.email.{STANDUP_DIGEST}",
        )
    return True


def deliver_team(
    repositories: Repositories,
    *,
    workspace_id: str,
    workspace_slug: str,
    settings: StandupSettings,
    now: datetime,
    summary: StandupSummary,
) -> None:
    """Build and deliver one team's due digest once, recording it in `summary`."""
    day = due_date(settings, now)
    if day is None:
        return
    key = day.isoformat()
    if repositories.inbox.standup_sent(workspace_id, settings.team_id, key):
        return
    summary.due += 1
    digest = build_digest(repositories, workspace_id, settings.team_id, day, settings=settings, now=now)
    if all(person.is_empty for person in digest.people):
        summary.empty += 1
    else:
        summary.sent += 1
        sent_at = send_moment(settings, day)
        member_ids = [
            member.user_id
            for member in repositories.memberships.list_team_members(workspace_id, settings.team_id)
            if member.user_id
        ]
        for recipient_id in dict.fromkeys(member_ids):
            summary.notified += int(
                write_standup(
                    repositories,
                    digest,
                    workspace_id=workspace_id,
                    workspace_slug=workspace_slug,
                    recipient_id=recipient_id,
                    sent_at=sent_at,
                )
            )
    repositories.inbox.mark_standup_sent(workspace_id, settings.team_id, key, now)


def run_standups(repositories: Repositories, now: datetime | None = None) -> StandupSummary:
    """Deliver every team's standup digest across live workspaces whose send time has come.

    One team failing is logged and skipped, so it never holds up the rest; with
    no marker written it is tried again on the next pass.
    """
    moment = now or datetime.now(timezone.utc)
    summary = StandupSummary()
    for workspace in repositories.workspaces.list_active():
        if workspace.is_purging:
            continue
        for team in repositories.teams.list_for_workspace(workspace.id):
            stored = repositories.team_config.get_standup_settings(workspace.id, team.team_id)
            if stored is None or stored.cadence not in ("daily", "weekly"):
                continue
            summary.teams += 1
            try:
                deliver_team(
                    repositories,
                    workspace_id=workspace.id,
                    workspace_slug=workspace.slug,
                    settings=stored,
                    now=moment,
                    summary=summary,
                )
            except Exception:
                _log.exception(
                    "A standup digest failed to deliver.",
                    extra={
                        "event": "views.notify.standup_failed",
                        "workspace_id": workspace.id,
                        "team_id": team.team_id,
                    },
                )
    if summary.due:
        _log.info(
            "Delivered standup digests.",
            extra={
                "event": "views.notify.standup_digest",
                "teams": summary.teams,
                "due": summary.due,
                "sent": summary.sent,
                "empty": summary.empty,
                "notified": summary.notified,
            },
        )
    return summary
