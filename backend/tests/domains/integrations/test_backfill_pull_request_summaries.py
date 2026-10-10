"""The one-off backfill of pull request summaries onto issues linked before they existed, against moto."""

from __future__ import annotations

from typing import Any

import pytest

from scripts.backfill_pull_request_summaries import main, run
from tests.domains.integrations.conftest import WORKSPACE
from tests.domains.integrations.test_pr_stacks import ISSUE_ID, link


@pytest.fixture
def linked(repositories: Any, installed: str, issue: Any) -> None:
    """Two links written straight to the table, the way a link from before the summary sits."""
    repositories.github.put_link(link(10, "part-1", state="merged"))
    repositories.github.put_link(link(11, "part-2"))


def _summary(repositories: Any) -> Any:
    """The seeded issue's stored summary."""
    return repositories.issues.get(WORKSPACE, ISSUE_ID).pull_request_summary


def test_the_backfill_writes_each_linked_issue_once(repositories: Any, linked: None) -> None:
    """A linked issue gains its summary, and a rerun finds it current and writes nothing."""
    assert run(repositories, [WORKSPACE], dry_run=False) == (1, 1, 1)

    summary = _summary(repositories)
    assert summary is not None
    assert summary.count == 2
    assert [entry.number for entry in summary.pull_requests] == [10, 11]
    assert run(repositories, [WORKSPACE], dry_run=False) == (1, 1, 0)


def test_a_dry_run_counts_and_writes_nothing(
    repositories: Any, linked: None, capsys: pytest.CaptureFixture[str]
) -> None:
    """The command line prints counts only and leaves the issue alone under `--dry-run`."""
    from app.common.core.config import settings

    stage = settings.dynamodb_table_prefix.removeprefix("standupless-")
    assert main(["--stage", stage, "--workspace", WORKSPACE, "--dry-run"]) == 0

    printed = capsys.readouterr().out.strip()
    assert printed == "dry-run workspaces=1 linked_issues=1 summaries_written=1"
    assert _summary(repositories) is None
