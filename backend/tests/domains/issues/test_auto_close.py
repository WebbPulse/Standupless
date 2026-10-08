"""The auto-close sweep, run against real tables under a fixed clock.

The properties worth holding are that only backlog and triage issues untouched
for the team's period are closed, that a team which never chose a period is left
alone, that the close lands in the chosen cancelled status or the first one, that
snoozed triage waits, that each close is a system history row, and that the
hourly trigger record runs the sweep.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi.testclient import TestClient

from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import AutoCloseSettings, auto_close_settings_key
from app.domains.issues.auto_close import close_status, sweep
from app.domains.issues.consumers.rollup import handle_record
from app.domains.issues.cycle_close import CYCLE_CLOSE_SOURCE
from tests.domains.helpers import MEMBER, sign_in
from tests.domains.issues.conftest import TEAM, WORKSPACE, create_issue

NOW = datetime(2026, 9, 26, 12, 0, tzinfo=timezone.utc)

OLD = NOW - timedelta(days=200)


def _enable(repositories: Any, period_months: int = 6, status_id: Optional[str] = None) -> AutoCloseSettings:
    """Turn auto-close on for `TEAM`."""
    return repositories.team_config.put_auto_close_settings(
        AutoCloseSettings(
            workspace_id=WORKSPACE,
            config_key=auto_close_settings_key(TEAM),
            team_id=TEAM,
            period_months=period_months,
            status_id=status_id,
        )
    )


def _stored(repositories: Any, issue_id: str) -> Issue:
    """One issue as the table holds it now."""
    row = repositories.issues.get(WORKSPACE, issue_id)
    assert row is not None
    return row


def _seed(client: TestClient, workspace: str, repositories: Any, status_id: str, age: datetime, **update: Any) -> str:
    """One issue in a status, last updated at `age`, with any extra stored fields."""
    issue = create_issue(client, workspace, status_id=status_id)
    row = _stored(repositories, issue["id"])
    repositories.issues.replace(row.model_copy(update={"updated_at": age, **update}))
    return str(issue["id"])


def test_off_by_default(client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]") -> None:
    """A team that never chose a period keeps even its oldest backlog."""
    sign_in(client, MEMBER)
    issue = _seed(client, workspace, repositories, statuses["backlog"].status_id, NOW - timedelta(days=900))

    summary = sweep(repositories, now=NOW)

    assert summary.teams == 0
    assert _stored(repositories, issue).status_id == statuses["backlog"].status_id


def test_only_stale_backlog_and_triage_close(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """Old backlog and triage issues close; recent, planned, started and archived ones stay."""
    sign_in(client, MEMBER)
    _enable(repositories)
    backlog = statuses["backlog"].status_id
    stale = _seed(client, workspace, repositories, backlog, OLD)
    triage = _seed(client, workspace, repositories, backlog, OLD, in_triage=True)
    recent = _seed(client, workspace, repositories, backlog, NOW - timedelta(days=100))
    unstarted = _seed(client, workspace, repositories, statuses["unstarted"].status_id, OLD)
    started = _seed(client, workspace, repositories, statuses["started"].status_id, OLD)
    archived = _seed(client, workspace, repositories, backlog, OLD, archived_at=OLD)

    summary = sweep(repositories, now=NOW)

    cancelled = statuses["cancelled"].status_id
    assert summary.closed == 2
    assert _stored(repositories, stale).status_id == cancelled
    closed_triage = _stored(repositories, triage)
    assert (closed_triage.status_id, closed_triage.in_triage) == (cancelled, False)
    assert _stored(repositories, recent).status_id == backlog
    assert _stored(repositories, unstarted).status_id == statuses["unstarted"].status_id
    assert _stored(repositories, started).status_id == statuses["started"].status_id
    assert _stored(repositories, archived).status_id == backlog
    assert sweep(repositories, now=NOW).closed == 0


def test_snoozed_triage_waits(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """A triage issue snoozed into the future is left until it wakes."""
    sign_in(client, MEMBER)
    _enable(repositories)
    issue = _seed(
        client,
        workspace,
        repositories,
        statuses["backlog"].status_id,
        OLD,
        in_triage=True,
        snoozed_until=NOW + timedelta(days=1),
    )

    assert sweep(repositories, now=NOW).closed == 0
    assert _stored(repositories, issue).in_triage is True
    assert sweep(repositories, now=NOW + timedelta(days=2)).closed == 1


def test_the_period_decides_the_cutoff(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """A one month team closes what a six month team keeps."""
    sign_in(client, MEMBER)
    _enable(repositories, period_months=6)
    issue = _seed(client, workspace, repositories, statuses["backlog"].status_id, NOW - timedelta(days=45))

    assert sweep(repositories, now=NOW).closed == 0
    _enable(repositories, period_months=1)
    assert sweep(repositories, now=NOW).closed == 1
    assert _stored(repositories, issue).status_id == statuses["cancelled"].status_id


def test_a_close_is_a_system_history_row(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """The issue's history says the status moved and that no person moved it."""
    sign_in(client, MEMBER)
    _enable(repositories)
    issue = _seed(client, workspace, repositories, statuses["backlog"].status_id, OLD)

    sweep(repositories, now=NOW)

    rows = [
        row
        for row in repositories.activity.list_for_issue(WORKSPACE, issue).items
        if row["kind"] == "field_changed" and row.get("field") == "status_id"
    ]
    assert len(rows) == 1
    assert rows[0]["actor_kind"] == "system"
    assert rows[0]["actor_id"] == "system"
    stored = _stored(repositories, issue)
    assert (stored.updated_at, stored.updated_by) == (NOW, "system")


def test_a_close_drops_the_sla_timer(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """A closed issue no longer carries an SLA deadline, so it cannot breach."""
    sign_in(client, MEMBER)
    _enable(repositories)
    issue = _seed(
        client,
        workspace,
        repositories,
        statuses["backlog"].status_id,
        OLD,
        sla_started_at=OLD,
        sla_breaches_at=OLD + timedelta(days=1),
    )

    sweep(repositories, now=NOW)

    stored = _stored(repositories, issue)
    assert stored.status_id == statuses["cancelled"].status_id
    assert (stored.sla_started_at, stored.sla_breaches_at) == (None, None)


def test_close_status_falls_back_to_the_first_cancelled(repositories: Any, statuses: "dict[str, Any]") -> None:
    """A chosen status that is gone falls back to the team's first cancelled status."""
    chosen = _enable(repositories, status_id=statuses["cancelled"].status_id)
    missing = _enable(repositories, status_id="01JB0000000000000000MISSNG")

    assert close_status(repositories, chosen) == statuses["cancelled"].status_id
    assert close_status(repositories, missing) == statuses["cancelled"].status_id


def test_a_team_without_a_cancelled_status_is_skipped(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """With no cancelled status to move into, the sweep closes nothing."""
    sign_in(client, MEMBER)
    _enable(repositories)
    issue = _seed(client, workspace, repositories, statuses["backlog"].status_id, OLD)
    changed = repositories.team_config.update_status(
        WORKSPACE, TEAM, statuses["cancelled"].status_id, category="completed"
    )
    assert changed is not None

    assert sweep(repositories, now=NOW).closed == 0
    assert _stored(repositories, issue).status_id == statuses["backlog"].status_id


def test_an_edit_after_the_read_is_not_closed(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]", monkeypatch: Any
) -> None:
    """The close is conditional on the issue the sweep read, so a fresh edit wins."""
    sign_in(client, MEMBER)
    _enable(repositories)
    issue = _seed(client, workspace, repositories, statuses["backlog"].status_id, OLD)
    real = repositories.issues.iter_finished_before

    def read_then_edit(*args: Any, **kwargs: Any) -> Any:
        rows = real(*args, **kwargs)
        if rows:
            repositories.issues.replace(_stored(repositories, issue).model_copy(update={"updated_at": NOW}))
        return rows

    monkeypatch.setattr(repositories.issues, "iter_finished_before", read_then_edit)
    summary = sweep(repositories, now=NOW)

    assert (summary.closed, summary.skipped) == (0, 1)
    assert _stored(repositories, issue).status_id == statuses["backlog"].status_id


def test_the_hourly_record_runs_the_sweep(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """The cycle close schedule's record runs the auto-close sweep."""
    sign_in(client, MEMBER)
    _enable(repositories, period_months=1)
    issue = _seed(
        client, workspace, repositories, statuses["backlog"].status_id, datetime(2020, 1, 1, tzinfo=timezone.utc)
    )

    handle_record(repositories, {"eventSource": CYCLE_CLOSE_SOURCE, "eventName": "SWEEP", "eventID": "cycle-close"})

    assert _stored(repositories, issue).status_id == statuses["cancelled"].status_id
