"""Which of the scheduled sweeps the every minute notify digest flush also runs.

Each sweep runs once per window of its interval, the windows counted from the
epoch so an hourly one opens on the hour. The first tick in a window claims it
with a conditional put on the sweep's last pass marker, so a tick that lands late,
or a minute the schedule skipped, still runs that window's pass on the next tick
rather than waiting for the next aligned minute, and two ticks racing on one
window run it once. A pass that fails after its claim is retried in the next
window, and the per item markers each sweep keeps make the retry send nothing twice.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from app.common.api.dependencies.repositories import Repositories


def window_start(now: datetime, interval: timedelta) -> int:
    """The epoch second the window of `interval` holding `now` opens at."""
    step = int(interval.total_seconds())
    stamp = int(now.timestamp())
    return stamp - stamp % step


def claim_pass(repositories: Repositories, name: str, interval: timedelta, now: datetime) -> bool:
    """Whether the tick at `now` runs sweep `name`, claiming its window when it does."""
    return repositories.inbox.claim_sweep(name, window_start(now, interval), now)
