"""The project update cadence: when an update is due, when it is overdue, and who never comes due."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from app.common.db.dynamo.planning import Project, project_key
from app.common.project_cadence import (
    OVERDUE_GRACE,
    ProjectUpdateDue,
    check_interval,
    effective_interval,
    emit_update_due,
    next_update_due_at,
    register_update_due_listener,
    unregister_update_due_listener,
    update_anchor,
    update_due_state,
)

CREATED = datetime(2026, 9, 1, 9, 30, tzinfo=timezone.utc)


def _project(**fields: Any) -> Project:
    """One in progress project made at `CREATED`, with the fields given."""
    values: dict[str, Any] = {
        "workspace_id": "W1",
        "planning_key": project_key("P1"),
        "project_id": "P1",
        "team_ids": ["T1"],
        "name": "Launch",
        "status": "in_progress",
        "created_by": "U1",
        "created_at": CREATED,
    }
    values.update(fields)
    return Project(**values)


def test_the_latest_update_anchors_the_cadence() -> None:
    """Posting an update moves the next due date a full interval past it."""
    posted = datetime(2026, 9, 10, 15, 0, tzinfo=timezone.utc)
    project = _project(last_update_at=posted, start_date="2026-09-05")

    assert update_anchor(project) == posted
    assert next_update_due_at(project, 7) == posted + timedelta(days=7)


def test_the_start_date_anchors_a_project_with_no_update() -> None:
    """With no update yet, the clock starts at midnight UTC on the start date."""
    project = _project(start_date="2026-09-05")

    assert next_update_due_at(project, 14) == datetime(2026, 9, 19, tzinfo=timezone.utc)


def test_creation_anchors_a_project_with_no_update_or_start() -> None:
    """A project with neither counts from the moment it was made."""
    assert next_update_due_at(_project(), 30) == CREATED + timedelta(days=30)


def test_the_project_cadence_overrides_the_workspace_default() -> None:
    """A project's own interval wins, and None follows the workspace."""
    assert effective_interval(_project(update_interval_days=14), 7) == 14
    assert effective_interval(_project(), 30) == 30
    assert next_update_due_at(_project(update_interval_days=14), 7) == CREATED + timedelta(days=14)


def test_an_interval_of_zero_is_never_due() -> None:
    """Off on the project, or off on the workspace for a project that follows it."""
    later = CREATED + timedelta(days=365)
    assert next_update_due_at(_project(update_interval_days=0), 7) is None
    assert update_due_state(_project(), 0, later) is None


@pytest.mark.parametrize("status", ["completed", "canceled", "paused"])
def test_finished_and_paused_projects_never_come_due(status: str) -> None:
    """The exempt statuses have no due date and no state, however long it has been."""
    project = _project(status=status)

    assert next_update_due_at(project, 7) is None
    assert update_due_state(project, 7, CREATED + timedelta(days=90)) is None


@pytest.mark.parametrize("status", ["backlog", "planned", "in_progress"])
def test_open_projects_come_due(status: str) -> None:
    """Every other status keeps the cadence."""
    assert update_due_state(_project(status=status), 7, CREATED + timedelta(days=8)) == "due"


def test_the_state_moves_from_upcoming_to_due_to_overdue() -> None:
    """Due on the date, overdue once the grace has passed it."""
    project = _project()
    due_at = CREATED + timedelta(days=7)

    assert update_due_state(project, 7, due_at - timedelta(seconds=1)) == "upcoming"
    assert update_due_state(project, 7, due_at) == "due"
    assert update_due_state(project, 7, due_at + OVERDUE_GRACE - timedelta(seconds=1)) == "due"
    assert update_due_state(project, 7, due_at + OVERDUE_GRACE) == "overdue"


def test_only_the_offered_intervals_are_accepted() -> None:
    """Off, weekly, every two weeks and monthly; None passes through for inherit."""
    for value in (0, 7, 14, 30, None):
        assert check_interval(value) == value
    for value in (1, 3, 21, -7, True):
        with pytest.raises(ValueError):
            check_interval(value)


def test_one_failing_listener_does_not_stop_the_next() -> None:
    """The due hook hands every event to every listener, logging a failure rather than raising it."""
    heard: list[ProjectUpdateDue] = []

    def broken(event: ProjectUpdateDue) -> None:
        """A listener that always fails."""
        raise RuntimeError("down")

    register_update_due_listener(broken)
    register_update_due_listener(heard.append)
    try:
        event = ProjectUpdateDue(
            workspace_id="W1",
            project_id="P1",
            project_name="Launch",
            team_ids=("T1",),
            lead_id="U1",
            due_at=CREATED,
            interval_days=7,
        )
        emit_update_due(event)
    finally:
        unregister_update_due_listener(broken)
        unregister_update_due_listener(heard.append)

    assert heard == [event]
