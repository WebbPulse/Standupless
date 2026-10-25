"""SLA timers: when an issue's deadline starts, when it breaches, and how close it is.

Follows Linear. A team's rules give each priority a number of hours. An open
issue with a ruled priority gets a timer when it is created, leaves triage, or
reopens; changing its priority keeps the start and moves the deadline to the new
priority's hours, or drops the timer when the new priority has no rule. Finishing
or archiving the issue drops the timer, and so, by default, does sending it back
to triage. A timer is never restarted while it runs, so moving between open
statuses leaves it alone.

A team may instead start its timers at creation, triage included, the way
Linear's start mode does. Then an issue in triage keeps or starts a timer like
any open issue, and a timer that starts late, because the priority was set
afterwards, still counts from `created_at`. A reopened issue starts a fresh
window from the reopen in either mode.

A team may also pick open statuses that pause the timer, the way Linear leaves
time in chosen statuses out of an SLA. Entering one stamps `sla_paused_at`, and
the status reads frozen at that moment. Leaving it moves both the start and the
deadline on by the time spent there, so the issue resumes with the time it had
left and a later priority change still counts from the shifted start.

A team may count its hours in business days, so a weekend in the team's
timezone burns none of the window. Each timer stamps the timezone it runs in
as `sla_timezone`, `None` for calendar time, and every computation here, the
deadline, the at-risk point, a pause's shift and a priority change, goes
through `sla_clock` with that stamp, so reads need no team lookup and a timer
keeps its clock until the team switches modes and `recalendar` converts it.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Literal

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import SlaSettings, default_sla_settings
from app.common.sla_clock import advance, elapsed, retreat
from app.common.team_time import team_timezone

if TYPE_CHECKING:
    from app.common.api.dependencies.repositories import Repositories

SlaStatus = Literal["none", "on_track", "at_risk", "breached"]

SLA_STATUSES: tuple[str, ...] = ("none", "on_track", "at_risk", "breached")
"""Every value `sla_status` reads as, in the order a filter lists them."""

FINISHED_CATEGORIES: frozenset[str] = frozenset({"completed", "cancelled"})
"""Status categories an SLA timer never runs in."""

COMPLETED_CATEGORY = "completed"
"""The status category whose arrival stamps an issue's `completed_at`."""

STARTED_CATEGORY = "started"
"""The status category whose first arrival stamps an issue's `started_at`."""

CANCELLED_CATEGORY = "cancelled"
"""The status category whose arrival stamps an issue's `cancelled_at`."""

AT_RISK_SHARE = 0.25
"""The share of an SLA window left at which the issue counts as at risk."""

AT_RISK_CAP = timedelta(hours=24)
"""The most time left at which an issue counts as at risk, however long its window."""

WATCHED_FIELDS: tuple[str, ...] = ("priority", "status_id", "in_triage", "team_id")
"""The issue fields whose change can start, move or drop a timer."""


def at_risk_from(started_at: datetime, breaches_at: datetime, zone: str | None = None) -> datetime:
    """The moment an SLA turns at risk: a quarter of its window left, at most a day.

    With a `zone` the window and the lead are business time in that timezone.
    """
    window = elapsed(started_at, breaches_at, zone)
    lead = min(window * AT_RISK_SHARE, AT_RISK_CAP)
    return retreat(breaches_at, lead, zone)


def sla_moment(issue: Issue, now: datetime | None = None) -> datetime:
    """The moment an issue's SLA is read at: `now`, or the moment its timer paused."""
    moment = now or utc_now()
    if issue.sla_paused_at is not None and issue.sla_paused_at < moment:
        return issue.sla_paused_at
    return moment


def sla_status(issue: Issue, now: datetime | None = None) -> SlaStatus:
    """How an issue stands against its SLA at `now`, `none` when it carries no timer.

    A paused timer reads as it stood when it paused, so it neither turns at risk
    nor breaches while the issue sits in a paused status.
    """
    if issue.sla_breaches_at is None or issue.archived_at is not None:
        return "none"
    moment = sla_moment(issue, now)
    if moment >= issue.sla_breaches_at:
        return "breached"
    started = issue.sla_started_at or issue.sla_breaches_at
    if moment >= at_risk_from(started, issue.sla_breaches_at, issue.sla_timezone):
        return "at_risk"
    return "on_track"


def effective_breach(issue: Issue, now: datetime | None = None) -> datetime | None:
    """When an issue would breach if its timer resumed at `now`, its stored deadline when it runs."""
    if issue.sla_breaches_at is None:
        return None
    moment = now or utc_now()
    return advance(
        issue.sla_breaches_at, elapsed(sla_moment(issue, moment), moment, issue.sla_timezone), issue.sla_timezone
    )


def sla_breach_key(issue: Issue) -> tuple[bool, float, str]:
    """The key the SLA breach sort climbs: soonest breach first, issues with no running timer last.

    A paused timer sorts by the deadline it would have if it resumed now.
    """
    running = issue.sla_breaches_at is not None and issue.archived_at is None
    breaches = effective_breach(issue) if running else None
    return (not running, breaches.timestamp() if breaches is not None else 0.0, issue.issue_id)


def team_sla_settings(repositories: Repositories, workspace_id: str, team_id: str) -> SlaSettings:
    """A team's SLA rules, the off default when none were saved."""
    stored = repositories.team_config.get_sla_settings(workspace_id, team_id)
    return stored or default_sla_settings(workspace_id, team_id)


def team_clock_zone(repositories: Repositories, settings: SlaSettings) -> str | None:
    """The timezone a team's new timers skip weekends in, `None` for calendar time.

    Reads the team row only when the team counts business days.
    """
    if settings.calendar != "business_days":
        return None
    return settings.clock_zone(team_timezone(repositories, settings.workspace_id, settings.team_id))


def recalendar(issue: Issue, zone: str | None) -> bool:
    """Move a running timer onto the clock `zone` names in place, answering whether anything changed.

    Keeps the start and the window the timer had, measured on its old clock, and
    lays that window out again on the new one, so a day-long calendar timer
    becomes a timer of one business day from the same start. A paused timer
    keeps its pause.
    """
    if issue.sla_breaches_at is None:
        changed = issue.sla_timezone is not None
        issue.sla_timezone = None
        return changed
    if issue.sla_timezone == zone:
        return False
    start = issue.sla_started_at or issue.sla_breaches_at
    window = elapsed(start, issue.sla_breaches_at, issue.sla_timezone)
    issue.sla_breaches_at = advance(start, window, zone)
    issue.sla_timezone = zone
    return True


def _category(repositories: Repositories, issue: Issue) -> str:
    """The category of the status an issue sits in, empty when the status is gone."""
    row = repositories.team_config.get_status(issue.workspace_id, issue.team_id, issue.status_id)
    return row.category if row is not None else ""


def apply_sla(repositories: Repositories, previous: Issue | None, updated: Issue, now: datetime | None = None) -> None:
    """Start, move, keep or drop `updated`'s SLA timer in place, given the row it replaces.

    `previous` is `None` for a new issue. Reads the team's rules and the status
    only when a watched field moved, so an edit to the title costs nothing. A
    status or team move also restamps `started_at`, `completed_at` and
    `cancelled_at` through `stamp_completion`, `status_changed_at` through
    `stamp_status_change`, stamps triage entry and exit
    through `stamp_triage`, and pauses or resumes the timer through `hold_sla`.
    """
    if previous is not None and all(getattr(previous, name) == getattr(updated, name) for name in WATCHED_FIELDS):
        return
    stamp_triage(previous, updated, now)
    stamp_status_change(previous, updated, now)
    category: str | None = None
    if previous is None or previous.status_id != updated.status_id or previous.team_id != updated.team_id:
        category = _category(repositories, updated)
        stamp_completion(updated, category, now)
    if updated.archived_at is not None:
        _clear(updated)
        return
    settings: SlaSettings | None = None
    if updated.in_triage:
        settings = team_sla_settings(repositories, updated.workspace_id, updated.team_id)
        if settings.start_mode != "on_creation":
            _clear(updated)
            return
    if (category if category is not None else _category(repositories, updated)) in FINISHED_CATEGORIES:
        _clear(updated)
        return
    settings = settings or team_sla_settings(repositories, updated.workspace_id, updated.team_id)
    hours = settings.hours_for(updated.priority)
    priority_moved = previous is not None and previous.priority != updated.priority
    team_moved = previous is not None and previous.team_id != updated.team_id
    moment = now or utc_now()
    if hours is None:
        if previous is None or priority_moved or team_moved or updated.sla_breaches_at is None:
            _clear(updated)
            return
    else:
        zone = team_clock_zone(repositories, settings)
        if updated.sla_started_at is None or updated.sla_breaches_at is None:
            start = _timer_start(previous, updated, settings, moment)
            updated.sla_started_at = start
            updated.sla_breaches_at = advance(start, timedelta(hours=hours), zone)
            updated.sla_timezone = zone
            updated.sla_paused_at = None
        elif priority_moved or team_moved:
            updated.sla_breaches_at = advance(updated.sla_started_at, timedelta(hours=hours), zone)
            updated.sla_timezone = zone
        else:
            recalendar(updated, zone)
    hold_sla(updated, settings.pauses_in(updated.status_id), moment)


def _reopened(previous: Issue | None) -> bool:
    """Whether the row an issue replaces was finished or archived, so its next timer is a new window."""
    if previous is None:
        return False
    return previous.completed_at is not None or previous.cancelled_at is not None or previous.archived_at is not None


def _timer_start(previous: Issue | None, updated: Issue, settings: SlaSettings, moment: datetime) -> datetime:
    """The moment a new timer counts from: `created_at` in creation mode, unless the issue reopened, else `moment`."""
    if settings.start_mode == "on_creation" and not _reopened(previous):
        return min(updated.created_at, moment)
    return moment


def hold_sla(issue: Issue, paused: bool, now: datetime | None = None) -> bool:
    """Pause or resume `issue`'s running timer in place, answering whether anything changed.

    Pausing stamps the moment once, so a move between two paused statuses keeps
    the first one. Resuming moves the start and the deadline on by the time the
    timer stood still, counted on the timer's own clock so a pause over a weekend
    costs a business-days timer nothing, and clears the stamp.
    """
    if issue.sla_breaches_at is None:
        changed = issue.sla_paused_at is not None or issue.sla_timezone is not None
        issue.sla_paused_at = None
        issue.sla_timezone = None
        return changed
    moment = now or utc_now()
    if paused:
        if issue.sla_paused_at is not None:
            return False
        issue.sla_paused_at = moment
        return True
    if issue.sla_paused_at is None:
        return False
    zone = issue.sla_timezone
    held = max(elapsed(issue.sla_paused_at, moment, zone), timedelta(0))
    issue.sla_breaches_at = advance(issue.sla_breaches_at, held, zone)
    if issue.sla_started_at is not None:
        issue.sla_started_at = advance(issue.sla_started_at, held, zone)
    issue.sla_paused_at = None
    return True


def retime_column(
    repositories: Repositories, workspace_id: str, team_id: str, status_id: str, paused: bool, now: datetime
) -> int:
    """Pause or resume the timers of one team's issues in one status, answering how many changed.

    Run when a team adds a status to its paused set or takes one out, so issues
    already sitting there follow the new rule without waiting for a move. Reads
    the column through the same index as the SLA sweeps, at most a few hundred
    issues; any beyond that catch up on their next move.
    """
    changed = 0
    for issue in repositories.issues.iter_with_sla(workspace_id, team_id, status_id):

        def change(current: Issue) -> Issue | None:
            """The issue with its timer held or resumed, or `None` when it already follows the rule."""
            if current.status_id != status_id or current.team_id != team_id:
                return None
            moved = current.model_copy()
            return moved if hold_sla(moved, paused, now) else None

        if repositories.issues.replace_with(issue, change) is not None:
            changed += 1
    return changed


RECALENDAR_PER_STATUS = 500
"""The most timers one mode switch converts in one status column; any beyond catch up on their next move."""


def recalendar_team(repositories: Repositories, workspace_id: str, team_id: str, zone: str | None) -> int:
    """Move every running timer of one team's open issues onto the clock `zone` names, answering how many moved.

    Run when a team switches between calendar time and business days, or moves
    timezone while counting business days, so open timers follow the new clock
    at once, each keeping its start. Reads each open status column through the
    same index as `retime_column`; an issue the pass misses converts on its next
    watched-field change through `apply_sla`.
    """
    changed = 0
    for row in repositories.team_config.list_statuses(workspace_id, team_id):
        if row.category in FINISHED_CATEGORIES:
            continue
        for issue in repositories.issues.iter_with_sla(
            workspace_id, team_id, row.status_id, max_items=RECALENDAR_PER_STATUS
        ):

            def change(current: Issue) -> Issue | None:
                """The issue on the new clock, or `None` when it already runs on it or left the team."""
                if current.team_id != team_id or current.archived_at is not None:
                    return None
                moved = current.model_copy()
                return moved if recalendar(moved, zone) else None

            if repositories.issues.replace_with(issue, change) is not None:
                changed += 1
    return changed


def stamp_completion(issue: Issue, category: str, now: datetime | None = None) -> None:
    """Keep `started_at`, `completed_at` and `cancelled_at` in step with the status category an issue now sits in.

    `started_at` is set the first time the issue lands in a started status and
    kept from then on, reopened or not. `completed_at` and `cancelled_at` are set
    when the issue first lands in a completed or cancelled status, kept while it
    stays there, so a move between two done columns or teams keeps the original
    moment, and cleared when it leaves. Run from `apply_sla` because every status
    write already passes through there.
    """
    moment = now or utc_now()
    if category == STARTED_CATEGORY and issue.started_at is None:
        issue.started_at = moment
    if category != COMPLETED_CATEGORY:
        issue.completed_at = None
    elif issue.completed_at is None:
        issue.completed_at = moment
    if category != CANCELLED_CATEGORY:
        issue.cancelled_at = None
    elif issue.cancelled_at is None:
        issue.cancelled_at = moment


def stamp_status_change(previous: Issue | None, updated: Issue, now: datetime | None = None) -> None:
    """Stamp `status_changed_at` when an issue enters a status, so lists can show time in status.

    A new issue enters its status when it is created. A move of status, of team
    or into or out of triage is a new status, and any other edit keeps the stamp.
    """
    if previous is None:
        updated.status_changed_at = updated.status_changed_at or updated.created_at
        return
    if (
        previous.status_id == updated.status_id
        and previous.team_id == updated.team_id
        and previous.in_triage == updated.in_triage
    ):
        return
    updated.status_changed_at = now or utc_now()


def stamp_triage(previous: Issue | None, updated: Issue, now: datetime | None = None) -> None:
    """Stamp `triage_entered_at` when an issue enters triage and `triaged_at` when it leaves.

    Entering clears any earlier exit so a re-triaged issue measures its latest
    stay. Leaving keeps the entry stamp, so the pair spans the time in triage.
    """
    was = previous.in_triage if previous is not None else False
    if updated.in_triage == was:
        return
    moment = now or utc_now()
    if updated.in_triage:
        updated.triage_entered_at = moment
        updated.triaged_at = None
    else:
        updated.triaged_at = moment


def _clear(issue: Issue) -> None:
    """Drop an issue's SLA timer."""
    issue.sla_started_at = None
    issue.sla_breaches_at = None
    issue.sla_paused_at = None
    issue.sla_timezone = None
