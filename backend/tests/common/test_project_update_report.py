"""The project update progress report: a baseline first, then only what changed.

The properties held are that progress shows only once it moved by more than two
points, that each changed field gets one line and an unchanged one none, that a
milestone reads as completed once and only once, and that a hidden report or an
update from before snapshots carries no lines at all.
"""

from __future__ import annotations

from typing import Any

from app.common.db.dynamo.planning import MilestoneSnapshot, ProjectUpdateSnapshot
from app.common.project_update_report import report_for_item, report_lines, whole_percent


def _snapshot(**fields: Any) -> ProjectUpdateSnapshot:
    """A snapshot of a twenty issue project, overridden by `fields`."""
    values: "dict[str, Any]" = {"completed": 8, "total": 20, "percent": 40}
    values.update(fields)
    return ProjectUpdateSnapshot(**values)


def test_whole_percent_rounds_halves_up_and_survives_an_empty_scope() -> None:
    """The same rounding the web client uses, and no division by zero."""
    assert whole_percent(1, 8) == 13
    assert whole_percent(1, 3) == 33
    assert whole_percent(0, 0) == 0


def test_a_first_update_reads_as_a_baseline() -> None:
    """With nothing to compare with, every set value is listed as it stands."""
    snapshot = _snapshot(
        target_date="2026-09-30",
        target_date_resolution="quarter",
        lead_id="u1",
        lead_name="Ada",
        status_name="In progress",
        milestones=[
            MilestoneSnapshot(milestone_id="m1", name="Alpha", completed=3, total=3),
            MilestoneSnapshot(milestone_id="m2", name="Beta", completed=1, total=4),
        ],
    )

    assert report_lines(snapshot, None) == [
        "Progress 40% (8 of 20 issues)",
        "Target date Q3 2026",
        "Lead Ada",
        "Status In progress",
        "Milestone Alpha completed",
        "Milestone Beta 1 of 4",
    ]


def test_an_unchanged_project_reports_nothing() -> None:
    """Two equal snapshots make an empty diff."""
    assert report_lines(_snapshot(), _snapshot()) == []


def test_progress_shows_only_once_it_moved_by_more_than_two_points() -> None:
    """A two point move is noise; three points is news, with the scope change when it moved."""
    assert report_lines(_snapshot(completed=9, percent=42), _snapshot()) == []
    assert report_lines(_snapshot(completed=9, percent=43), _snapshot()) == ["Progress 40% to 43% (9 of 20 issues)"]
    assert report_lines(_snapshot(total=30, percent=30), _snapshot()) == ["Progress 40% to 30%, scope 20 to 30 issues"]


def test_target_lead_and_status_changes_each_get_a_line() -> None:
    """Moved, set and removed each read differently."""
    before = _snapshot(target_date="2026-11-01", lead_id="u1", lead_name="Ada", status_name="Planned")
    after = _snapshot(target_date="2026-12-01", lead_id="u2", lead_name="Grace", status_name="In progress")
    assert report_lines(after, before) == [
        "Target date moved from 2026-11-01 to 2026-12-01",
        "New lead Grace",
        "Status changed from Planned to In progress",
    ]
    assert report_lines(_snapshot(), before) == ["Target date removed, was 2026-11-01", "Lead removed"]
    assert report_lines(before, _snapshot()) == [
        "Target date set to 2026-11-01",
        "New lead Ada",
        "Status set to Planned",
    ]


def test_milestones_report_movement_and_completion_once() -> None:
    """A finished milestone is named once, an untouched one never, and a new one by its count."""
    before = _snapshot(
        milestones=[
            MilestoneSnapshot(milestone_id="m1", name="Alpha", completed=2, total=3),
            MilestoneSnapshot(milestone_id="m2", name="Beta", completed=1, total=4),
            MilestoneSnapshot(milestone_id="m3", name="Gamma", completed=5, total=5),
        ]
    )
    after = _snapshot(
        milestones=[
            MilestoneSnapshot(milestone_id="m1", name="Alpha", completed=3, total=3),
            MilestoneSnapshot(milestone_id="m2", name="Beta", completed=2, total=4),
            MilestoneSnapshot(milestone_id="m3", name="Gamma", completed=5, total=5),
            MilestoneSnapshot(milestone_id="m4", name="Delta", completed=0, total=2),
        ]
    )

    assert report_lines(after, before) == [
        "Milestone Alpha completed",
        "Milestone Beta 1 of 4 to 2 of 4",
        "Milestone Delta 0 of 2",
    ]


def test_a_hidden_report_or_an_update_without_a_snapshot_has_no_lines() -> None:
    """Updates posted before snapshots, and ones whose author hid the report, stay plain."""
    stored = _snapshot().model_dump(mode="json")
    assert report_for_item({"body": "Old"}) == []
    assert report_for_item({"snapshot": stored, "hide_details": True}) == []
    assert report_for_item({"snapshot": stored}) == ["Progress 40% (8 of 20 issues)"]
    assert report_for_item({"snapshot": stored, "previous_snapshot": stored}) == []
