"""The one-off recount that heals cycle and project counters a dropped stream batch left wrong, against moto.

Issues seeded through the route never pass through the rollup consumer here, so
every planning row starts with zero counts, which is the stale row a dropped
batch leaves behind.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.domains.planning.consumers.rollup import recount_cycle
from scripts.recount_planning_rollups import main, run
from tests.domains.helpers import MEMBER, sign_in
from tests.domains.planning.conftest import TEAM, WORKSPACE, seed_cycle, seed_issue, seed_project


def _statuses(repositories: Any) -> "dict[str, str]":
    """The seeded statuses of TEAM, keyed by category."""
    return {row.category: row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, TEAM)}


def _cycle_counts(repositories: Any, cycle_id: str) -> "dict[str, int]":
    """The issue buckets currently stored on one cycle."""
    cycle = repositories.planning.get_cycle(WORKSPACE, TEAM, cycle_id)
    assert cycle is not None
    return cycle.counts.model_dump()


def _project_counts(repositories: Any, project_id: str) -> "dict[str, int]":
    """The issue buckets currently stored on one project."""
    project = repositories.planning.get_project(WORKSPACE, project_id)
    assert project is not None
    return project.counts.model_dump()


def test_the_recount_heals_a_stale_cycle_and_project(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """A cycle and a project that missed their issues are recounted, and a rerun writes nothing."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    cycle_id = seed_cycle(client, workspace)["cycle_id"]
    project_id = seed_project(client, workspace)["project_id"]
    started = _statuses(repositories)["started"]
    seed_issue(issues_client, workspace, cycle_id=cycle_id, project_id=project_id, status_id=started)
    assert _cycle_counts(repositories, cycle_id)["in_progress"] == 0

    tally = run(repositories, [WORKSPACE], dry_run=False)

    assert (tally.cycles, tally.cycles_written, tally.projects) == (1, 1, 1)
    assert tally.project_rows_written >= 1
    assert _cycle_counts(repositories, cycle_id)["in_progress"] == 1
    assert _project_counts(repositories, project_id)["in_progress"] == 1

    again = run(repositories, [WORKSPACE], dry_run=False)
    assert (again.cycles_written, again.project_rows_written) == (0, 0)


def test_an_active_cycle_gets_the_days_snapshot(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """A healed cycle still running records the healed scope for its burn-up."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    cycle = seed_cycle(client, workspace)
    seed_issue(issues_client, workspace, cycle_id=cycle["cycle_id"], status_id=_statuses(repositories)["started"])
    row = repositories.planning.get_cycle(WORKSPACE, TEAM, cycle["cycle_id"])
    assert row is not None

    assert recount_cycle(repositories, WORKSPACE, row, today="2026-01-05") is True

    history = repositories.planning.list_cycle_history(WORKSPACE, TEAM, cycle["cycle_id"])
    assert [snapshot.day for snapshot in history] == ["2026-01-05"]
    assert history[0].counts.in_progress == 1


def test_a_dry_run_counts_and_writes_nothing(
    client: TestClient,
    issues_client: TestClient,
    repositories: Any,
    workspace: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The command line prints counts only and leaves every row as it was under `--dry-run`."""
    from app.common.core.config import settings

    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    cycle_id = seed_cycle(client, workspace)["cycle_id"]
    seed_issue(issues_client, workspace, cycle_id=cycle_id, status_id=_statuses(repositories)["started"])
    stage = settings.dynamodb_table_prefix.removeprefix("standupless-")

    assert main(["--stage", stage, "--workspace", WORKSPACE, "--dry-run"]) == 0

    printed = capsys.readouterr().out.strip()
    assert printed == "dry-run workspaces=1 cycles=1 cycles_written=1 projects=0 project_rows_written=0"
    assert _cycle_counts(repositories, cycle_id)["in_progress"] == 0
