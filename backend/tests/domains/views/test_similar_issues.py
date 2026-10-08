"""The possible duplicates route the create dialog reads while a title is typed.

Matching is the search projection's own term match, loosened from an
intersection to an overlap, and only open issues in teams the caller can see
are answered.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.similar_issues import required_matches
from tests.domains.helpers import MEMBER, OWNER, add_team_member, sign_in
from tests.domains.views.conftest import TEAM, seed_issue
from tests.domains.views.test_search import index_issue


def _similar(client: TestClient, workspace: str, title: str) -> "list[dict[str, Any]]":
    """The possible duplicates of one draft title."""
    response = client.get(f"/api/workspaces/{workspace}/search/similar", params={"title": title})
    assert response.status_code == 200, response.text
    return response.json()["results"]


@pytest.mark.parametrize(("terms", "needed"), [(0, 0), (1, 1), (2, 2), (3, 2), (4, 2), (5, 3), (8, 4)])
def test_the_overlap_needed_grows_with_the_title(terms: int, needed: int) -> None:
    """One term must match outright, longer titles need at least two and half."""
    assert required_matches(terms) == needed


def test_an_overlapping_title_is_suggested_with_its_status(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Two of three terms shared is a match, one is not."""
    sign_in(issues_client, OWNER)
    close = seed_issue(issues_client, workspace, title="Login redirect broken on Safari")
    loose = seed_issue(issues_client, workspace, title="Login page copy")
    for issue in (close, loose):
        index_issue(repositories, workspace, TEAM, issue)

    sign_in(client, OWNER)
    results = _similar(client, workspace, "Login redirect fails")

    assert [row["issue_id"] for row in results] == [close["id"]]
    assert results[0]["key"] == close["key"]
    assert results[0]["status_name"] == statuses["backlog"].name
    assert results[0]["status_category"] == "backlog"


def test_finished_issues_and_body_only_matches_are_left_out(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A completed issue is not a duplicate to file against, and a title must share a term."""
    sign_in(issues_client, OWNER)
    done = seed_issue(
        issues_client, workspace, title="Widget pipeline stalls", status_id=statuses["completed"].status_id
    )
    body_only = seed_issue(issues_client, workspace, title="Something else", body="widget pipeline stalls")
    open_one = seed_issue(issues_client, workspace, title="Widget pipeline stalls nightly")
    for issue in (done, body_only, open_one):
        index_issue(repositories, workspace, TEAM, issue)

    sign_in(client, OWNER)

    assert [row["issue_id"] for row in _similar(client, workspace, "widget pipeline stalls")] == [open_one["id"]]


def test_a_title_with_no_searchable_term_is_empty_not_refused(client: TestClient, workspace: str) -> None:
    """The dialog asks while typing, so short words answer nothing rather than a 422."""
    sign_in(client, OWNER)

    assert _similar(client, workspace, "a bug in it") == []


def test_a_private_team_is_suggested_only_to_its_members(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The fan-out covers visible teams only, as search does."""
    sign_in(issues_client, MEMBER)
    hidden = seed_issue(issues_client, workspace, title="Secret widget plans", team_id=TEAM)
    index_issue(repositories, workspace, TEAM, hidden)
    add_team_member(repositories, workspace, TEAM, MEMBER, "member")
    repositories.memberships.set_team_private(workspace, TEAM, True)

    sign_in(client, OWNER)
    assert _similar(client, workspace, "widget plans") == []

    sign_in(client, MEMBER)
    assert [row["issue_id"] for row in _similar(client, workspace, "widget plans")] == [hidden["id"]]


def test_the_issue_being_edited_can_be_left_out(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """`exclude_issue_id` keeps an issue from being its own duplicate."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Widget pipeline stalls")
    index_issue(repositories, workspace, TEAM, issue)

    sign_in(client, OWNER)
    response = client.get(
        f"/api/workspaces/{workspace}/search/similar",
        params={"title": "widget pipeline", "exclude_issue_id": issue["id"]},
    )

    assert response.json()["results"] == []
