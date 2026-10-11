"""The GitHub call budget bulk work runs under, read from GitHub's rate limit headers.

These hold that a repository call inside a `capped` block records the
installation's remaining budget and reset, that the next call is refused once
less than half the budget is left or the deadline has passed, and that calls
outside a block are never checked, so live sync cannot be stopped by it.
"""

from __future__ import annotations

from datetime import datetime, timezone

import httpx
import pytest

from app.domains.integrations import github_budget
from app.domains.integrations.github_issues import _request

RESET = 1_791_000_000


def _client(remaining: int, limit: int = 5000) -> httpx.Client:
    """A client whose every answer carries these rate limit headers."""

    def answer(request: httpx.Request) -> httpx.Response:
        """An empty list with GitHub's rate limit headers."""
        return httpx.Response(
            200,
            json=[],
            headers={
                "x-ratelimit-limit": str(limit),
                "x-ratelimit-remaining": str(remaining),
                "x-ratelimit-reset": str(RESET),
            },
        )

    return httpx.Client(transport=httpx.MockTransport(answer))


def test_a_capped_call_records_the_installation_budget() -> None:
    """The limit, the remaining calls and the reset come from the answer's headers."""
    with github_budget.capped(60) as budget:
        _request("GET", "/repositories/1/deployments", token="t", client=_client(4200))
    assert budget.calls == 1
    assert budget.limit == 5000
    assert budget.remaining == 4200
    assert budget.reset_at == datetime.fromtimestamp(RESET, tz=timezone.utc)


def test_a_call_below_half_the_budget_is_refused_before_it_is_made() -> None:
    """Once fewer than half the calls are left, the next call raises rather than reaching GitHub."""
    client = _client(2499)
    with github_budget.capped(60) as budget:
        _request("GET", "/repositories/1/deployments", token="t", client=client)
        with pytest.raises(github_budget.BudgetSpent) as spent:
            _request("GET", "/repositories/1/deployments", token="t", client=client)
    assert spent.value.reason == github_budget.RATE
    assert budget.calls == 1


def test_half_the_budget_or_more_keeps_calling() -> None:
    """Exactly half the budget left is still enough to call."""
    client = _client(2500)
    with github_budget.capped(60) as budget:
        _request("GET", "/repositories/1/deployments", token="t", client=client)
        _request("GET", "/repositories/1/deployments", token="t", client=client)
    assert budget.calls == 2


def test_a_call_after_the_deadline_is_refused() -> None:
    """A block whose time is up refuses the next call for time, not budget."""
    with github_budget.capped(0):
        with pytest.raises(github_budget.BudgetSpent) as spent:
            _request("GET", "/repositories/1/deployments", token="t", client=_client(4000))
    assert spent.value.reason == github_budget.TIME


def test_calls_outside_a_block_are_never_checked() -> None:
    """Live sync runs with no budget, however low the installation is."""
    client = _client(10)
    _request("GET", "/repositories/1/deployments", token="t", client=client)
    _request("GET", "/repositories/1/deployments", token="t", client=client)
