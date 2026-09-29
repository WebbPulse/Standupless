"""The migration that collapses identical team statuses and labels into workspace records.

Runs against moto: two teams seeded with the defaults and a shared label, with
issues, history, views, share links and transition rules pointing at the second
team's copies, so every rewrite has something to move.
"""

from __future__ import annotations

from typing import Any

import pytest
from webbpulse.identity.share_tokens import ShareTokenRecord

from app.common.db.dynamo.activity import as_activity, build_activity
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.share_links import CAPABILITY_FILTER, share_capability
from app.common.db.dynamo.team_config import (
    WORKSPACE_SCOPE,
    Label,
    Transition,
    label_key,
    new_config_id,
    transition_key,
)
from app.common.db.dynamo.views import SavedView, team_view_key
from scripts.collapse_workspace_workflow import collapse_workspace, main, run
from tests.domains.helpers import OWNER, make_team, make_workspace

WORKSPACE = "01JB00000000000000000000WS"

FIRST = "01JB000000000000000000PRJ1"

SECOND = "01JB000000000000000000PRJ2"


def _label(repositories: Any, team_id: str, name: str, color: str) -> Label:
    """Write one team label."""
    label_id = new_config_id()
    return repositories.team_config.create_label(
        Label(
            workspace_id=WORKSPACE,
            config_key=label_key(team_id, label_id),
            team_id=team_id,
            label_id=label_id,
            name=name,
            color=color,
        )
    )


def _status_id(repositories: Any, team_id: str, name: str) -> str:
    """The id of a team's status by name."""
    return next(row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, team_id) if row.name == name)


@pytest.fixture
def seeded(repositories: Any) -> dict[str, Any]:
    """Two teams with the defaults, a shared label, a mismatched one and references to the second team's copies."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    make_team(repositories, WORKSPACE, FIRST, "APO")
    make_team(repositories, WORKSPACE, SECOND, "GEM")
    first_bug = _label(repositories, FIRST, "Bug", "#EB5757")
    second_bug = _label(repositories, SECOND, "Bug", "#eb5757")
    _label(repositories, FIRST, "Infra", "#111111")
    _label(repositories, SECOND, "Infra", "#222222")
    done = _status_id(repositories, SECOND, "Done")
    doing = _status_id(repositories, SECOND, "In Progress")
    issue = repositories.issues.create(
        Issue(
            workspace_id=WORKSPACE,
            team_id=SECOND,
            key="GEM-1",
            number=1,
            title="Ship",
            status_id=done,
            label_ids=[second_bug.label_id],
            created_by=OWNER,
        )
    )
    repositories.activity.record(
        build_activity(
            WORKSPACE, SECOND, issue.issue_id, OWNER, "updated", field="status_id", from_value=doing, to_value=done
        )
    )
    repositories.views.create(
        SavedView(
            workspace_id=WORKSPACE,
            view_key=team_view_key(SECOND, "view-1"),
            view_id="view-1",
            owner_id=OWNER,
            name="Open bugs",
            team_id=SECOND,
            filter={"status_id": [doing], "label_id": [second_bug.label_id]},
        )
    )
    repositories.share_links.put(
        ShareTokenRecord(
            token_hash="hash-1",
            tenant_id=WORKSPACE,
            capability=share_capability(SECOND, "Doing", filter={"status_id_not": [doing]}),
            target_type="filter",
            target_id=SECOND,
            created_at="2026-09-28T00:00:00+00:00",
        )
    )
    transition_id = new_config_id()
    repositories.team_config.create_transition(
        Transition(
            workspace_id=WORKSPACE,
            config_key=transition_key(SECOND, transition_id),
            team_id=SECOND,
            transition_id=transition_id,
            trigger="pr_merged",
            status_id=done,
        )
    )
    return {
        "issue": issue,
        "done": done,
        "doing": doing,
        "first_done": _status_id(repositories, FIRST, "Done"),
        "first_doing": _status_id(repositories, FIRST, "In Progress"),
        "first_bug": first_bug.label_id,
        "second_bug": second_bug.label_id,
    }


def test_identical_records_collapse_and_references_follow(repositories: Any, seeded: dict[str, Any]) -> None:
    """The defaults and the shared label become workspace records under the first team's ids; references follow."""
    counts = collapse_workspace(repositories, WORKSPACE)

    assert (counts.workspace_statuses, counts.workspace_labels) == (5, 1)
    assert (counts.team_statuses_removed, counts.team_labels_removed) == (10, 2)
    assert counts.skipped_groups == 1
    config = repositories.team_config
    workspace_statuses = {row.status_id for row in config.list_workspace_statuses(WORKSPACE)}
    assert seeded["first_done"] in workspace_statuses
    assert [row.label_id for row in config.list_workspace_labels(WORKSPACE)] == [seeded["first_bug"]]
    for team_id in (FIRST, SECOND):
        statuses = config.list_statuses(WORKSPACE, team_id)
        assert {row.scope for row in statuses} == {WORKSPACE_SCOPE}
        labels = config.list_labels(WORKSPACE, team_id)
        assert sorted((row.name, row.scope) for row in labels) == [("Bug", WORKSPACE_SCOPE), ("Infra", "team")]

    issue = repositories.issues.get(WORKSPACE, seeded["issue"].issue_id)
    assert issue.status_id == seeded["first_done"]
    assert issue.label_ids == [seeded["first_bug"]]
    history = [as_activity(item) for item in repositories.activity.list_for_issue(WORKSPACE, issue.issue_id).items]
    assert [(row.from_value, row.to_value) for row in history] == [(seeded["first_doing"], seeded["first_done"])]
    view = repositories.views.get(WORKSPACE, team_view_key(SECOND, "view-1"))
    assert view.filter == {"status_id": [seeded["first_doing"]], "label_id": [seeded["first_bug"]]}
    link = repositories.share_links.list_for_tenant(WORKSPACE)[0]
    assert link.capability[CAPABILITY_FILTER] == {"status_id_not": [seeded["first_doing"]]}
    rule = repositories.team_config.list_transitions(WORKSPACE, SECOND)[0]
    assert rule.status_id == seeded["first_done"]
    assert (counts.issues, counts.activity, counts.views, counts.share_links, counts.transitions) == (1, 1, 1, 1, 1)


def test_a_rerun_changes_nothing(repositories: Any, seeded: dict[str, Any]) -> None:
    """The second run finds only the mismatched label, so it is idempotent."""
    collapse_workspace(repositories, WORKSPACE)
    again = collapse_workspace(repositories, WORKSPACE)
    assert again.workspaces == 0
    assert again.issues == again.team_statuses_removed == again.team_labels_removed == 0
    assert len(repositories.team_config.list_workspace_statuses(WORKSPACE)) == 5


def test_a_later_team_copy_folds_into_the_existing_workspace_record(repositories: Any, seeded: dict[str, Any]) -> None:
    """A team label added after the collapse that matches a workspace label is folded into it on the next run."""
    collapse_workspace(repositories, WORKSPACE)
    late = _label(repositories, SECOND, "Bug", "#eb5757")
    counts = collapse_workspace(repositories, WORKSPACE)
    assert counts.team_labels_removed == 1
    assert counts.workspace_labels == 0
    assert late.label_id not in {row.label_id for row in repositories.team_config.list_labels(WORKSPACE, SECOND)}


def test_a_dry_run_writes_nothing(repositories: Any, seeded: dict[str, Any]) -> None:
    """Dry run counts the same work and leaves every row where it was."""
    counts = run(repositories, [WORKSPACE], dry_run=True)
    assert (counts.workspace_statuses, counts.issues, counts.views) == (5, 1, 1)
    assert repositories.team_config.list_workspace_statuses(WORKSPACE) == []
    assert repositories.issues.get(WORKSPACE, seeded["issue"].issue_id).status_id == seeded["done"]


def test_a_single_team_workspace_is_left_alone(repositories: Any) -> None:
    """With one team there is nothing shared to collapse."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    make_team(repositories, WORKSPACE, FIRST, "APO")
    counts = collapse_workspace(repositories, WORKSPACE)
    assert counts.workspaces == 0
    assert repositories.team_config.list_workspace_statuses(WORKSPACE) == []


def test_a_record_differing_in_one_team_stays_per_team(repositories: Any, seeded: dict[str, Any]) -> None:
    """A status renamed in one team is not identical everywhere, so both copies stay team records."""
    repositories.team_config.update_status(WORKSPACE, SECOND, seeded["doing"], name="Doing")
    collapse_workspace(repositories, WORKSPACE)
    names = {(row.name, row.scope) for row in repositories.team_config.list_statuses(WORKSPACE, SECOND)}
    assert ("Doing", "team") in names
    assert ("In Progress", WORKSPACE_SCOPE) not in names
    assert repositories.issues.get(WORKSPACE, seeded["issue"].issue_id).status_id == seeded["first_done"]


def test_main_prints_counts_only(repositories: Any, seeded: dict[str, Any], capsys: pytest.CaptureFixture[str]) -> None:
    """The command line prints one counts line, with no names or ids."""
    from app.common.core.config import settings

    stage = settings.dynamodb_table_prefix.removeprefix("standupless-")
    assert main(["--stage", stage, "--workspace", WORKSPACE, "--dry-run"]) == 0
    printed = capsys.readouterr().out.strip()
    assert printed.startswith("dry-run workspaces=1 ")
    assert WORKSPACE not in printed
    assert "Bug" not in printed
