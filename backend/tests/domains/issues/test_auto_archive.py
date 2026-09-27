"""The auto-archive sweep, run against real tables under a fixed clock.

The properties worth holding are that only completed and cancelled issues older
than the team's period are archived, that the period follows the team setting,
that each archive is a system history row, that a second run archives nothing,
that an issue edited after the sweep read it is left alone, and that a deleted
team is skipped. The hourly trigger record runs the sweep.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.team_config import ArchiveSettings, archive_settings_key
from app.domains.issues import auto_archive
from app.domains.issues.auto_archive import MAX_PER_STATUS, months_before, sweep
from app.domains.issues.consumers.rollup import handle_record
from app.domains.issues.cycle_close import CYCLE_CLOSE_SOURCE
from tests.domains.helpers import MEMBER, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, WORKSPACE, create_issue

NOW = datetime(2026, 9, 26, 12, 0, tzinfo=timezone.utc)


def _age(repositories: Any, issue_id: str, updated_at: datetime) -> None:
    """Backdate one issue's last update, as if it was finished then."""
    row = repositories.issues.get(WORKSPACE, issue_id)
    assert row is not None
    repositories.issues.replace(row.model_copy(update={"updated_at": updated_at}))


def _archived(repositories: Any, issue_id: str) -> bool:
    """Whether one issue carries an archive stamp now."""
    row = repositories.issues.get(WORKSPACE, issue_id)
    assert row is not None
    return row.archived_at is not None


def _seed(client: TestClient, workspace: str, repositories: Any, status_id: str, age: datetime, **extra: Any) -> str:
    """One issue in a status, last updated at `age`."""
    issue = create_issue(client, workspace, status_id=status_id, **extra)
    _age(repositories, issue["id"], age)
    return str(issue["id"])


@pytest.mark.parametrize(
    ("moment", "months", "expected"),
    [
        (datetime(2026, 9, 26, tzinfo=timezone.utc), 6, datetime(2026, 3, 26, tzinfo=timezone.utc)),
        (datetime(2026, 3, 31, tzinfo=timezone.utc), 1, datetime(2026, 2, 28, tzinfo=timezone.utc)),
        (datetime(2028, 3, 31, tzinfo=timezone.utc), 1, datetime(2028, 2, 29, tzinfo=timezone.utc)),
        (datetime(2026, 1, 15, tzinfo=timezone.utc), 12, datetime(2025, 1, 15, tzinfo=timezone.utc)),
        (datetime(2026, 2, 10, tzinfo=timezone.utc), 3, datetime(2025, 11, 10, tzinfo=timezone.utc)),
    ],
)
def test_months_are_calendar_months(moment: datetime, months: int, expected: datetime) -> None:
    """A period is whole calendar months back, clamped to the end of a short month."""
    assert months_before(moment, months) == expected


def test_only_finished_issues_past_the_period_are_archived(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """Done and cancelled issues older than six months go; newer or open ones stay."""
    sign_in(client, MEMBER)
    old = NOW - timedelta(days=200)
    recent = NOW - timedelta(days=150)
    done_old = _seed(client, workspace, repositories, statuses["completed"].status_id, old)
    cancelled_old = _seed(client, workspace, repositories, statuses["cancelled"].status_id, old)
    done_recent = _seed(client, workspace, repositories, statuses["completed"].status_id, recent)
    open_old = _seed(client, workspace, repositories, statuses["started"].status_id, old)

    summary = sweep(repositories, now=NOW)

    assert summary.archived == 2
    assert _archived(repositories, done_old)
    assert _archived(repositories, cancelled_old)
    assert not _archived(repositories, done_recent)
    assert not _archived(repositories, open_old)


def test_the_team_period_decides_the_cutoff(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """A one month team archives what a six month team keeps."""
    sign_in(client, MEMBER)
    issue = _seed(client, workspace, repositories, statuses["completed"].status_id, NOW - timedelta(days=45))

    sweep(repositories, now=NOW)
    assert not _archived(repositories, issue)

    repositories.team_config.put_archive_settings(
        ArchiveSettings(workspace_id=WORKSPACE, config_key=archive_settings_key(TEAM), team_id=TEAM, period_months=1)
    )
    sweep(repositories, now=NOW)
    assert _archived(repositories, issue)


def test_an_archive_is_a_system_history_row(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """The issue's history says it was archived and that no person did it."""
    sign_in(client, MEMBER)
    issue = _seed(client, workspace, repositories, statuses["completed"].status_id, NOW - timedelta(days=400))

    sweep(repositories, now=NOW)

    rows = [row for row in repositories.activity.list_for_issue(WORKSPACE, issue).items if row["kind"] == "archived"]
    assert len(rows) == 1
    assert rows[0]["actor_kind"] == "system"
    assert rows[0]["actor_id"] == "system"
    stored = repositories.issues.get(WORKSPACE, issue)
    assert stored is not None
    assert stored.archived_at == NOW
    assert stored.updated_at == NOW - timedelta(days=400)


def test_a_second_run_archives_nothing(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """An archived issue sits in its own partition, so the next run never reads it."""
    sign_in(client, MEMBER)
    issue = _seed(client, workspace, repositories, statuses["completed"].status_id, NOW - timedelta(days=400))

    assert sweep(repositories, now=NOW).archived == 1
    again = sweep(repositories, now=NOW + timedelta(hours=1))

    assert again.archived == 0
    assert again.skipped == 0
    rows = [row for row in repositories.activity.list_for_issue(WORKSPACE, issue).items if row["kind"] == "archived"]
    assert len(rows) == 1


def test_an_edit_after_the_read_is_not_archived(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]", monkeypatch: Any
) -> None:
    """The archive is conditional on the updated_at the sweep saw, so a fresh edit wins."""
    sign_in(client, MEMBER)
    issue = _seed(client, workspace, repositories, statuses["completed"].status_id, NOW - timedelta(days=400))
    real = repositories.issues.iter_finished_before

    def read_then_edit(*args: Any, **kwargs: Any) -> Any:
        rows = real(*args, **kwargs)
        if rows:
            _age(repositories, issue, NOW)
        return rows

    monkeypatch.setattr(repositories.issues, "iter_finished_before", read_then_edit)
    summary = sweep(repositories, now=NOW)

    assert summary.archived == 0
    assert summary.skipped == 1
    assert not _archived(repositories, issue)


def test_a_restored_issue_waits_a_whole_period_again(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """A restore counts as an edit, so the next sweep keeps it visible."""
    sign_in(client, MEMBER)
    issue = _seed(client, workspace, repositories, statuses["completed"].status_id, NOW - timedelta(days=400))
    sweep(repositories, now=NOW)

    assert client.post(f"/api/workspaces/{WORKSPACE}/issues/{issue}/unarchive").status_code == 200
    sweep(repositories, now=datetime.now(timezone.utc) + timedelta(hours=1))

    assert not _archived(repositories, issue)


def test_a_deleted_team_is_skipped(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """A tombstoned team's issues are the purge's to remove, not the sweep's to archive."""
    sign_in(client, MEMBER)
    issue = _seed(client, workspace, repositories, statuses["completed"].status_id, NOW - timedelta(days=400))
    repositories.teams.mark_deleting(WORKSPACE, TEAM)

    summary = sweep(repositories, now=NOW)

    assert summary.archived == 0
    assert not _archived(repositories, issue)


def test_each_team_is_swept(client: TestClient, workspace: str, repositories: Any) -> None:
    """Every team with a finished status is visited, each with its own statuses."""
    sign_in(client, MEMBER)
    other_done = next(
        row.status_id
        for row in repositories.team_config.list_statuses(WORKSPACE, OTHER_TEAM)
        if row.category == "completed"
    )
    issue = _seed(client, workspace, repositories, other_done, NOW - timedelta(days=400), team_id=OTHER_TEAM)

    summary = sweep(repositories, now=NOW)

    assert summary.teams == 2
    assert _archived(repositories, issue)


def test_a_run_is_capped_per_status(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]", monkeypatch: Any
) -> None:
    """A large backlog drains over several runs, oldest first."""
    sign_in(client, MEMBER)
    monkeypatch.setattr(auto_archive, "MAX_PER_STATUS", 2)
    done = statuses["completed"].status_id
    ids = [_seed(client, workspace, repositories, done, NOW - timedelta(days=400 - step)) for step in range(3)]

    assert sweep(repositories, now=NOW).archived == 2
    assert [_archived(repositories, issue_id) for issue_id in ids] == [True, True, False]
    assert sweep(repositories, now=NOW).archived == 1
    assert MAX_PER_STATUS > 2


def test_the_hourly_record_runs_the_sweep(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """The cycle close schedule's record runs the archive sweep after the close."""
    sign_in(client, MEMBER)
    issue = _seed(
        client, workspace, repositories, statuses["completed"].status_id, datetime(2020, 1, 1, tzinfo=timezone.utc)
    )

    handle_record(repositories, {"eventSource": CYCLE_CLOSE_SOURCE, "eventName": "SWEEP", "eventID": "cycle-close"})

    assert _archived(repositories, issue)
