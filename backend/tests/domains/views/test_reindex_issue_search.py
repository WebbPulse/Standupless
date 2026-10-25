"""The one-off reindex that reconciles search postings a dropped stream batch left wrong, against moto."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from app.common.db.dynamo.comments import build_comment
from app.common.db.dynamo.documents import Document, DocumentBody
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.search_index import comment_doc, comment_term
from app.domains.views.consumers.search import handle_record
from scripts import reindex_issue_search
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

    assert main(["--stage", stage, "--workspace", WORKSPACE, "--dry-run", "--skip-deploy-check"]) == 0

    printed = capsys.readouterr().out.strip()
    assert printed == (
        "dry-run workspaces=1 teams=2 issues=1 comments=0 docs_changed=1 postings_added=9 postings_removed=0"
        " documents=0 documents_changed=0"
    )
    assert _postings(repositories, "widget") == []


def test_the_reindex_adds_short_words_and_prefixes_to_old_postings(
    dynamo_tables: None, repositories: Any, workspace: str
) -> None:
    """An issue indexed before short words and prefixes gains them, and a rerun changes nothing."""
    _issue(repositories)
    for term in ("repair", "widget"):
        repositories.search_index.add(WORKSPACE, TEAM, term, ISSUE)

    tally = run(repositories, [WORKSPACE], dry_run=False)

    assert (tally.docs_changed, tally.added, tally.removed) == (1, 7, 0)
    assert _postings(repositories, "abc") == [ISSUE]
    assert _postings(repositories, "p:wid") == [ISSUE]
    assert _postings(repositories, "p:repai") == [ISSUE]
    again = run(repositories, [WORKSPACE], dry_run=False)
    assert (again.docs_changed, again.added, again.removed) == (0, 0, 0)


def test_the_reindex_rewrites_stale_document_terms(dynamo_tables: None, repositories: Any, workspace: str) -> None:
    """A document stored with four-letter terms only gains its short words, and a rerun changes nothing."""
    document = Document(
        workspace_id=WORKSPACE,
        parent_kind="project",
        parent_id="01JB00000000000000000PROJ1",
        title="UI review",
        author_id=OWNER,
        updated_by=OWNER,
        terms=["review"],
    )
    body = DocumentBody(
        workspace_id=WORKSPACE,
        document_id=document.document_id,
        parent_kind="project",
        parent_id=document.parent_id,
        body="Export to CSV",
    )
    repositories.documents.create(document, body)

    dry = run(repositories, [WORKSPACE], dry_run=True)
    assert (dry.documents, dry.documents_changed) == (1, 1)
    assert repositories.documents.get(WORKSPACE, document.document_id)[0].terms == ["review"]

    tally = run(repositories, [WORKSPACE], dry_run=False)

    assert (tally.documents, tally.documents_changed) == (1, 1)
    stored = repositories.documents.get(WORKSPACE, document.document_id)[0]
    assert {"ui", "csv", "export", "review"} <= set(stored.terms)
    again = run(repositories, [WORKSPACE], dry_run=False)
    assert again.documents_changed == 0


def test_the_reindex_finds_nothing_to_change_after_the_consumer_indexed_an_issue(
    dynamo_tables: None, repositories: Any, workspace: str
) -> None:
    """Postings the live consumer wrote, short words and prefixes included, are exactly what the reindex wants."""
    _issue(repositories)
    image = {
        "workspace_id": {"S": WORKSPACE},
        "team_id": {"S": TEAM},
        "issue_id": {"S": ISSUE},
        "key": {"S": "ABC-1"},
        "title": {"S": "Repair the widget"},
    }
    handle_record(repositories, {"eventName": "INSERT", "eventID": "1", "dynamodb": {"NewImage": image}})

    first = run(repositories, [WORKSPACE], dry_run=True)
    second = run(repositories, [WORKSPACE], dry_run=True)

    assert (first.added, first.removed) == (0, 0)
    assert (second.added, second.removed) == (0, 0)
    assert _postings(repositories, "abc") == [ISSUE]
    assert _postings(repositories, "p:wid") == [ISSUE]


def test_the_reindex_leaves_a_trashed_issue_unposted_and_keeps_its_comments(
    dynamo_tables: None, repositories: Any, workspace: str
) -> None:
    """A trashed issue loses its own postings, its comments keep theirs, and a rerun converges."""
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
            deleted_at=datetime.now(UTC),
        )
    )
    comment = repositories.comments.create(build_comment(WORKSPACE, ISSUE, TEAM, OWNER, "Traced the fault"))
    repositories.search_index.add(WORKSPACE, TEAM, "widget", ISSUE)

    tally = run(repositories, [WORKSPACE], dry_run=False)

    assert tally.removed == 1
    assert _postings(repositories, "widget") == []
    assert _postings(repositories, comment_term("fault")) == [comment_doc(comment.comment_id, ISSUE)]
    again = run(repositories, [WORKSPACE], dry_run=False)
    assert (again.docs_changed, again.added, again.removed) == (0, 0, 0)


def test_the_reindex_refuses_when_the_indexing_code_differs_from_the_deployed_branch(
    dynamo_tables: None,
    repositories: Any,
    workspace: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A checkout whose tokenizer is not the deployed one would delete live postings, so the run stops first."""
    _issue(repositories)
    monkeypatch.setattr(
        reindex_issue_search, "deploy_drift", lambda stage: "the indexing code differs from origin/main"
    )

    assert main(["--stage", "production", "--workspace", WORKSPACE, "--dry-run"]) == 2

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "refusing to reindex" in captured.err


def test_production_deploys_from_main_and_other_stages_from_staging() -> None:
    """The deploy check compares production with main and every other stage with staging."""
    assert reindex_issue_search.deployed_branch("production") == "main"
    assert reindex_issue_search.deployed_branch("staging") == "staging"


def test_explain_buckets_changes_by_doc_and_term_kind() -> None:
    """The explain buckets name the direction, the doc kind, whether it is wanted and the term kind."""
    assert (
        reindex_issue_search.change_reason("removed", "c:p:wid", "C1#I1", {"c:x"}) == "removed comment:wanted:comment"
    )
    assert reindex_issue_search.change_reason("added", "p:wid", "I1", set()) == "added issue:unwanted:prefix"
