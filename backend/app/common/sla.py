"""SLA timers: when an issue's deadline starts, when it breaches, and how close it is.

Follows Linear. A team's rules give each priority a number of hours. An open
issue with a ruled priority gets a timer when it is created, leaves triage, or
reopens; changing its priority keeps the start and moves the deadline to the new
priority's hours, or drops the timer when the new priority has no rule. Finishing
the issue, or sending it back to triage, drops the timer. A timer is never
restarted while it runs, so moving between open statuses leaves it alone.
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


def sla_status(issue: Issue, now: datetime | None = None) -> SlaStatus:
    """How an issue stands against its SLA at `now`, `none` when it carries no timer."""
    if issue.sla_breaches_at is None or issue.archived_at is not None:
        return "none"
    moment = now or utc_now()
    if moment >= issue.sla_breaches_at:
        return "breached"
    started = issue.sla_started_at or issue.sla_breaches_at
    if moment >= at_risk_from(started, issue.sla_breaches_at):
        return "at_risk"
    return "on_track"


def sla_breach_key(issue: Issue) -> tuple[bool, float, str]:
    """The key the SLA breach sort climbs: soonest breach first, issues with no running timer last."""
    running = issue.sla_breaches_at is not None and issue.archived_at is None
    breaches = issue.sla_breaches_at.timestamp() if running and issue.sla_breaches_at is not None else 0.0
    return (not running, breaches, issue.issue_id)


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
    only when a watched field moved, so an edit to the title costs nothing.
    """
    if previous is not None and all(getattr(previous, name) == getattr(updated, name) for name in WATCHED_FIELDS):
        return
    if updated.in_triage or updated.archived_at is not None or _category(repositories, updated) in FINISHED_CATEGORIES:
        _clear(updated)
        return
    hours = team_sla_settings(repositories, updated.workspace_id, updated.team_id).hours_for(updated.priority)
    priority_moved = previous is not None and previous.priority != updated.priority
    team_moved = previous is not None and previous.team_id != updated.team_id
    if hours is None:
        if previous is None or priority_moved or team_moved or updated.sla_breaches_at is None:
            _clear(updated)
        return
    if updated.sla_started_at is None or updated.sla_breaches_at is None:
        started = now or utc_now()
        updated.sla_started_at = started
        updated.sla_breaches_at = started + timedelta(hours=hours)
        return
    if priority_moved or team_moved:
        updated.sla_breaches_at = updated.sla_started_at + timedelta(hours=hours)


def _clear(issue: Issue) -> None:
    """Drop an issue's SLA timer."""
    issue.sla_started_at = None
    issue.sla_breaches_at = None
