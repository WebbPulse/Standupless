"""The one-off recount that heals parent progress and blocking counts a dropped stream batch left wrong."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from scripts.recount_issue_rollups import main, run
from tests.domains.helpers import MEMBER, sign_in
from tests.domains.issues.conftest import WORKSPACE, create_issue


def _stale(repositories: Any, client: TestClient, workspace: str) -> "tuple[str, str]":
    """A parent with one child whose progress, blocked and blocking counts all disagree with the links."""
    sign_in(client, MEMBER)
    parent = create_issue(client, workspace, title="Parent")["id"]
    child = create_issue(client, workspace, title="Child", parent_id=parent)["id"]
    repositories.issues.set_progress(WORKSPACE, parent, 4, 4)
    repositories.issues.set_blocked_by_open_count(WORKSPACE, child, 2)
    repositories.issues.set_blocking_count(WORKSPACE, parent, 3)
    return parent, child


def test_the_recount_heals_progress_and_blocking_counts(client: TestClient, repositories: Any, workspace: str) -> None:
    """Each drifted value is rewritten from the stored children and links, and a rerun writes nothing."""
    parent, child = _stale(repositories, client, workspace)

    tally = run(repositories, [WORKSPACE], dry_run=False)

    assert (tally.progress_written, tally.blocked_written, tally.blocking_written) == (1, 1, 1)
    healed = repositories.issues.get(WORKSPACE, parent)
    blocked = repositories.issues.get(WORKSPACE, child)
    assert healed is not None and blocked is not None
    assert (healed.progress.total, healed.progress.completed) == (1, 0)
    assert healed.blocking_count == 0
    assert blocked.blocked_by_open_count == 0

    again = run(repositories, [WORKSPACE], dry_run=False)
    assert (again.progress_written, again.blocked_written, again.blocking_written) == (0, 0, 0)


def test_a_dry_run_counts_and_writes_nothing(
    client: TestClient, repositories: Any, workspace: str, capsys: pytest.CaptureFixture[str]
) -> None:
    """The command line prints counts only and leaves every issue as it was under `--dry-run`."""
    from app.common.core.config import settings

    parent, _ = _stale(repositories, client, workspace)
    stage = settings.dynamodb_table_prefix.removeprefix("standupless-")

    assert main(["--stage", stage, "--workspace", WORKSPACE, "--dry-run"]) == 0

    printed = capsys.readouterr().out.strip()
    assert printed == (
        "dry-run workspaces=1 issues=2 progress_written=1 blocked_written=1 blocking_written=1"
        " milestones_detached=0 milestone_issues_cleared=0"
    )
    untouched = repositories.issues.get(WORKSPACE, parent)
    assert untouched is not None
    assert untouched.progress.total == 4
