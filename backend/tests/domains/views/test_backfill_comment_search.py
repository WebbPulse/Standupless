"""The one-off backfill that posts comments written before comment search, against moto."""

from __future__ import annotations

from typing import Any

import pytest

from app.common.db.dynamo.comments import build_comment
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.search_index import comment_doc, comment_term
from scripts.backfill_comment_search import main, run, stored_comments
from tests.domains.helpers import OWNER
from tests.domains.views.conftest import TEAM, WORKSPACE

ISSUE = "01JB0000000000000000ISSUE1"
MOVED_TEAM = "01JB000000000000000000PRJ9"


def _issue(repositories: Any, issue_id: str = ISSUE, team_id: str = TEAM) -> None:
    """Put one issue the comments hang off in the table."""
    repositories.issues.create(
        Issue(
            workspace_id=WORKSPACE,
            issue_id=issue_id,
            team_id=team_id,
            key="ABC-1",
            number=1,
            title="Repair the widget",
            status_id="01JB00000000000000000STAT1",
            created_by=OWNER,
        )
    )


def _comment(repositories: Any, body: str, team_id: str = TEAM, issue_id: str = ISSUE) -> Any:
    """Write one comment straight to the table, the way a comment from before the consumer sits."""
    return repositories.comments.create(build_comment(WORKSPACE, issue_id, team_id, OWNER, body))


def _postings(repositories: Any, term: str, team_id: str = TEAM) -> list[str]:
    """Which comment postings one word currently points at in one team."""
    return repositories.search_index.postings(WORKSPACE, team_id, comment_term(term))


def test_the_backfill_posts_each_existing_comment(dynamo_tables: None, repositories: Any) -> None:
    """A comment from before the consumer becomes searchable, and a rerun converges on the same postings."""
    _issue(repositories)
    comment = _comment(repositories, "Traced the widget fault")

    tally = run(repositories, stored_comments(), [WORKSPACE], dry_run=False)

    assert (tally.comments, tally.indexed, tally.skipped) == (1, 1, 0)
    assert _postings(repositories, "widget") == [comment_doc(comment.comment_id, ISSUE)]
    assert _postings(repositories, "traced") == [comment_doc(comment.comment_id, ISSUE)]

    run(repositories, stored_comments(), [WORKSPACE], dry_run=False)
    assert _postings(repositories, "widget") == [comment_doc(comment.comment_id, ISSUE)]


def test_a_comment_posts_under_its_issues_current_team(dynamo_tables: None, repositories: Any) -> None:
    """The comment row's team is where it was written, so the issue says where it lives now."""
    _issue(repositories, team_id=MOVED_TEAM)
    comment = _comment(repositories, "Traced the gadget fault")

    run(repositories, stored_comments(), [WORKSPACE], dry_run=False)

    assert _postings(repositories, "gadget") == []
    assert _postings(repositories, "gadget", MOVED_TEAM) == [comment_doc(comment.comment_id, ISSUE)]


def test_orphaned_and_other_workspace_comments_are_left_alone(dynamo_tables: None, repositories: Any) -> None:
    """A comment whose issue is gone is skipped, and a workspace outside the run is not read."""
    _comment(repositories, "Traced the gadget fault")

    tally = run(repositories, stored_comments(), [WORKSPACE], dry_run=False)
    assert (tally.comments, tally.indexed, tally.skipped) == (1, 0, 1)
    assert _postings(repositories, "gadget") == []

    elsewhere = run(repositories, stored_comments(), ["01JB00000000000000000000W2"], dry_run=False)
    assert elsewhere.comments == 0


def test_a_dry_run_counts_and_writes_nothing(
    dynamo_tables: None, repositories: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    """The command line prints counts only and posts nothing under `--dry-run`."""
    from app.common.core.config import settings

    _issue(repositories)
    _comment(repositories, "Traced the widget fault")
    stage = settings.dynamodb_table_prefix.removeprefix("standupless-")

    assert main(["--stage", stage, "--workspace", WORKSPACE, "--dry-run"]) == 0

    printed = capsys.readouterr().out.strip()
    assert printed == "dry-run workspaces=1 comments=1 indexed=1 skipped=0 postings_written=3"
    assert _postings(repositories, "widget") == []
