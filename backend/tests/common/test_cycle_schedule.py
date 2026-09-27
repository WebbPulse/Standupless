"""The automatic cycle generator: which cycles a team is missing, and creating them once.

The properties worth holding are that cycles land on the start weekday with the
chosen length and cooldown, that a team always ends up with a current cycle and
`upcoming_count` cycles ahead, that the chain never overlaps a cycle the team
already has, and that a second run creates nothing.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from app.common.cycle_schedule import (
    active_cycle,
    align_back,
    align_forward,
    auto_cycle_id,
    ensure_cycles,
    next_number,
    plan_cycles,
)
from app.common.db.dynamo.planning import Cycle, cycle_key
from app.common.db.dynamo.team_config import CycleSettings

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

TUESDAY = date(2026, 3, 10)


def _settings(**overrides: Any) -> CycleSettings:
    """Enabled settings for TEAM, with any field overridden."""
    values: "dict[str, Any]" = {
        "workspace_id": WORKSPACE,
        "config_key": f"team#{TEAM}#cycles",
        "team_id": TEAM,
        "enabled": True,
    }
    values.update(overrides)
    return CycleSettings(**values)


def _cycle(start: str, end: str, *, cancelled: bool = False, number: int | None = None, cid: str = "c1") -> Cycle:
    """One cycle of TEAM between two dates."""
    return Cycle(
        workspace_id=WORKSPACE,
        planning_key=cycle_key(TEAM, cid),
        cycle_id=cid,
        team_id=TEAM,
        name="Manual",
        start_date=start,
        end_date=end,
        cancelled=cancelled,
        number=number,
        created_by="someone",
    )


def test_alignment_lands_on_the_weekday() -> None:
    """Forward and back alignment both stop on the start weekday, and on it when already there."""
    assert align_forward(TUESDAY, 0) == date(2026, 3, 16)
    assert align_back(TUESDAY, 0) == date(2026, 3, 9)
    assert align_forward(date(2026, 3, 9), 0) == date(2026, 3, 9)
    assert align_back(TUESDAY, 1) == TUESDAY


def test_a_fresh_team_gets_a_current_cycle_and_its_upcoming_ones() -> None:
    """Two week cycles from Monday: the current one holds today, two follow back to back."""
    planned = plan_cycles(_settings(), [], TUESDAY)

    assert planned == [
        (date(2026, 3, 9), date(2026, 3, 22)),
        (date(2026, 3, 23), date(2026, 4, 5)),
        (date(2026, 4, 6), date(2026, 4, 19)),
    ]


def test_a_cooldown_leaves_a_gap_and_the_length_is_honoured() -> None:
    """One week cycles on Wednesday with a one week cooldown between them."""
    planned = plan_cycles(_settings(duration_weeks=1, cooldown_weeks=1, start_weekday=2, upcoming_count=2), [], TUESDAY)

    assert planned == [
        (date(2026, 3, 4), date(2026, 3, 10)),
        (date(2026, 3, 18), date(2026, 3, 24)),
        (date(2026, 4, 1), date(2026, 4, 7)),
    ]


def test_the_chain_continues_after_existing_cycles() -> None:
    """A hand made current cycle is kept and the upcoming ones start after it."""
    existing = [_cycle("2026-03-01", "2026-03-15")]

    planned = plan_cycles(_settings(upcoming_count=1), existing, TUESDAY)

    assert planned == [(date(2026, 3, 16), date(2026, 3, 29))]


def test_a_stocked_team_is_missing_nothing() -> None:
    """Enough upcoming cycles means nothing is planned."""
    existing = [
        _cycle("2026-03-09", "2026-03-22", cid="a"),
        _cycle("2026-03-23", "2026-04-05", cid="b"),
        _cycle("2026-04-06", "2026-04-19", cid="c"),
    ]

    assert plan_cycles(_settings(), existing, TUESDAY) == []


def test_a_cancelled_upcoming_cycle_is_not_counted_or_recreated() -> None:
    """The chain steps past a cancelled cycle rather than filling its slot again."""
    existing = [
        _cycle("2026-03-09", "2026-03-22", cid="a"),
        _cycle("2026-03-23", "2026-04-05", cid="b", cancelled=True),
    ]

    planned = plan_cycles(_settings(upcoming_count=1), existing, TUESDAY)

    assert planned == [(date(2026, 4, 6), date(2026, 4, 19))]


def test_a_lapsed_chain_restarts_without_overlapping() -> None:
    """When every cycle has ended, the new current cycle starts after the last one."""
    existing = [_cycle("2026-02-23", "2026-03-10")]

    planned = plan_cycles(_settings(upcoming_count=1), existing, date(2026, 3, 11))

    assert planned[0] == (date(2026, 3, 11), date(2026, 3, 22))
    assert planned[1] == (date(2026, 3, 23), date(2026, 4, 5))


def test_numbering_continues_past_manual_and_numbered_cycles() -> None:
    """The next number beats both the count of cycles and the highest stored number."""
    assert next_number([]) == 1
    assert next_number([_cycle("2026-01-01", "2026-01-14", cid="a")]) == 2
    assert next_number([_cycle("2026-01-01", "2026-01-14", number=7, cid="a")]) == 8


def test_active_cycle_skips_cancelled_ones() -> None:
    """The active cycle is the live one holding today."""
    live = _cycle("2026-03-09", "2026-03-22", cid="live")
    cancelled = _cycle("2026-03-01", "2026-03-20", cid="gone", cancelled=True)

    assert active_cycle([cancelled, live], TUESDAY) == live
    assert active_cycle([cancelled], TUESDAY) is None


def test_ensure_cycles_creates_numbered_cycles_once(repositories: Any) -> None:
    """The first run creates three numbered cycles; a second run creates none."""
    first = ensure_cycles(repositories.planning, _settings(), TUESDAY)
    second = ensure_cycles(repositories.planning, _settings(), TUESDAY)

    assert [c.name for c in first.created] == ["Cycle 1", "Cycle 2", "Cycle 3"]
    assert [c.cycle_id for c in first.created] == ["auto-20260309", "auto-20260323", "auto-20260406"]
    assert second.created == []
    stored = repositories.planning.list_for_roadmap(WORKSPACE, TEAM)
    assert [(c.number, c.created_by) for c in stored] == [(1, "system"), (2, "system"), (3, "system")]


def test_a_taken_key_counts_as_created_by_someone_else(repositories: Any) -> None:
    """A concurrent run's row is left alone and not reported as this run's."""
    racing = _cycle("2026-04-06", "2026-04-19", cid=auto_cycle_id(date(2026, 4, 6)))
    original_list = repositories.planning.list_for_roadmap

    repositories.planning.create_cycle(racing)
    repositories.planning.list_for_roadmap = lambda *_args, **_kwargs: []
    try:
        result = ensure_cycles(repositories.planning, _settings(), TUESDAY)
    finally:
        repositories.planning.list_for_roadmap = original_list

    assert [c.cycle_id for c in result.created] == ["auto-20260309", "auto-20260323"]
    assert len(repositories.planning.list_for_roadmap(WORKSPACE, TEAM)) == 3


def test_disabled_settings_create_nothing(repositories: Any) -> None:
    """Cycles off means the generator is a no-op."""
    assert ensure_cycles(repositories.planning, _settings(enabled=False), TUESDAY).created == []
    assert repositories.planning.list_for_roadmap(WORKSPACE, TEAM) == []
