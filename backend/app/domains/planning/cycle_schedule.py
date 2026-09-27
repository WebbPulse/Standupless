"""The automatic cycles sweep: keeps every team with cycles on stocked with cycles.

An EventBridge Scheduler schedule invokes the planning rollup consumer hourly
with one synthetic record, the consumer route hands it here, and every team
whose cycle settings are on gets its missing current and upcoming cycles. It
runs in planning because cycles are planning rows. The generator is idempotent,
so a retried or overlapping run creates nothing twice, and one team failing is
logged and skipped so it never holds up the rest.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date
from typing import Any, Mapping

from app.common.cycle_schedule import ensure_cycles

_log = logging.getLogger(__name__)

CYCLE_SCHEDULE_SOURCE = "standupless.cycle-schedule"
"""The `eventSource` the schedule's synthetic record carries."""


def is_cycle_schedule(record: Mapping[str, Any]) -> bool:
    """Whether one record is the schedule's trigger rather than a stream record."""
    return str(record.get("eventSource", "")) == CYCLE_SCHEDULE_SOURCE


@dataclass
class ScheduleSummary:
    """What one sweep did, for the log line."""

    teams: int = 0
    created: int = 0
    skipped: int = 0
    failed: int = 0


def sweep(repositories: Any, today: date | None = None) -> ScheduleSummary:
    """Create the missing cycles of every team with automatic cycles on.

    A team that is gone or being deleted is skipped, so a settings row the
    team purge has not reached yet never brings cycles back.
    """
    summary = ScheduleSummary()
    for settings in repositories.team_config.iter_enabled_cycle_settings():
        if repositories.teams.get(settings.workspace_id, settings.team_id) is None:
            summary.skipped += 1
            continue
        summary.teams += 1
        try:
            result = ensure_cycles(repositories.planning, settings, today)
        except Exception:
            summary.failed += 1
            _log.exception(
                "Automatic cycles failed for a team.",
                extra={
                    "event": "planning.cycle_schedule_failed",
                    "workspace_id": settings.workspace_id,
                    "team_id": settings.team_id,
                },
            )
            continue
        summary.created += len(result.created)
    _log.info(
        "Stocked automatic cycles.",
        extra={
            "event": "planning.cycle_schedule",
            "teams": summary.teams,
            "cycles_created": summary.created,
            "skipped": summary.skipped,
            "failed": summary.failed,
        },
    )
    return summary
