"""Queueing the team channel posts of a cycle starting and a cycle completing.

A cycle's status is derived from its dates, so nothing is written the moment one
starts or ends. The two places that act on that moment announce it: the hourly
cycle close in the issues function, the day after a cycle's last day, and "Start
cycle today" in the planning routes and the MCP tools. Neither image imports the
integrations domain nor holds its channel tables, so each hands the cycle to the
dispatch consumer, which posts it through the team's channels.

The job names the cycle and the moment it started or ended, and the channel
delivery ids derive from them, so a job queued once per hourly sweep, or by both
the early start and the next sweep, posts once. A completion carries the counts
taken when it was first queued; a later copy with other counts lands on the same
delivery rows and is dropped there. Nothing is queued in an environment without
the dispatch queue, and a queue that cannot be reached is logged rather than
raised, so a post is the one part of a cycle change that may be lost.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable

from webbpulse.events import EventEnvelope, enqueue

from app.common.core.config import settings
from app.common.db.dynamo.planning import Cycle

_log = logging.getLogger(__name__)

CHANNEL_CYCLE_JOB = "channel.cycle"
"""The dispatch job kind that posts a cycle start or completion to the team channels."""

CYCLE_STARTED = "cycle_started"

CYCLE_COMPLETED = "cycle_completed"


@dataclass(frozen=True)
class CycleTally:
    """What a completed cycle held: the issues it meant to finish, the finished ones and the ones rolled on."""

    scope: int = 0
    completed: int = 0
    rolled_over: int = 0


def tally_cycle(repositories: Any, workspace_id: str, team_id: str, cycle_id: str) -> CycleTally:
    """Count one cycle's issues before a rollover moves any: every one not cancelled, and the completed ones.

    An issue whose status the team does not know counts toward the scope and
    not toward the completed ones.
    """
    categories = {row.status_id: row.category for row in repositories.team_config.list_statuses(workspace_id, team_id)}
    scope = 0
    completed = 0
    for issue in repositories.issues.iter_for_cycle(workspace_id, team_id, cycle_id):
        category = categories.get(issue.status_id)
        if category == "cancelled":
            continue
        scope += 1
        if category == "completed":
            completed += 1
    return CycleTally(scope=scope, completed=completed)


def queue_cycle_announcement(
    cycle: Cycle,
    event: str,
    tally: CycleTally | None = None,
    *,
    send: Callable[..., Any] | None = None,
) -> bool:
    """Queue the channel post of one cycle starting or completing, answering whether a job was queued."""
    if not settings.WEBHOOK_DISPATCH_QUEUE_URL:
        return False
    payload: dict[str, Any] = {
        "kind": CHANNEL_CYCLE_JOB,
        "event": event,
        "workspace_id": cycle.workspace_id,
        "team_id": cycle.team_id,
        "cycle_id": cycle.cycle_id,
        "date": cycle.start_date if event == CYCLE_STARTED else cycle.end_date,
    }
    if tally is not None:
        payload.update(scope=tally.scope, completed=tally.completed, rolled_over=tally.rolled_over)
    try:
        (send or enqueue)(
            settings.WEBHOOK_DISPATCH_QUEUE_URL,
            EventEnvelope(name=CHANNEL_CYCLE_JOB, payload=payload, scope=cycle.workspace_id),
        )
    except Exception:
        _log.exception(
            "Could not queue a cycle announcement.",
            extra={
                "event": "planning.cycle_announcement.queue_failed",
                "workspace_id": cycle.workspace_id,
                "cycle_id": cycle.cycle_id,
                "kind": event,
            },
        )
        return False
    return True
