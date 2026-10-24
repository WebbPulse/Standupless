"""The one-off reindex that reconciles search postings a dropped stream batch left wrong, against moto."""

from __future__ import annotations

from typing import Any

import pytest

from app.common.db.dynamo.comments import build_comment
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.search_index import comment_doc, comment_term
from scripts.reindex_issue_search import main, run
from tests.domains.helpers import OWNER
from tests.domains.views.conftest import OTHER_TEAM, TEAM, WORKSPACE

ISSUE = "01JB0000000000000000ISSUE1"


def _issue(repositories: Any) -> None:
    """Put one issue in the table with no postings, the way a dropped insert leaves it."""
    repositories.issues.create(
        Issue(
            workspace_id=WORKSPACE,
            issue_id=ISSUE,
            team_id=TEAM,
            key="ABC-1",
            number=1,
            title="Repair the widget",
            status_id="01JB00000000000000000STAT1",
            created_by=OWNER,
        )
    )


def _postings(repositories: Any, term: str, team_id: str = TEAM) -> list[str]:
    """Which docs one term currently points at in one team."""
    return repositories.search_index.postings(WORKSPACE, team_id, term)


def test_the_reindex_adds_missing_and_removes_stray_postings(
    dynamo_tables: None, repositories: Any, workspace: str
) -> None:
    """Missing terms are posted, a removed word and an old team's postings go, and a rerun changes nothing."""
    _issue(repositories)
    comment = repositories.comments.create(build_comment(WORKSPACE, ISSUE, TEAM, OWNER, "Traced the fault"))
    repositories.search_index.add(WORKSPACE, TEAM, "gizmo", ISSUE)
    repositories.search_index.add(WORKSPACE, OTHER_TEAM, "widget", ISSUE)

    tally = run(repositories, [WORKSPACE], dry_run=False)

    assert (tally.issues, tally.comments, tally.docs_changed) == (1, 1, 3)
    assert _postings(repositories, "widget") == [ISSUE]
    assert _postings(repositories, "repair") == [ISSUE]
    assert _postings(repositories, "gizmo") == []
    assert _postings(repositories, "widget", OTHER_TEAM) == []
    assert _postings(repositories, comment_term("fault")) == [comment_doc(comment.comment_id, ISSUE)]

    again = run(repositories, [WORKSPACE], dry_run=False)
    assert (again.docs_changed, again.added, again.removed) == (0, 0, 0)


def test_a_dry_run_counts_and_writes_nothing(
    dynamo_tables: None, repositories: Any, workspace: str, capsys: pytest.CaptureFixture[str]
) -> None:
    """The command line prints counts only and posts nothing under `--dry-run`."""
    from app.common.core.config import settings

    _issue(repositories)
    stage = settings.dynamodb_table_prefix.removeprefix("standupless-")

    assert main(["--stage", stage, "--workspace", WORKSPACE, "--dry-run"]) == 0

    printed = capsys.readouterr().out.strip()
    assert printed == (
        "dry-run workspaces=1 teams=2 issues=1 comments=0 docs_changed=1 postings_added=2 postings_removed=0"
    )
    assert _postings(repositories, "widget") == []
