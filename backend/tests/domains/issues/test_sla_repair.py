"""The finished SLA timer repair, run against real tables.

The properties worth holding are that completed and cancelled issues lose a timer
they still carry while open ones keep theirs, that the repair leaves `updated_at`
alone, that a team is marked done once nothing is left so a rerun reads no
column, that a capped run leaves the team unmarked until a later run drains it,
and that the hourly trigger record runs it.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi.testclient import TestClient

from app.domains.issues import sla_repair
from app.domains.issues.consumers.rollup import handle_record
from app.domains.issues.cycle_close import CYCLE_CLOSE_SOURCE
from app.domains.issues.sla_repair import NAME, VERSION, sweep
from tests.domains.helpers import MEMBER, sign_in
from tests.domains.issues.conftest import TEAM, WORKSPACE, create_issue

STARTED = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)


def _timed(client: TestClient, workspace: str, repositories: Any, status_id: str) -> str:
    """One issue in a status that carries a running SLA timer, as a release move used to leave it."""
    issue = create_issue(client, workspace, status_id=status_id)
    row = repositories.issues.get(WORKSPACE, issue["id"])
    assert row is not None
    repositories.issues.replace(
        row.model_copy(update={"sla_started_at": STARTED, "sla_breaches_at": STARTED + timedelta(hours=24)})
    )
    return str(issue["id"])


def _breaches_at(repositories: Any, issue_id: str) -> datetime | None:
    """One issue's SLA deadline as stored now."""
    row = repositories.issues.get(WORKSPACE, issue_id)
    assert row is not None
    return row.sla_breaches_at


def test_finished_issues_lose_their_timer_and_open_ones_keep_it(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """Done and cancelled issues are cleared, a started one is untouched, and `updated_at` stays put."""
    sign_in(client, MEMBER)
    done = _timed(client, workspace, repositories, statuses["completed"].status_id)
    cancelled = _timed(client, workspace, repositories, statuses["cancelled"].status_id)
    running = _timed(client, workspace, repositories, statuses["started"].status_id)
    before = repositories.issues.get(WORKSPACE, done)

    summary = sweep(repositories)

    assert summary.cleared == 2
    assert _breaches_at(repositories, done) is None
    assert _breaches_at(repositories, cancelled) is None
    assert _breaches_at(repositories, running) == STARTED + timedelta(hours=24)
    after = repositories.issues.get(WORKSPACE, done)
    assert after.sla_started_at is None
    assert after.updated_at == before.updated_at
    assert (after.read_revision() or 0) > (before.read_revision() or 0)


def test_a_swept_team_is_not_read_again(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """Once a run leaves nothing behind the team is marked, and the next run skips it."""
    sign_in(client, MEMBER)
    _timed(client, workspace, repositories, statuses["completed"].status_id)

    sweep(repositories)

    assert repositories.counters.swept(WORKSPACE, TEAM, NAME, VERSION)
    assert not repositories.counters.swept(WORKSPACE, TEAM, NAME, VERSION + 1)
    later = _timed(client, workspace, repositories, statuses["completed"].status_id)
    assert sweep(repositories).cleared == 0
    assert _breaches_at(repositories, later) is not None


def test_a_capped_run_leaves_the_team_for_the_next(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]", monkeypatch: Any
) -> None:
    """A run that hits the cap does not mark the team, so the following run finishes it."""
    sign_in(client, MEMBER)
    monkeypatch.setattr(sla_repair, "MAX_PER_STATUS", 2)
    done = statuses["completed"].status_id
    ids = [_timed(client, workspace, repositories, done) for _ in range(3)]

    assert sweep(repositories).cleared == 2
    assert not repositories.counters.swept(WORKSPACE, TEAM, NAME, VERSION)
    assert sweep(repositories).cleared == 1
    assert repositories.counters.swept(WORKSPACE, TEAM, NAME, VERSION)
    assert all(_breaches_at(repositories, issue_id) is None for issue_id in ids)


def test_the_hourly_record_runs_the_repair(
    client: TestClient, workspace: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """The cycle close schedule's record clears finished timers too."""
    sign_in(client, MEMBER)
    issue = _timed(client, workspace, repositories, statuses["completed"].status_id)

    handle_record(repositories, {"eventSource": CYCLE_CLOSE_SOURCE, "eventName": "SWEEP", "eventID": "cycle-close"})

    assert _breaches_at(repositories, issue) is None
