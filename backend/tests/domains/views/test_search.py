"""The search route, reading the projection the search consumer maintains.

Scope is fail-closed by construction: the partition begins with the workspace id
and the fan-out covers only the projects the caller can see, so an issue in an
invisible project is never read rather than being read and then filtered out.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.search_index import tokenize
from tests.domains.helpers import GUEST, OWNER, sign_in
from tests.domains.views.conftest import OTHER_PROJECT, PROJECT, seed_issue


def index_issue(repositories: Any, workspace: str, project_id: str, issue: "dict[str, Any]") -> None:
    """Index one issue the way the search consumer would, without running it.

    The route tests are about reading the projection, so they seed it directly and
    leave the consumer's own diffing to the consumer tests.
    """
    terms = tokenize(issue["title"], issue.get("body"), issue["key"])
    repositories.search_index.apply(workspace, project_id, issue["id"], appeared=terms, departed=set())


def test_a_term_finds_the_issue_that_carries_it(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The ordinary case: one word, one hit."""
    sign_in(issues_client, OWNER)
    wanted = seed_issue(issues_client, workspace, title="Repair the widget pipeline")
    other = seed_issue(issues_client, workspace, title="Unrelated matters entirely")
    index_issue(repositories, workspace, PROJECT, wanted)
    index_issue(repositories, workspace, PROJECT, other)

    sign_in(client, OWNER)
    response = client.get(f"/api/workspaces/{workspace}/search", params={"q": "widget"})

    assert response.status_code == 200
    assert [row["issue_id"] for row in response.json()["results"]] == [wanted["id"]]


def test_two_terms_intersect(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Ranking is an intersection, so an issue missing one term is not a hit."""
    sign_in(issues_client, OWNER)
    both = seed_issue(issues_client, workspace, title="Widget pipeline repair")
    one = seed_issue(issues_client, workspace, title="Widget polishing")
    index_issue(repositories, workspace, PROJECT, both)
    index_issue(repositories, workspace, PROJECT, one)

    sign_in(client, OWNER)
    response = client.get(f"/api/workspaces/{workspace}/search", params={"q": "widget pipeline"})

    assert [row["issue_id"] for row in response.json()["results"]] == [both["id"]]


def test_a_short_query_matches_nothing_rather_than_everything(
    client: TestClient, workspace: str, statuses: Any
) -> None:
    """Terms below the minimum length are not indexed, so they cannot be searched."""
    sign_in(client, OWNER)

    response = client.get(f"/api/workspaces/{workspace}/search", params={"q": "the a of"})

    assert response.status_code == 422
    assert response.json()["error_code"] == "QUERY_TOO_SHORT"


def test_a_query_shorter_than_the_minimum_is_rejected_by_validation(client: TestClient, workspace: str) -> None:
    """One character is below the route's own floor, before any tokenizing."""
    sign_in(client, OWNER)

    assert client.get(f"/api/workspaces/{workspace}/search", params={"q": "a"}).status_code == 422


def test_an_issue_key_resolves_exactly(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """Typing a key is meant to be exact, so it never touches a posting list."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Anything at all")

    sign_in(client, OWNER)
    response = client.get(f"/api/workspaces/{workspace}/search", params={"q": issue["key"]})

    assert response.status_code == 200
    assert [row["issue_id"] for row in response.json()["results"]] == [issue["id"]]


def test_an_issue_key_resolves_however_it_was_typed(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """Case is not something a caller should have to get right."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Anything at all")

    sign_in(client, OWNER)
    response = client.get(f"/api/workspaces/{workspace}/search", params={"q": issue["key"].lower()})

    assert [row["issue_id"] for row in response.json()["results"]] == [issue["id"]]


def test_a_key_that_names_no_issue_is_empty(client: TestClient, workspace: str, statuses: Any) -> None:
    """A well formed key for a missing issue is no hits, not an error."""
    sign_in(client, OWNER)

    response = client.get(f"/api/workspaces/{workspace}/search", params={"q": "ABC-9999"})

    assert response.status_code == 200
    assert response.json()["results"] == []


def test_a_guest_does_not_see_hits_from_a_project_they_are_outside(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The fan-out covers only visible projects, so the row is never read."""
    sign_in(issues_client, OWNER)
    hidden = seed_issue(issues_client, workspace, title="Secret widget plans", project_id=OTHER_PROJECT)
    visible = seed_issue(issues_client, workspace, title="Public widget notes", project_id=PROJECT)
    index_issue(repositories, workspace, OTHER_PROJECT, hidden)
    index_issue(repositories, workspace, PROJECT, visible)

    sign_in(client, GUEST)
    response = client.get(f"/api/workspaces/{workspace}/search", params={"q": "widget"})

    assert [row["issue_id"] for row in response.json()["results"]] == [visible["id"]]


def test_a_guest_searching_a_project_they_are_outside_is_not_found(
    client: TestClient, workspace: str, statuses: Any
) -> None:
    """Naming an invisible project is a 404, so an empty result reveals nothing."""
    sign_in(client, GUEST)

    response = client.get(
        f"/api/workspaces/{workspace}/search",
        params={"q": "widget", "project_id": OTHER_PROJECT},
    )

    assert response.status_code == 404


def test_a_guest_cannot_resolve_a_key_outside_their_projects(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """The key lookup runs over visible projects only, like the term search."""
    sign_in(issues_client, OWNER)
    hidden = seed_issue(issues_client, workspace, title="Hidden", project_id=OTHER_PROJECT)

    sign_in(client, GUEST)
    response = client.get(f"/api/workspaces/{workspace}/search", params={"q": hidden["key"]})

    assert response.status_code == 200
    assert response.json()["results"] == []


def test_a_non_member_cannot_search(client: TestClient, workspace: str) -> None:
    """Fail closed: no workspace membership is a 404."""
    sign_in(client, "01JB000000000000000000OUTS")

    assert client.get(f"/api/workspaces/{workspace}/search", params={"q": "widget"}).status_code == 404


def test_the_limit_caps_the_results(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Search is not paged, so it caps and says so rather than handing out a cursor."""
    sign_in(issues_client, OWNER)
    for index in range(4):
        issue = seed_issue(issues_client, workspace, title=f"Widget number {index}")
        index_issue(repositories, workspace, PROJECT, issue)

    sign_in(client, OWNER)
    response = client.get(f"/api/workspaces/{workspace}/search", params={"q": "widget", "limit": 2})

    assert len(response.json()["results"]) == 2


def test_a_hit_carries_the_fields_the_contract_fixes(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A result renders without a second read, so it carries what a row needs."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Widget overhaul")
    index_issue(repositories, workspace, PROJECT, issue)

    sign_in(client, OWNER)
    hit = client.get(f"/api/workspaces/{workspace}/search", params={"q": "widget"}).json()["results"][0]

    assert hit["issue_id"] == issue["id"]
    assert hit["key"] == issue["key"]
    assert hit["title"] == "Widget overhaul"
    assert hit["project_id"] == PROJECT
    assert hit["score"] >= 1
