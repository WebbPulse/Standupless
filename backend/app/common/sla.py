"""SLA timers: when an issue's deadline starts, when it breaches, and how close it is.

Follows Linear. A team's rules give each priority a number of hours. An open
issue with a ruled priority gets a timer when it is created, leaves triage, or
reopens; changing its priority keeps the start and moves the deadline to the new
priority's hours, or drops the timer when the new priority has no rule. Finishing
the issue, or sending it back to triage, drops the timer. A timer is never
restarted while it runs, so moving between open statuses leaves it alone.

A team may also pick open statuses that pause the timer, the way Linear leaves
time in chosen statuses out of an SLA. Entering one stamps `sla_paused_at`, and
the status reads frozen at that moment. Leaving it moves both the start and the
deadline on by the time spent there, so the issue resumes with the time it had
left and a later priority change still counts from the shifted start.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Literal

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import SlaSettings, default_sla_settings

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


def at_risk_from(started_at: datetime, breaches_at: datetime) -> datetime:
    """The moment an SLA turns at risk: a quarter of its window left, at most a day."""
    window = breaches_at - started_at
    lead = min(window * AT_RISK_SHARE, AT_RISK_CAP)
    return breaches_at - lead


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
    if moment >= at_risk_from(started, issue.sla_breaches_at):
        return "at_risk"
    return "on_track"


def effective_breach(issue: Issue, now: datetime | None = None) -> datetime | None:
    """When an issue would breach if its timer resumed at `now`, its stored deadline when it runs."""
    if issue.sla_breaches_at is None:
        return None
    moment = now or utc_now()
    return issue.sla_breaches_at + (moment - sla_moment(issue, moment))


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


def _category(repositories: Repositories, issue: Issue) -> str:
    """The category of the status an issue sits in, empty when the status is gone."""
    row = repositories.team_config.get_status(issue.workspace_id, issue.team_id, issue.status_id)
    return row.category if row is not None else ""


def apply_sla(repositories: Repositories, previous: Issue | None, updated: Issue, now: datetime | None = None) -> None:
    """Start, move, keep or drop `updated`'s SLA timer in place, given the row it replaces.

    `previous` is `None` for a new issue. Reads the team's rules and the status
    only when a watched field moved, so an edit to the title costs nothing. A
    status or team move also restamps `started_at`, `completed_at` and
    `cancelled_at` through `stamp_completion`, stamps triage entry and exit
    through `stamp_triage`, and pauses or resumes the timer through `hold_sla`.
    """
    if previous is not None and all(getattr(previous, name) == getattr(updated, name) for name in WATCHED_FIELDS):
        return
    stamp_triage(previous, updated, now)
    category: str | None = None
    if previous is None or previous.status_id != updated.status_id or previous.team_id != updated.team_id:
        category = _category(repositories, updated)
        stamp_completion(updated, category, now)
    if updated.in_triage or updated.archived_at is not None:
        _clear(updated)
        return
    if (category if category is not None else _category(repositories, updated)) in FINISHED_CATEGORIES:
        _clear(updated)
        return
    settings = team_sla_settings(repositories, updated.workspace_id, updated.team_id)
    hours = settings.hours_for(updated.priority)
    priority_moved = previous is not None and previous.priority != updated.priority
    team_moved = previous is not None and previous.team_id != updated.team_id
    moment = now or utc_now()
    if hours is None:
        if previous is None or priority_moved or team_moved or updated.sla_breaches_at is None:
            _clear(updated)
            return
    elif updated.sla_started_at is None or updated.sla_breaches_at is None:
        updated.sla_started_at = moment
        updated.sla_breaches_at = moment + timedelta(hours=hours)
        updated.sla_paused_at = None
    elif priority_moved or team_moved:
        updated.sla_breaches_at = updated.sla_started_at + timedelta(hours=hours)
    hold_sla(updated, settings.pauses_in(updated.status_id), moment)


def hold_sla(issue: Issue, paused: bool, now: datetime | None = None) -> bool:
    """Pause or resume `issue`'s running timer in place, answering whether anything changed.

    Pausing stamps the moment once, so a move between two paused statuses keeps
    the first one. Resuming moves the start and the deadline on by the time the
    timer stood still and clears the stamp.
    """
    if issue.sla_breaches_at is None:
        changed = issue.sla_paused_at is not None
        issue.sla_paused_at = None
        return changed
    moment = now or utc_now()
    if paused:
        if issue.sla_paused_at is not None:
            return False
        issue.sla_paused_at = moment
        return True
    if issue.sla_paused_at is None:
        return False
    held = max(moment - issue.sla_paused_at, timedelta(0))
    issue.sla_breaches_at = issue.sla_breaches_at + held
    if issue.sla_started_at is not None:
        issue.sla_started_at = issue.sla_started_at + held
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
