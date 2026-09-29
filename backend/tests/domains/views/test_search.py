"""The search route, reading the projection the search consumer maintains.

Scope is fail-closed by construction: the partition begins with the workspace id
and the fan-out covers only the teams the caller can see, so an issue in an
invisible team is never read rather than being read and then filtered out.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.issues import IssueRepository
from app.common.db.dynamo.search_index import tokenize
from app.domains.views.endpoints.search import intersect_descending
from tests.domains.helpers import GUEST, OWNER, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM, seed_issue


def index_issue(repositories: Any, workspace: str, team_id: str, issue: "dict[str, Any]") -> None:
    """Index one issue the way the search consumer would, without running it.

    The route tests are about reading the projection, so they seed it directly and
    leave the consumer's own diffing to the consumer tests.
    """
    terms = tokenize(issue["title"], issue.get("body"), issue["key"])
    repositories.search_index.apply(workspace, team_id, issue["id"], appeared=terms, departed=set())


def test_a_term_finds_the_issue_that_carries_it(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The ordinary case: one word, one hit."""
    sign_in(issues_client, OWNER)
    wanted = seed_issue(issues_client, workspace, title="Repair the widget pipeline")
    other = seed_issue(issues_client, workspace, title="Unrelated matters entirely")
    index_issue(repositories, workspace, TEAM, wanted)
    index_issue(repositories, workspace, TEAM, other)

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
    index_issue(repositories, workspace, TEAM, both)
    index_issue(repositories, workspace, TEAM, one)

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


def test_a_guest_does_not_see_hits_from_a_team_they_are_outside(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The fan-out covers only visible teams, so the row is never read."""
    sign_in(issues_client, OWNER)
    hidden = seed_issue(issues_client, workspace, title="Secret widget plans", team_id=OTHER_TEAM)
    visible = seed_issue(issues_client, workspace, title="Public widget notes", team_id=TEAM)
    index_issue(repositories, workspace, OTHER_TEAM, hidden)
    index_issue(repositories, workspace, TEAM, visible)

    sign_in(client, GUEST)
    response = client.get(f"/api/workspaces/{workspace}/search", params={"q": "widget"})

    assert [row["issue_id"] for row in response.json()["results"]] == [visible["id"]]


def test_a_guest_searching_a_team_they_are_outside_is_not_found(
    client: TestClient, workspace: str, statuses: Any
) -> None:
    """Naming an invisible team is a 404, so an empty result reveals nothing."""
    sign_in(client, GUEST)

    response = client.get(
        f"/api/workspaces/{workspace}/search",
        params={"q": "widget", "team_id": OTHER_TEAM},
    )

    assert response.status_code == 404


def test_a_guest_cannot_resolve_a_key_outside_their_teams(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """The key lookup runs over visible teams only, like the term search."""
    sign_in(issues_client, OWNER)
    hidden = seed_issue(issues_client, workspace, title="Hidden", team_id=OTHER_TEAM)

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
        index_issue(repositories, workspace, TEAM, issue)

    sign_in(client, OWNER)
    response = client.get(f"/api/workspaces/{workspace}/search", params={"q": "widget", "limit": 2})

    assert len(response.json()["results"]) == 2


def test_a_hit_carries_the_fields_the_contract_fixes(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A result renders without a second read, so it carries what a row needs."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Widget overhaul")
    index_issue(repositories, workspace, TEAM, issue)

    sign_in(client, OWNER)
    hit = client.get(f"/api/workspaces/{workspace}/search", params={"q": "widget"}).json()["results"][0]

    assert hit["issue_id"] == issue["id"]
    assert hit["key"] == issue["key"]
    assert hit["title"] == "Widget overhaul"
    assert hit["team_id"] == TEAM
    assert hit["score"] >= 1


def test_the_merge_join_keeps_only_ids_in_every_stream() -> None:
    """The intersection of descending streams, still descending."""
    streams = [iter(["09", "07", "05", "03", "01"]), iter(["08", "07", "04", "03"]), iter(["07", "06", "03", "02"])]

    assert list(intersect_descending(streams)) == ["07", "03"]


def test_the_merge_join_stops_reading_when_the_caller_stops() -> None:
    """Taking the first match leaves the rest of every stream unread."""
    consumed: list[str] = []

    def stream(ids: list[str]) -> Iterator[str]:
        for issue_id in ids:
            consumed.append(issue_id)
            yield issue_id

    matches = intersect_descending([stream(["05", "04", "03", "02", "01"]), stream(["05", "04", "03", "02"])])

    assert next(matches) == "05"
    assert consumed == ["05", "05"]


def test_the_merge_join_of_nothing_is_empty() -> None:
    """No terms or an exhausted stream yield no match."""
    assert list(intersect_descending([])) == []
    assert list(intersect_descending([iter(["01"]), iter([])])) == []


def test_only_the_limit_is_fetched(
    client: TestClient,
    issues_client: TestClient,
    workspace: str,
    repositories: Any,
    statuses: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Many matches cost one fetch of `limit` issues, the most recently created ones."""
    sign_in(issues_client, OWNER)
    seeded = []
    for index in range(6):
        issue = seed_issue(issues_client, workspace, title=f"Widget number {index}")
        index_issue(repositories, workspace, TEAM, issue)
        seeded.append(issue["id"])
    fetched: list[list[str]] = []
    get_many = IssueRepository.get_many

    def counting(self: IssueRepository, workspace_id: str, issue_ids: list[str]) -> Any:
        fetched.append(list(issue_ids))
        return get_many(self, workspace_id, issue_ids)

    monkeypatch.setattr(IssueRepository, "get_many", counting)

    sign_in(client, OWNER)
    response = client.get(f"/api/workspaces/{workspace}/search", params={"q": "widget", "limit": 2})

    assert sorted(fetched[0]) == sorted(seeded)[-2:]
    assert sum(len(batch) for batch in fetched) == 2
    assert {row["issue_id"] for row in response.json()["results"]} == set(sorted(seeded)[-2:])


def test_results_are_ordered_by_recency_of_update(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Within the page, the most recently updated hit comes first as before."""
    sign_in(issues_client, OWNER)
    first = seed_issue(issues_client, workspace, title="Widget first")
    second = seed_issue(issues_client, workspace, title="Widget second")
    index_issue(repositories, workspace, TEAM, first)
    index_issue(repositories, workspace, TEAM, second)
    stored = repositories.issues.get_many(workspace, [first["id"]])[first["id"]]
    repositories.issues.replace(stored.model_copy(update={"updated_at": "2999-01-01T00:00:00+00:00"}))

    sign_in(client, OWNER)
    response = client.get(f"/api/workspaces/{workspace}/search", params={"q": "widget"})

    assert [row["issue_id"] for row in response.json()["results"]] == [first["id"], second["id"]]


def test_a_stale_posting_is_skipped_and_replaced(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A posting for a gone issue does not cost the caller a result slot."""
    sign_in(issues_client, OWNER)
    older = seed_issue(issues_client, workspace, title="Widget older")
    index_issue(repositories, workspace, TEAM, older)
    repositories.search_index.add(workspace, TEAM, "widget", "7ZZZZZZZZZZZZZZZZZZZZZZZZZ")

    sign_in(client, OWNER)
    response = client.get(f"/api/workspaces/{workspace}/search", params={"q": "widget", "limit": 1})

    assert [row["issue_id"] for row in response.json()["results"]] == [older["id"]]


def test_matches_merge_across_teams(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Without a team filter, every visible team's matches are merged."""
    sign_in(issues_client, OWNER)
    here = seed_issue(issues_client, workspace, title="Widget here", team_id=TEAM)
    there = seed_issue(issues_client, workspace, title="Widget there", team_id=OTHER_TEAM)
    index_issue(repositories, workspace, TEAM, here)
    index_issue(repositories, workspace, OTHER_TEAM, there)

    sign_in(client, OWNER)
    response = client.get(f"/api/workspaces/{workspace}/search", params={"q": "widget"})

    assert {row["issue_id"] for row in response.json()["results"]} == {here["id"], there["id"]}
    assert all(row["score"] == 1 for row in response.json()["results"])


def test_a_stopword_query_is_too_short(client: TestClient, workspace: str, statuses: Any) -> None:
    """A query of stopwords alone has no term to search for."""
    sign_in(client, OWNER)

    response = client.get(f"/api/workspaces/{workspace}/search", params={"q": "that with"})

    assert response.status_code == 422
    assert response.json()["error_code"] == "QUERY_TOO_SHORT"
