"""The names, keys and lists the MCP issue tools resolve, and the create answer they keep whole.

Each case is dogfood friction an agent hit: a label or milestone given by name,
a parent filter given by key, a comma list of categories, a create call that
errored after it wrote, and a sub-issue offered its own parent as a duplicate.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.search_index import tokenize
from app.common.issue_filters import UnknownStatusCategory, build_issue_filter
from app.domains.integrations.mcp import issue_tools
from tests.domains.helpers import MEMBER
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM, WORKSPACE, seed_issue
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal, seed_planning

WRITE = ("issues:read", "issues:write")


def _create(client: TestClient, secret: str, **arguments: Any) -> dict[str, Any]:
    """Create one issue through the tool and answer its parsed result."""
    return answer(tool(client, secret, "create_issue", {"team_id": TEAM, "title": "An issue", **arguments}))


def _index(repositories: Any, issue_id: str, title: str) -> None:
    """Index one issue's title the way the search consumer would."""
    repositories.search_index.apply(WORKSPACE, TEAM, issue_id, appeared=tokenize(title), departed=set())


def test_create_and_update_issue_take_label_names(client: TestClient, repositories: Any, workspace: str) -> None:
    """A label name resolves within the team, in any case, on create and on update."""
    rows = seed_planning(repositories, WORKSPACE, TEAM, "Home")
    secret = mint_for(repositories, MEMBER, WRITE)

    created = _create(client, secret, label_ids=["home LABEL"])
    updated = answer(
        tool(client, secret, "update_issue", {"issue_id": created["issue_id"], "label_ids": ["Home label"]})
    )

    assert created["label_ids"] == [rows["label_id"]]
    assert updated["label_ids"] == [rows["label_id"]]


def test_an_unknown_label_name_lists_the_teams_labels(client: TestClient, repositories: Any, workspace: str) -> None:
    """An unknown name is refused with the names the team does have, and nothing is written."""
    seed_planning(repositories, WORKSPACE, TEAM, "Home")
    secret = mint_for(repositories, MEMBER, WRITE)

    text = refusal(tool(client, secret, "create_issue", {"team_id": TEAM, "title": "x", "label_ids": ["feature"]}))
    listed = answer(tool(client, secret, "list_issues", {"team_id": TEAM}))

    assert "'feature' is not a label of this team" in text
    assert "Home label" in text
    assert listed["issues"] == []


def test_bulk_add_label_by_unknown_name_is_refused(client: TestClient, repositories: Any, issue: Issue) -> None:
    """The bulk tool refuses an unknown label name the same way, changing nothing."""
    seed_planning(repositories, WORKSPACE, TEAM, "Home")
    secret = mint_for(repositories, MEMBER, WRITE)

    text = refusal(tool(client, secret, "bulk_update_issues", {"issue_ids": ["ABC-1"], "add_label_ids": ["nope"]}))

    assert "Home label" in text
    assert repositories.issues.get(WORKSPACE, issue.issue_id).label_ids == []


def test_status_category_not_takes_a_comma_list(client: TestClient, repositories: Any, workspace: str) -> None:
    """`completed,cancelled` excludes both categories in one call."""
    statuses = {row.category: row for row in repositories.team_config.list_statuses(WORKSPACE, TEAM)}
    secret = mint_for(repositories, MEMBER, WRITE)
    open_issue = _create(client, secret)["issue_id"]
    _create(client, secret, status_id=statuses["completed"].status_id)
    _create(client, secret, status_id=statuses["cancelled"].status_id)

    found = answer(tool(client, secret, "list_issues", {"status_category_not": "completed,cancelled"}))

    assert [row["issue_id"] for row in found["issues"]] == [open_issue]


def test_a_comma_list_of_categories_splits_and_still_refuses_a_bad_one() -> None:
    """The shared filter splits a comma list and names the filter it refuses."""
    wanted = build_issue_filter(user_id=MEMBER, status_category_not="completed, cancelled")

    assert wanted.status_categories_not == frozenset({"completed", "cancelled"})
    with pytest.raises(UnknownStatusCategory, match="status_category_not"):
        build_issue_filter(user_id=MEMBER, status_category_not="completed,finished")


def test_list_issues_filters_by_a_parent_key(client: TestClient, repositories: Any, issue: Issue) -> None:
    """`parent_id` takes the parent's key as get_issue does, as well as its id."""
    child = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000NC2", "ABC", 2)
    repositories.issues.replace(child.model_copy(update={"parent_id": issue.issue_id}))
    seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000NC3", "ABC", 3)
    secret = mint_for(repositories, MEMBER, WRITE)

    by_key = answer(tool(client, secret, "list_issues", {"parent_id": "abc-1"}))
    by_id = answer(tool(client, secret, "list_issues", {"parent_id": [issue.issue_id]}))

    assert [row["issue_id"] for row in by_key["issues"]] == [child.issue_id]
    assert [row["issue_id"] for row in by_id["issues"]] == [child.issue_id]


def test_bulk_milestone_name_resolves_against_the_shared_project(
    client: TestClient, repositories: Any, issue: Issue
) -> None:
    """With no project_id, a milestone name resolves in the project the issues are already in."""
    rows = seed_planning(repositories, WORKSPACE, TEAM, "Home")
    second = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000NC4", "ABC", 2)
    for row in (issue, second):
        repositories.issues.replace(row.model_copy(update={"project_id": rows["project_id"]}))
    secret = mint_for(repositories, MEMBER, WRITE)

    answer(
        tool(
            client,
            secret,
            "bulk_update_issues",
            {"issue_ids": ["ABC-1", "ABC-2"], "project_milestone_id": "Home milestone"},
        )
    )

    for issue_id in (issue.issue_id, second.issue_id):
        assert repositories.issues.get(WORKSPACE, issue_id).project_milestone_id == rows["milestone_id"]


def test_bulk_milestone_name_across_projects_says_so(client: TestClient, repositories: Any, issue: Issue) -> None:
    """Issues in different projects are refused with that reason, not a missing milestone."""
    home = seed_planning(repositories, WORKSPACE, TEAM, "Home")
    away = seed_planning(repositories, WORKSPACE, TEAM, "Away")
    second = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000NC5", "ABC", 2)
    repositories.issues.replace(issue.model_copy(update={"project_id": home["project_id"]}))
    repositories.issues.replace(second.model_copy(update={"project_id": away["project_id"]}))
    secret = mint_for(repositories, MEMBER, WRITE)

    text = refusal(
        tool(
            client,
            secret,
            "bulk_update_issues",
            {"issue_ids": ["ABC-1", "ABC-2"], "project_milestone_id": "Home milestone"},
        )
    )

    assert "different projects" in text
    assert repositories.issues.get(WORKSPACE, issue.issue_id).project_milestone_id is None


def test_create_issue_answers_the_issue_when_the_duplicate_lookup_fails(
    client: TestClient, repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failed duplicate lookup after the write still answers the created issue, so no retry duplicates it."""

    def broken(*_: Any, **__: Any) -> Any:
        """Stand in for a search read the function is not allowed to make."""
        raise RuntimeError("AccessDeniedException")

    monkeypatch.setattr(issue_tools, "find_similar", broken)
    secret = mint_for(repositories, MEMBER, WRITE)

    created = _create(client, secret, title="Login redirect broken")
    listed = answer(tool(client, secret, "list_issues", {"team_id": TEAM}))

    assert created["possible_duplicates"] == []
    assert [row["issue_id"] for row in listed["issues"]] == [created["issue_id"]]


def test_create_issue_leaves_the_parent_out_of_possible_duplicates(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """The parent shares the sub-issue's terms but is never offered as its duplicate, while a lookalike is."""
    secret = mint_for(repositories, MEMBER, WRITE)
    title = "Login redirect broken on Safari"
    parent = _create(client, secret, title=title)["issue_id"]
    unrelated = _create(client, secret, title=title)["issue_id"]
    for issue_id in (parent, unrelated):
        _index(repositories, issue_id, title)

    created = _create(client, secret, title="Login redirect broken", parent_id=parent)

    assert created["parent_id"] == parent
    assert [row["issue_id"] for row in created["possible_duplicates"]] == [unrelated]


def _other_team_issue(repositories: Any, issue_id: str, title: str, body: str = "") -> None:
    """Put one open issue in `OTHER_TEAM` and index its title and body as the search consumer would."""
    number = int(issue_id[-1])
    repositories.issues.create(
        Issue(
            workspace_id=WORKSPACE,
            issue_id=issue_id,
            team_id=OTHER_TEAM,
            key=f"XYZ-{number}",
            number=number,
            title=title,
            body=body,
            status_id=repositories.team_config.list_statuses(WORKSPACE, OTHER_TEAM)[0].status_id,
            created_by=MEMBER,
        )
    )
    repositories.search_index.apply(WORKSPACE, OTHER_TEAM, issue_id, appeared=tokenize(title, body), departed=set())


def test_create_issue_leaves_out_a_cross_team_issue_sharing_only_common_words(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A body full of the new title's terms is not enough when the titles share only a generic word."""
    _other_team_issue(
        repositories,
        "01JB0000000000000000000IS7",
        "Backfill the search index with existing comments",
        body="Retry Lambda throttling in the deploy workflow step for existing functions.",
    )
    secret = mint_for(repositories, MEMBER, WRITE)

    created = _create(client, secret, title="Retry Lambda throttling in the deploy workflow's existing-functions step")

    assert created["possible_duplicates"] == []


def test_create_issue_ranks_same_team_duplicates_first(client: TestClient, repositories: Any, workspace: str) -> None:
    """A lookalike in the new issue's team comes before an equally close one in another team."""
    secret = mint_for(repositories, MEMBER, WRITE)
    title = "Login redirect broken on Safari"
    same_team = _create(client, secret, title=title)["issue_id"]
    _index(repositories, same_team, title)
    _other_team_issue(repositories, "01JB0000000000000000000IS8", title)

    created = _create(client, secret, title="Login redirect broken")

    assert [row["issue_id"] for row in created["possible_duplicates"]] == [same_team, "01JB0000000000000000000IS8"]
