"""When an issue joined its cycle and the "Added to cycle" filter, held directly rather than through a route.

An issue added before its cycle began, or within the first day, was planned; one
added later was added after the start. An unstamped row reads as planned, and an
issue in no cycle, or in a cycle the filter cannot find, meets no value.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from app.common.cycle_added import cycle_added_phase, cycle_start_instant, stamp_cycle_added
from app.common.db.dynamo.issues import Issue
from app.common.issue_filters import InvalidFilterValue, build_issue_filter

CALLER = "01JB0000000000000000CALLER"

START = datetime(2026, 3, 2, tzinfo=UTC)

STARTS = {"c1": START}


def _issue(**fields: Any) -> Issue:
    """One in-memory issue with only the fields a test cares about set."""
    base: dict[str, Any] = {
        "workspace_id": "ws",
        "team_id": "team",
        "key": "ABC-1",
        "number": 1,
        "title": "An issue",
        "status_id": "todo",
        "created_by": CALLER,
        "created_at": START - timedelta(days=3),
    }
    base.update(fields)
    return Issue(**base)


def _filter(**wire: Any) -> Any:
    """A filter from wire names with the cycle starts attached the way resolution would."""
    return replace(build_issue_filter(user_id=CALLER, **wire), cycle_starts=STARTS)


def test_a_new_issue_in_a_cycle_reads_its_creation() -> None:
    """Created straight into a cycle, the issue joined it when it was created."""
    issue = _issue(cycle_id="c1")

    stamp_cycle_added(None, issue)

    assert issue.cycle_added_at == issue.created_at


def test_a_new_issue_with_no_cycle_carries_no_stamp() -> None:
    """No cycle, no moment."""
    issue = _issue(cycle_added_at=START)

    stamp_cycle_added(None, issue)

    assert issue.cycle_added_at is None


def test_a_move_stamps_now_and_a_removal_clears() -> None:
    """Joining another cycle restamps, leaving clears, and an unrelated edit keeps the stamp."""
    moment = START + timedelta(days=4)
    previous = _issue(cycle_id="c1", cycle_added_at=START)
    moved = previous.model_copy(update={"cycle_id": "c2"})
    stamp_cycle_added(previous, moved, moment)
    assert moved.cycle_added_at == moment

    retitled = moved.model_copy(update={"title": "Renamed"})
    stamp_cycle_added(moved, retitled, moment + timedelta(days=1))
    assert retitled.cycle_added_at == moment

    removed = retitled.model_copy(update={"cycle_id": None})
    stamp_cycle_added(retitled, removed, moment)
    assert removed.cycle_added_at is None


def test_the_first_day_still_counts_as_planned() -> None:
    """Up to 24 hours after the start is planned, a moment later is after the start."""
    assert cycle_added_phase(START - timedelta(days=2), START) == "planned"
    assert cycle_added_phase(START + timedelta(hours=24), START) == "planned"
    assert cycle_added_phase(START + timedelta(hours=24, seconds=1), START) == "after_start"
    assert cycle_added_phase(None, START) == "planned"


def test_a_cycle_starts_at_midnight_in_its_team_timezone() -> None:
    """The start day is read where the team works, and a malformed day has no start."""
    start = cycle_start_instant("2026-03-02", "America/Los_Angeles")

    assert start == datetime(2026, 3, 2, tzinfo=ZoneInfo("America/Los_Angeles"))
    assert start is not None and start.astimezone(UTC) == datetime(2026, 3, 2, 8, tzinfo=UTC)
    assert cycle_start_instant("not a day", "UTC") is None


def test_planned_and_after_start_split_a_cycle() -> None:
    """Each phase keeps its own issues, and the negation keeps the other."""
    planned = _issue(cycle_id="c1", cycle_added_at=START - timedelta(days=1))
    unstamped = _issue(cycle_id="c1")
    late = _issue(cycle_id="c1", cycle_added_at=START + timedelta(days=3))

    assert _filter(cycle_added="planned").matches(planned)
    assert _filter(cycle_added="planned").matches(unstamped)
    assert not _filter(cycle_added="planned").matches(late)
    assert _filter(cycle_added="after_start").matches(late)
    assert _filter(cycle_added_not="after_start").matches(planned)
    assert not _filter(cycle_added_not="after_start").matches(late)


def test_an_issue_in_no_cycle_or_a_dead_one_never_matches() -> None:
    """No cycle or a deleted one meets neither phase nor either negation, and no cycle meets no date bound."""
    loose = _issue(cycle_added_at=START)
    orphaned = _issue(cycle_id="gone", cycle_added_at=START)

    for issue in (loose, orphaned):
        assert not _filter(cycle_added="planned").matches(issue)
        assert not _filter(cycle_added_not="planned").matches(issue)
    assert not _filter(cycle_added_after="2026-01-01").matches(loose)


def test_the_date_bounds_compare_the_day_the_issue_joined() -> None:
    """Exclusive day bounds on `cycle_added_at`, and an unstamped issue meets none."""
    joined = _issue(cycle_id="c1", cycle_added_at=START + timedelta(days=3))

    assert _filter(cycle_added_after="2026-03-04").matches(joined)
    assert not _filter(cycle_added_after="2026-03-05").matches(joined)
    assert _filter(cycle_added_before="2026-03-06").matches(joined)
    assert not _filter(cycle_added_before="2026-03-05").matches(joined)
    assert not _filter(cycle_added_after="2026-01-01").matches(_issue(cycle_id="c1"))


def test_the_phase_works_inside_a_group() -> None:
    """A group carries the phase and reads the same attached starts."""
    late = _issue(cycle_id="c1", cycle_added_at=START + timedelta(days=3), priority="urgent")
    wanted = build_issue_filter(user_id=CALLER, groups=[{"cycle_added": "after_start", "priority": "urgent"}])
    resolved = replace(wanted, groups=tuple(replace(group, cycle_starts=STARTS) for group in wanted.groups))

    assert wanted.needs_cycle_starts
    assert resolved.matches(late)


def test_an_unknown_phase_is_refused() -> None:
    """Only planned and after_start are phases."""
    with pytest.raises(InvalidFilterValue):
        build_issue_filter(user_id=CALLER, cycle_added="sometime")
    with pytest.raises(InvalidFilterValue):
        build_issue_filter(user_id=CALLER, cycle_added_not=["planned", "late"])


def test_the_phase_is_part_of_the_fingerprint() -> None:
    """A cursor cut under one phase starts over under the other."""
    planned = build_issue_filter(user_id=CALLER, cycle_added="planned")
    after = build_issue_filter(user_id=CALLER, cycle_added="after_start")

    assert planned.fingerprint() != after.fingerprint()
