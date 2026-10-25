"""The Pulse digest sweep, run from the notify digest flush schedule.

A person who turns the digest on gets one email per workspace listing what
changed in the projects and initiatives they follow: daily, or weekly on
Mondays, at `SEND_HOUR` on their own calendar, their stored timezone else UTC.
The sweep rides the flush once an hour, the way the due date reminders do,
because the views notify consumer already reads the planning, memberships, users
and workspaces tables and mails through the shared SES pipeline.

A digest covers the period that ends at its send moment, so consecutive digests
neither overlap nor leave a gap. A marker per person, workspace and send moment
is claimed before the email goes, so a pass that overlaps another or a retried
window sends it once, and an empty digest is marked without being sent. Entries
the reader made themselves are left out, and what they may read is decided the
same way the Pulse page decides it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone, tzinfo

from app.common import pulse
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.users import User
from app.common.email import deliver
from app.common.email_unsubscribe import PULSE_DIGEST_KIND, unsubscribe_links
from app.domains.views.consumers.due_reminders import zone_named
from app.domains.views.consumers.sweeps import claim_pass
from app.domains.views.email import PULSE_DIGEST, PULSE_DIGEST_LINE_LIMIT, pulse_line, render_pulse_digest

SWEEP_NAME = "pulse_digest"
"""The name this sweep claims its passes under."""

SWEEP_INTERVAL = timedelta(hours=1)
"""How often the flush schedule also runs this sweep."""

SEND_HOUR = 8
"""The local hour a digest goes out at."""

SEND_WINDOW = timedelta(hours=2)
"""How long after its send moment a digest may still go out, so a missed pass is caught up."""

WEEKLY_DAY = 0
"""The weekday a weekly digest goes out on, Monday."""

PERIODS: dict[str, timedelta] = {"daily": timedelta(days=1), "weekly": timedelta(days=7)}
"""How far back each cadence's digest reaches."""

_log = logging.getLogger(__name__)


@dataclass
class PulseDigestSummary:
    """What one sweep did, for its log line."""

    due: int = 0
    sent: int = 0
    empty: int = 0


def sweep_due(repositories: Repositories, now: datetime) -> bool:
    """Whether the flush tick at `now` also runs the Pulse digest sweep, claiming its window when it does."""
    return claim_pass(repositories, SWEEP_NAME, SWEEP_INTERVAL, now)


def send_moment(cadence: str, now: datetime, zone: tzinfo = timezone.utc) -> datetime | None:
    """The send moment a digest of `cadence` is owed at `now` on `zone`'s calendar, or `None` when none is.

    A moment is owed from `SEND_HOUR` local until `SEND_WINDOW` after it, on every
    day for a daily digest and on `WEEKLY_DAY` for a weekly one.
    """
    if cadence not in PERIODS:
        return None
    local = now.astimezone(zone)
    if cadence == "weekly" and local.weekday() != WEEKLY_DAY:
        return None
    moment = datetime.combine(local.date(), time(SEND_HOUR), tzinfo=zone).astimezone(timezone.utc)
    if now < moment or now - moment >= SEND_WINDOW:
        return None
    return moment


def marker_subject(user_id: str) -> str:
    """The reminder subject a person's digest in one workspace is marked under."""
    return f"{PULSE_DIGEST}#{user_id}"


def _actor_names(repositories: Repositories, actor_ids: set[str], cache: dict[str, User | None]) -> dict[str, str]:
    """Each actor's display name, read once per sweep."""
    names: dict[str, str] = {}
    for actor_id in actor_ids:
        if actor_id not in cache:
            cache[actor_id] = repositories.users.get(actor_id)
        user = cache[actor_id]
        names[actor_id] = user.display_name if user is not None else ""
    return names


def deliver_digest(
    repositories: Repositories,
    *,
    workspace_id: str,
    workspace_name: str,
    workspace_slug: str,
    accent: str | None,
    user: User,
    now: datetime,
    cache: dict[str, User | None],
) -> str | None:
    """Send one person's digest for one workspace when it is owed, answering `sent`, `empty` or `None`."""
    moment = send_moment(user.pulse_digest, now, zone_named(user.timezone) or timezone.utc)
    if moment is None:
        return None
    subject = marker_subject(user.id)
    if repositories.inbox.reminded(workspace_id, subject, moment):
        return None
    viewer = pulse.viewer_for_person(repositories, workspace_id, user.id)
    if viewer is None:
        return None
    entries, total = pulse.entries_between(
        repositories,
        viewer,
        since=moment - PERIODS[user.pulse_digest],
        until=moment,
        limit=PULSE_DIGEST_LINE_LIMIT,
    )
    if not repositories.inbox.mark_reminded(workspace_id, subject, moment, now):
        return None
    if not total:
        return "empty"
    names = _actor_names(repositories, {entry.event.actor_id for entry in entries if entry.event.actor_id}, cache)
    lines = [
        pulse_line(
            event_type=entry.event.event_type,
            actor_name=names.get(entry.event.actor_id, ""),
            project_name=entry.project.name if entry.project is not None else "",
            initiative_name=entry.initiative.name if entry.initiative is not None else "",
            milestone_name=entry.event.milestone_name or "",
            health=entry.event.health or "",
            body=entry.event.body or "",
        )
        for entry in entries
    ]
    deliver(
        render_pulse_digest(
            lines,
            total=total,
            cadence=user.pulse_digest,
            to=str(user.email),
            workspace_name=workspace_name,
            workspace_slug=workspace_slug,
            accent=accent,
            unsubscribe_links=unsubscribe_links(user_id=user.id, workspace_id=workspace_id, kinds=[PULSE_DIGEST_KIND]),
        ),
        event=f"views.notify.email.{PULSE_DIGEST}",
    )
    return "sent"


def wants_digest(user: User | None) -> bool:
    """Whether a person is one a digest may go to: live, mailable and opted in."""
    return (
        user is not None
        and not user.disabled
        and not user.is_deleted
        and user.email_notifications
        and bool(user.email)
        and user.pulse_digest in PERIODS
    )


def run_pulse_digests(repositories: Repositories, now: datetime | None = None) -> PulseDigestSummary:
    """Send every owed Pulse digest across live workspaces.

    One person's digest failing is logged and skipped, so it never holds up the
    rest.
    """
    moment = now or datetime.now(timezone.utc)
    summary = PulseDigestSummary()
    cache: dict[str, User | None] = {}
    for workspace in repositories.workspaces.list_active():
        if workspace.is_purging:
            continue
        for membership in repositories.memberships.list_members(workspace.id):
            if not membership.user_id or membership.is_suspended:
                continue
            if membership.user_id not in cache:
                cache[membership.user_id] = repositories.users.get(membership.user_id)
            user = cache[membership.user_id]
            if user is None or not wants_digest(user):
                continue
            try:
                result = deliver_digest(
                    repositories,
                    workspace_id=workspace.id,
                    workspace_name=workspace.name,
                    workspace_slug=workspace.slug,
                    accent=workspace.accent_color,
                    user=user,
                    now=moment,
                    cache=cache,
                )
            except Exception:
                _log.exception(
                    "A Pulse digest failed to deliver.",
                    extra={"event": "views.notify.pulse_digest_failed", "workspace_id": workspace.id},
                )
                continue
            if result is not None:
                summary.due += 1
                summary.sent += int(result == "sent")
                summary.empty += int(result == "empty")
    if summary.due:
        _log.info(
            "Ran the Pulse digests.",
            extra={
                "event": "views.notify.pulse_digest",
                "due": summary.due,
                "sent": summary.sent,
                "empty": summary.empty,
            },
        )
    return summary
