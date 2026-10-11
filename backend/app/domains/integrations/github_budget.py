"""A cap on the GitHub calls one unit of bulk work makes: a share of the installation's hour, and a deadline.

The App installation's hourly budget is shared with live sync, so bulk work such
as the release backfill must leave most of it alone. Every repository call goes
through `github_issues._request`, which asks the active budget before calling and
hands it each answer's `X-RateLimit-*` headers. Outside a `capped` block nothing
is checked, so live sync is never stopped by it.
"""

from __future__ import annotations

import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterator, Mapping

RESERVE_SHARE = 0.5
"""The share of the installation's hourly budget bulk work leaves for live sync."""

RATE = "rate"

TIME = "time"


class BudgetSpent(Exception):
    """Bulk work must stop before its next GitHub call, for the rate budget or the deadline."""

    def __init__(self, reason: str, budget: "CallBudget") -> None:
        super().__init__(f"the GitHub call budget is spent ({reason})")
        self.reason = reason
        self.budget = budget


@dataclass
class CallBudget:
    """What GitHub last said about the installation's budget, and when this unit of work must stop."""

    deadline: float
    reserve_share: float = RESERVE_SHARE
    limit: int | None = None
    remaining: int | None = None
    reset_at: datetime | None = None
    calls: int = 0
    started: float = field(default_factory=time.monotonic)

    def until(self, seconds: float) -> None:
        """Move the deadline to `seconds` after this unit of work started, earlier or later."""
        self.deadline = self.started + seconds

    def floor(self) -> int | None:
        """The remaining calls below which this work stops, once GitHub has named its limit."""
        if self.limit is None:
            return None
        return int(self.limit * self.reserve_share)

    def low(self) -> bool:
        """Whether the installation is below the share kept for live sync."""
        floor = self.floor()
        return floor is not None and self.remaining is not None and self.remaining < floor

    def check(self) -> None:
        """Raise `BudgetSpent` when another call would eat into live sync's share or outrun the deadline."""
        if self.low():
            raise BudgetSpent(RATE, self)
        if time.monotonic() >= self.deadline:
            raise BudgetSpent(TIME, self)

    def observe(self, headers: Mapping[str, str]) -> None:
        """Keep the `X-RateLimit-*` headers of one answer."""
        self.calls += 1
        limit = _integer(headers.get("x-ratelimit-limit"))
        remaining = _integer(headers.get("x-ratelimit-remaining"))
        reset = _integer(headers.get("x-ratelimit-reset"))
        if limit is not None and limit > 0:
            self.limit = limit
        if remaining is not None:
            self.remaining = remaining
        if reset is not None:
            self.reset_at = datetime.fromtimestamp(reset, tz=timezone.utc)


def _integer(value: str | None) -> int | None:
    """A header's integer value, or `None` when it is absent or unreadable."""
    if value is None:
        return None
    try:
        return int(value.strip())
    except ValueError:
        return None


_active: ContextVar[CallBudget | None] = ContextVar("github_call_budget", default=None)


@contextmanager
def capped(seconds: float, *, reserve_share: float = RESERVE_SHARE) -> Iterator[CallBudget]:
    """Check every GitHub call inside the block against a budget that ends after `seconds`."""
    now = time.monotonic()
    budget = CallBudget(deadline=now + seconds, reserve_share=reserve_share, started=now)
    token = _active.set(budget)
    try:
        yield budget
    finally:
        _active.reset(token)


def before_call() -> None:
    """Raise `BudgetSpent` when the active budget, if any, refuses another call."""
    budget = _active.get()
    if budget is not None:
        budget.check()


def after_call(headers: Mapping[str, str]) -> None:
    """Hand one answer's headers to the active budget, if any."""
    budget = _active.get()
    if budget is not None:
        budget.observe(headers)
