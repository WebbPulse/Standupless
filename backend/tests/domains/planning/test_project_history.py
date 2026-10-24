"""Project progress history and its projected finish.

The properties worth holding are that a project recount which moves the
project's buckets leaves the day's snapshot behind with what the project held
before it, that a recount moving nothing writes nothing, that the series opens
on the project's start when the history is whole and on the day before the
first snapshot otherwise, that the projection extends the recent completion
rate to a dated finish measured against the target, and that deleting a
project takes its history with it.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.planning import Project, ProjectSnapshot, RollupCounts, project_key
from app.domains.planning.consumers.rollup import handle_record
from app.domains.planning.history import MAX_HISTORY_DAYS, DayValue
from app.domains.planning.project_history import (
    MAX_PROJECTION_DAYS,
    project_burn_up,
    project_projection,
    project_value_on,
)
from tests.domains.helpers import MEMBER, OWNER, sign_in
from tests.domains.planning.conftest import TEAM, WORKSPACE, seed_issue, seed_project


def _day(offset: int) -> str:
    """The ISO day `offset` days from today, in UTC as the endpoint reads it."""
    return (datetime.now(timezone.utc).date() + timedelta(days=offset)).isoformat()


def _epoch(day: str) -> int:
    """Noon UTC on one ISO day, as a stream record's creation time."""
    moment = datetime.fromisoformat(day).replace(hour=12, tzinfo=timezone.utc)
    return int(moment.timestamp())


def _image(**attributes: str) -> "dict[str, Any]":
    """One stream image in DynamoDB's wire encoding, strings throughout."""
    return {name: {"S": value} for name, value in attributes.items() if value}


def _record(
    event_name: str,
    new: "dict[str, Any]",
    old: "dict[str, Any] | None" = None,
    event_id: str = "1",
    day: str | None = None,
) -> "dict[str, Any]":
    """One stream record shaped the way Lambda delivers it."""
    dynamodb: "dict[str, Any]" = {"NewImage": new}
    if old is not None:
        dynamodb["OldImage"] = old
    if day is not None:
        dynamodb["ApproximateCreationDateTime"] = _epoch(day)
    return {"eventName": event_name, "eventID": event_id, "dynamodb": dynamodb}


def _statuses(repositories: Any) -> "dict[str, str]":
    """The seeded statuses of TEAM, keyed by category."""
    return {row.category: row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, TEAM)}


def _issue_image(repositories: Any, issue_id: str) -> "dict[str, Any]":
    """The stream image of one stored issue, carrying what the project recount reads."""
    issue = repositories.issues.get(WORKSPACE, issue_id)
    assert issue is not None
    return _image(
        workspace_id=WORKSPACE,
        issue_id=issue.issue_id,
        team_id=issue.team_id,
        status_id=issue.status_id,
        project_id=issue.project_id or "",
    )


def _counts(todo: int = 0, in_progress: int = 0, done: int = 0, cancelled: int = 0) -> RollupCounts:
    """One bucket set."""
    return RollupCounts(todo=todo, in_progress=in_progress, done=done, cancelled=cancelled)


def _snapshot(day: str, counts: RollupCounts, opening: RollupCounts | None = None) -> ProjectSnapshot:
    """One in-memory snapshot in issues, no points."""
    return ProjectSnapshot(day=day, counts=counts, opening_counts=opening or RollupCounts())


def _project(**fields: Any) -> Project:
    """One in-memory project for the pure folds."""
    values: "dict[str, Any]" = {
        "workspace_id": WORKSPACE,
        "planning_key": project_key("P1"),
        "project_id": "P1",
        "team_ids": [TEAM],
        "name": "Launch",
        "created_by": OWNER,
        "created_at": datetime(2026, 3, 1, tzinfo=timezone.utc),
    }
    values.update(fields)
    return Project(**values)


def _value(day: str, scope: int, completed: int, started: int | None = None) -> DayValue:
    """One day of a series in issues, points mirroring the counts."""
    begun = completed if started is None else started
    return DayValue(
        date=day,
        scope=scope,
        started=begun,
        completed=completed,
        scope_points=scope,
        started_points=begun,
        completed_points=completed,
    )


def test_a_recount_writes_the_days_snapshot_with_its_opening(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """Each day the project moves keeps its closing counts and what it opened on."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    project_id = seed_project(client, workspace, start_date=_day(-5))["project_id"]
    statuses = _statuses(repositories)
    issue = seed_issue(issues_client, workspace, project_id=project_id, status_id=statuses["backlog"])

    handle_record(repositories, _record("INSERT", new=_issue_image(repositories, issue["id"]), day=_day(-2)))
    before = _issue_image(repositories, issue["id"])
    moved = issues_client.patch(
        f"/api/workspaces/{workspace}/issues/{issue['id']}", json={"status_id": statuses["completed"]}
    )
    assert moved.status_code == 200, moved.text
    handle_record(
        repositories,
        _record("MODIFY", new=_issue_image(repositories, issue["id"]), old=before, event_id="2", day=_day(-1)),
    )

    rows = repositories.planning.list_project_history(WORKSPACE, project_id)
    assert [row.day for row in rows] == [_day(-2), _day(-1)]
    assert rows[0].counts.todo == 1 and rows[0].opening_counts.total == 0
    assert rows[1].counts.done == 1 and rows[1].opening_counts.todo == 1


def test_a_recount_that_moves_nothing_writes_no_snapshot(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """A redelivered or unrelated record on a later day leaves the history as it was."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    issue = seed_issue(issues_client, workspace, project_id=project_id, status_id=_statuses(repositories)["backlog"])
    image = _issue_image(repositories, issue["id"])

    handle_record(repositories, _record("INSERT", new=image, day=_day(-1)))
    handle_record(repositories, _record("MODIFY", new=image, old=image, event_id="2", day=_day(0)))

    assert [row.day for row in repositories.planning.list_project_history(WORKSPACE, project_id)] == [_day(-1)]


def test_the_history_route_reads_the_series_from_the_project_start(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """A whole history opens on the start date, fills every day and ends on today's live counts."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    project_id = seed_project(client, workspace, start_date=_day(-4), target_date=_day(10))["project_id"]
    issue = seed_issue(issues_client, workspace, project_id=project_id, status_id=_statuses(repositories)["backlog"])
    handle_record(repositories, _record("INSERT", new=_issue_image(repositories, issue["id"]), day=_day(-2)))

    response = client.get(f"/api/workspaces/{workspace}/projects/{project_id}/history")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["recorded_since"] == _day(-2)
    assert body["start_date"] == _day(-4)
    assert body["target_date"] == _day(10)
    assert body["today"] == _day(0)
    assert body["measure"] == "issues"
    assert [row["date"] for row in body["days"]] == [_day(offset) for offset in range(-4, 1)]
    assert [row["scope"] for row in body["days"]] == [0, 0, 1, 1, 1]
    assert body["projection"] == {"rate_per_day": 0.0, "expected_date": None, "days_past_target": None}


def test_a_project_without_history_reads_today_alone(client: TestClient, workspace: str) -> None:
    """With no snapshot yet the route answers today's counts and no projection, for the panel's fallback."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]

    body = client.get(f"/api/workspaces/{workspace}/projects/{project_id}/history").json()

    assert body["recorded_since"] is None
    assert [row["date"] for row in body["days"]] == [_day(0)]
    assert body["projection"] is None


def test_deleting_a_project_removes_its_history(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """No snapshot row outlives its project."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    issue = seed_issue(issues_client, workspace, project_id=project_id, status_id=_statuses(repositories)["backlog"])
    handle_record(repositories, _record("INSERT", new=_issue_image(repositories, issue["id"]), day=_day(-1)))
    assert repositories.planning.list_project_history(WORKSPACE, project_id)

    sign_in(client, OWNER)
    deleted = client.delete(f"/api/workspaces/{workspace}/projects/{project_id}", params={"team_id": TEAM})

    assert deleted.status_code in (200, 204), deleted.text
    assert repositories.planning.list_project_history(WORKSPACE, project_id) == []


def test_a_day_before_the_first_snapshot_reads_its_opening() -> None:
    """Earlier days take the first snapshot's opening, later ones the latest snapshot on or before them."""
    snapshots = [
        _snapshot("2026-03-03", _counts(todo=2), opening=_counts(todo=1)),
        _snapshot("2026-03-05", _counts(todo=1, done=1)),
    ]

    assert project_value_on("2026-03-01", snapshots).scope == 1
    assert project_value_on("2026-03-04", snapshots).scope == 2
    assert project_value_on("2026-03-06", snapshots).completed == 1


def test_a_whole_history_opens_on_the_project_start() -> None:
    """A first snapshot that opened on an empty project means every earlier day was empty."""
    project = _project(start_date="2026-03-01", counts=_counts(todo=1, done=2))
    snapshots = [_snapshot("2026-03-03", _counts(todo=3))]

    history = project_burn_up(project, snapshots, "2026-03-05")

    assert history.recorded_since == "2026-03-03"
    assert [value.date for value in history.days] == [f"2026-03-0{day}" for day in range(1, 6)]
    assert [value.scope for value in history.days] == [0, 0, 3, 3, 3]
    assert history.days[-1].completed == 2


def test_a_partial_history_opens_on_the_day_before_the_first_snapshot() -> None:
    """A project that held work before the feature shipped reads only the day it is known for."""
    project = _project(start_date="2026-01-01", counts=_counts(todo=4))
    snapshots = [_snapshot("2026-03-03", _counts(todo=4), opening=_counts(todo=3))]

    history = project_burn_up(project, snapshots, "2026-03-04")

    assert [value.date for value in history.days] == ["2026-03-02", "2026-03-03", "2026-03-04"]
    assert history.days[0].scope == 3


def test_the_series_keeps_only_the_most_recent_days() -> None:
    """A long project reads its last `MAX_HISTORY_DAYS` days, ending today."""
    project = _project(start_date="2024-01-01")
    snapshots = [_snapshot("2024-01-02", _counts(todo=1))]
    today = "2026-03-01"

    history = project_burn_up(project, snapshots, today)

    assert len(history.days) == MAX_HISTORY_DAYS
    assert history.days[-1].date == today


def test_a_project_starting_later_has_no_series_and_one_without_snapshots_has_today() -> None:
    """An upcoming project draws nothing; one never snapshotted draws today's counts alone."""
    assert project_burn_up(_project(start_date="2026-04-01"), [], "2026-03-01").days == []

    today = project_burn_up(_project(counts=_counts(todo=2)), [], "2026-03-04")
    assert today.recorded_since is None
    assert [(value.date, value.scope) for value in today.days] == [("2026-03-04", 2)]


def test_the_projection_needs_a_series_and_open_scope() -> None:
    """Too few days, an empty project and a finished one all project nothing."""
    short = [_value("2026-03-01", 4, 0), _value("2026-03-02", 4, 1)]
    empty = [_value(f"2026-03-0{day}", 0, 0) for day in range(1, 5)]
    finished = [_value(f"2026-03-0{day}", 4, day) for day in range(1, 5)]

    assert project_projection(short, "issues", None, "2026-03-02") is None
    assert project_projection(empty, "issues", None, "2026-03-04") is None
    assert project_projection(finished, "issues", None, "2026-03-04") is None


def test_a_stalled_project_has_a_rate_but_no_finish() -> None:
    """Nothing completed over the window names no expected date."""
    days = [_value(f"2026-03-0{day}", 6, 1) for day in range(1, 6)]

    projection = project_projection(days, "issues", "2026-03-20", "2026-03-05")

    assert projection is not None
    assert (projection.rate_per_day, projection.expected_date, projection.days_past_target) == (0.0, None, None)


def test_the_projection_lands_after_the_target_when_the_pace_is_slow() -> None:
    """One issue a day over four days with six left finishes six days on, two past a four day target."""
    days = [_value(f"2026-03-0{day}", 10, day - 1) for day in range(1, 6)]

    projection = project_projection(days, "issues", "2026-03-09", "2026-03-05")

    assert projection is not None
    assert projection.rate_per_day == 1.0
    assert projection.expected_date == "2026-03-11"
    assert projection.days_past_target == 2


def test_the_projection_lands_before_the_target_when_the_pace_is_quick() -> None:
    """A finish ahead of the target reads as a negative distance."""
    days = [_value(f"2026-03-0{day}", 10, 2 * (day - 1)) for day in range(1, 5)]

    projection = project_projection(days, "issues", "2026-03-31", "2026-03-04")

    assert projection is not None
    assert projection.expected_date == "2026-03-06"
    assert projection.days_past_target == -25


def test_the_projection_reads_the_recent_window_in_points() -> None:
    """Only the last fourteen days set the pace, read in the project's measure."""
    start = date(2026, 1, 1)
    days = []
    for offset in range(30):
        completed_points = 20 if offset < 15 else 20 + (offset - 15)
        days.append(
            DayValue(
                date=(start + timedelta(days=offset)).isoformat(),
                scope=1,
                started=0,
                completed=0,
                scope_points=50,
                started_points=completed_points,
                completed_points=completed_points,
            )
        )

    projection = project_projection(days, "points", None, days[-1].date)

    assert projection is not None
    assert projection.rate_per_day == 1.0
    assert projection.expected_date == (start + timedelta(days=29 + 16)).isoformat()
    assert projection.days_past_target is None


def test_a_finish_out_of_sight_is_not_dated() -> None:
    """A pace that would take longer than `MAX_PROJECTION_DAYS` names no date."""
    days = [_value(f"2026-03-0{day}", 100000, day) for day in range(1, 6)]

    projection = project_projection(days, "issues", None, "2026-03-05")

    assert projection is not None
    assert projection.expected_date is None
    assert 100000 / projection.rate_per_day > MAX_PROJECTION_DAYS
