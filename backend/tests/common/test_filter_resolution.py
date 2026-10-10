"""Relative cycles and the cycle check, held directly rather than through a route.

`current`, `next` and `previous` name a different cycle in each team and on each
day, so a saved view follows the schedule. A cycle value naming nothing is refused
with a 400 that names it rather than quietly matching no issue.
"""

from __future__ import annotations

from datetime import date

import pytest
from fastapi import HTTPException

from app.common.db.dynamo.planning import Cycle, cycle_key
from app.common.filter_resolution import NO_CYCLE_MATCH, _resolve_cycles, relative_cycle

TODAY = date(2026, 3, 10)


def _cycle(cycle_id: str, start: str, end: str, *, team: str = "T1", cancelled: bool = False) -> Cycle:
    """One in-memory cycle of a team."""
    return Cycle(
        workspace_id="ws",
        planning_key=cycle_key(team, cycle_id),
        cycle_id=cycle_id,
        team_id=team,
        name=cycle_id,
        start_date=start,
        end_date=end,
        cancelled=cancelled,
    )


SCHEDULE = [
    _cycle("P2", "2026-02-01", "2026-02-14"),
    _cycle("P1", "2026-02-15", "2026-02-28"),
    _cycle("C", "2026-03-01", "2026-03-14"),
    _cycle("N1", "2026-03-15", "2026-03-28"),
    _cycle("N2", "2026-03-29", "2026-04-11"),
    _cycle("X", "2026-03-15", "2026-03-20", cancelled=True),
]


@pytest.mark.parametrize(("which", "expected"), [("current", "C"), ("next", "N1"), ("previous", "P1")])
def test_relative_cycles_follow_the_day(which: str, expected: str) -> None:
    """The nearest live cycle on each side of today, skipping a cancelled one."""
    found = relative_cycle(SCHEDULE, which, TODAY)

    assert found is not None and found.cycle_id == expected


def test_relative_values_resolve_per_team() -> None:
    """Each team's own current cycle, so a workspace view spans them all."""
    by_team = {"T1": SCHEDULE, "T2": [_cycle("C2", "2026-03-05", "2026-03-18", team="T2")]}

    assert _resolve_cycles(frozenset({"current"}), by_team, TODAY) == frozenset({"C", "C2"})


def test_a_relative_value_with_no_cycle_matches_nothing() -> None:
    """An empty set would mean no filter, so a sentinel no issue carries stands in."""
    resolved = _resolve_cycles(frozenset({"next"}), {"T1": [_cycle("C", "2026-03-01", "2026-03-14")]}, TODAY)

    assert resolved == frozenset({NO_CYCLE_MATCH})


def test_none_and_known_ids_pass_through() -> None:
    """`none` and a real cycle id are kept as they are."""
    assert _resolve_cycles(frozenset({None, "P2"}), {"T1": SCHEDULE}, TODAY) == frozenset({None, "P2"})


def test_an_unknown_cycle_is_a_400_naming_it() -> None:
    """A typo or a cycle of another team is refused, naming the value."""
    with pytest.raises(HTTPException) as caught:
        _resolve_cycles(frozenset({"nope"}), {"T1": SCHEDULE}, TODAY)

    assert caught.value.status_code == 400
    assert caught.value.detail["value"] == "nope"
    assert "nope" in caught.value.detail["message"]
