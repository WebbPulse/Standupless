"""The initiative update report: nothing on a first update, then one line per thing that moved.

The properties held are that a first update and one from before snapshots carry
no lines, that an unchanged initiative reports nothing, that each changed field
and each project count that moved gets one line in a fixed order, and that a
hidden report carries no lines at all.
"""

from __future__ import annotations

from typing import Any

from app.common.db.dynamo.planning import InitiativeUpdateSnapshot
from app.common.initiative_update_report import report_lines, update_report


def _snapshot(**fields: Any) -> InitiativeUpdateSnapshot:
    """A snapshot of an active initiative with three projects, overridden by `fields`."""
    values: "dict[str, Any]" = {
        "owner_id": "u1",
        "owner_name": "Ada",
        "status": "active",
        "health": "on_track",
        "project_count": 3,
        "projects_by_status": {"planned": 2, "in_progress": 1},
        "projects_by_health": {"on_track": 1},
    }
    values.update(fields)
    return InitiativeUpdateSnapshot(**values)


def test_a_first_update_carries_no_report() -> None:
    """With nothing to compare with there is no diff to show."""
    assert report_lines(_snapshot(), None) == []
    assert update_report(_snapshot(), None, False) == []


def test_an_update_from_before_snapshots_or_a_hidden_one_carries_no_report() -> None:
    """No snapshot of its own, or its author's choice to hide it, means no lines."""
    assert update_report(None, _snapshot(), False) == []
    assert update_report(_snapshot(status="completed"), _snapshot(), True) == []


def test_an_unchanged_initiative_reports_nothing() -> None:
    """Two equal snapshots make an empty diff."""
    assert report_lines(_snapshot(), _snapshot()) == []


def test_every_change_gets_one_line_in_order() -> None:
    """Status, target, health, owner, then the project counts by status and by health."""
    previous = _snapshot(target_date="2026-09-30", target_date_resolution="quarter")
    snapshot = _snapshot(
        status="completed",
        target_date="2026-12-31",
        target_date_resolution="quarter",
        health="at_risk",
        owner_id="u2",
        owner_name="Grace",
        project_count=4,
        projects_by_status={"planned": 1, "in_progress": 2, "completed": 1},
        projects_by_health={"on_track": 1, "at_risk": 2},
    )

    assert report_lines(snapshot, previous) == [
        "Status changed from Active to Completed",
        "Target date moved from Q3 2026 to Q4 2026",
        "Health changed from On track to At risk",
        "New owner Grace",
        "Projects 3 to 4",
        "Projects planned 2 to 1",
        "Projects in progress 1 to 2",
        "Projects completed 0 to 1",
        "Projects at risk 0 to 2",
    ]


def test_a_target_set_or_removed_and_an_owner_removed_read_plainly() -> None:
    """A date with nothing before it is set, one with nothing after it is removed."""
    assert report_lines(_snapshot(target_date="2026-11-02"), _snapshot()) == ["Target date set to 2026-11-02"]
    assert report_lines(_snapshot(), _snapshot(target_date="2026-11-02")) == ["Target date removed, was 2026-11-02"]
    assert report_lines(_snapshot(owner_id=None, owner_name=None), _snapshot()) == ["Owner removed"]
