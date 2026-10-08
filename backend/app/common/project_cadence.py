"""When a project's next status update is due, and the hook a due update is announced through.

A project's cadence is its own `update_interval_days`, or the workspace default
when it has none; 0 turns reminders off. The clock starts at the latest update,
or the start date, or the moment the project was made, so posting an update
always moves the next due date a full interval out. A project is due on that
date and overdue once `OVERDUE_GRACE` has passed it. Completed, canceled and
paused projects never come due.

Everything here is computed on read rather than stored, so changing a cadence
or posting an update moves the due date at once with no row to keep in step.
Held in `common` because the planning routes, the MCP tools and the views
reminder sweep all read it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from typing import Any, Callable, Literal, Optional, Protocol

from webbpulse.events import EventEnvelope, enqueue

from app.common.core.config import settings
from app.common.db.dynamo.planning import Project

INTERVAL_OPTIONS: tuple[int, ...] = (0, 7, 14, 30)
"""The cadences a project or a workspace may choose: off, weekly, every two weeks and monthly."""

DEFAULT_INTERVAL_DAYS = 7
"""The cadence a workspace starts with."""

OVERDUE_GRACE = timedelta(days=3)
"""How long past its due date an update reads as overdue rather than due."""

EXEMPT_STATUSES: frozenset[str] = frozenset({"completed", "canceled", "paused"})
"""The project statuses that never come due."""

UpdateDueState = Literal["upcoming", "due", "overdue"]

UPDATE_DUE_STATES: tuple[str, ...] = ("upcoming", "due", "overdue")

_log = logging.getLogger(__name__)


class _WorkspaceLookup(Protocol):
    """The one workspace read the default cadence needs."""

    def get(self, workspace_id: str) -> object | None:
        """The workspace row, or `None`."""
        ...


def check_interval(value: Optional[int]) -> Optional[int]:
    """Hold a cadence to the allowed options, passing `None` through."""
    if value is None:
        return None
    if isinstance(value, bool) or value not in INTERVAL_OPTIONS:
        options = ", ".join(str(option) for option in INTERVAL_OPTIONS)
        raise ValueError(f"update_interval_days must be one of: {options}")
    return value


def workspace_interval(workspaces: _WorkspaceLookup, workspace_id: str) -> int:
    """The workspace's default cadence, or the product default when the row is gone."""
    workspace = workspaces.get(workspace_id)
    value = getattr(workspace, "project_update_interval_days", None)
    return value if isinstance(value, int) else DEFAULT_INTERVAL_DAYS


def effective_interval(project: Project, default_days: int) -> int:
    """The cadence this project follows: its own, or the workspace's when it has none."""
    return project.update_interval_days if project.update_interval_days is not None else default_days


def update_anchor(project: Project) -> datetime:
    """The moment the cadence counts from: the latest update, the start date, or creation."""
    if project.last_update_at is not None:
        return _aware(project.last_update_at)
    if project.start_date:
        try:
            day = datetime.strptime(project.start_date, "%Y-%m-%d").date()
        except ValueError:
            return _aware(project.created_at)
        return datetime.combine(day, time.min, tzinfo=timezone.utc)
    return _aware(project.created_at)


def next_update_due_at(project: Project, default_days: int) -> datetime | None:
    """When this project's next update is due, or `None` when it is never due."""
    interval = effective_interval(project, default_days)
    if interval <= 0 or project.status in EXEMPT_STATUSES:
        return None
    return update_anchor(project) + timedelta(days=interval)


def update_due_state(project: Project, default_days: int, now: datetime | None = None) -> UpdateDueState | None:
    """Whether this project's update is upcoming, due or overdue, or `None` when it is never due."""
    due_at = next_update_due_at(project, default_days)
    if due_at is None:
        return None
    moment = _aware(now or datetime.now(timezone.utc))
    if moment < due_at:
        return "upcoming"
    if moment < due_at + OVERDUE_GRACE:
        return "due"
    return "overdue"


@dataclass(frozen=True)
class ProjectUpdateDue:
    """One project whose update came due, announced once per due date."""

    workspace_id: str
    project_id: str
    project_name: str
    team_ids: tuple[str, ...]
    lead_id: Optional[str]
    due_at: datetime
    interval_days: int


UpdateDueListener = Callable[[ProjectUpdateDue], None]

_listeners: list[UpdateDueListener] = []


def register_update_due_listener(listener: UpdateDueListener) -> None:
    """Have `listener` called with every project update that comes due, such as a webhook sender."""
    if listener not in _listeners:
        _listeners.append(listener)


def unregister_update_due_listener(listener: UpdateDueListener) -> None:
    """Stop calling `listener`, for a test that registered one."""
    if listener in _listeners:
        _listeners.remove(listener)


def emit_update_due(event: ProjectUpdateDue) -> None:
    """Hand one due update to every listener, so one failing listener never blocks the rest."""
    for listener in list(_listeners):
        try:
            listener(event)
        except Exception:
            _log.exception(
                "A project update due listener failed.",
                extra={
                    "event": "planning.project_update_due.listener_failed",
                    "workspace_id": event.workspace_id,
                    "project_id": event.project_id,
                },
            )


CHANNEL_UPDATE_DUE_JOB = "channel.project_update_due"
"""The dispatch job kind that posts a due project update to the team channels."""


def queue_update_due_announcement(event: ProjectUpdateDue, *, send: Callable[..., Any] | None = None) -> bool:
    """Queue the channel announcement of one due update, answering whether a job was queued.

    The reminder sweep runs in the views image, which neither imports the
    integrations domain nor holds its channel tables, so it hands the due date to
    the dispatch consumer, which posts it through the channels. The job names the
    project and due date alone, and the channel delivery ids are derived from
    them, so a job queued twice posts once. Nothing is queued in an environment
    without the dispatch queue.
    """
    if not settings.WEBHOOK_DISPATCH_QUEUE_URL:
        return False
    (send or enqueue)(
        settings.WEBHOOK_DISPATCH_QUEUE_URL,
        EventEnvelope(
            name=CHANNEL_UPDATE_DUE_JOB,
            payload={
                "kind": CHANNEL_UPDATE_DUE_JOB,
                "workspace_id": event.workspace_id,
                "project_id": event.project_id,
                "due_at": _aware(event.due_at).isoformat(),
            },
            scope=event.workspace_id,
        ),
    )
    return True


def _aware(moment: datetime) -> datetime:
    """A moment read as UTC when it carries no zone."""
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)
