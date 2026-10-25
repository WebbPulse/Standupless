"""Pull request search, which the editor's `#` reference picker and its chips read.

These pin what the route matches on, an exact reference, a bare number or title
words, and who sees a pull request: only a caller who can see the team of an
issue one of its live links points at.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.github import IssueLink, link_key
from app.domains.integrations.pull_request_search import link_matcher
from tests.domains.helpers import GUEST, OUTSIDER, OWNER, sign_in
from tests.domains.integrations.conftest import REPOSITORY_FULL_NAME, REPOSITORY_ID, WORKSPACE

URL = f"/api/workspaces/{WORKSPACE}/github/pull-requests"


def put_link(
    repositories: Any,
    issue: Any,
    number: int,
    title: str,
    *,
    state: str = "open",
    updated_ms: int = 1,
    detached: bool = False,
    full_name: str = REPOSITORY_FULL_NAME,
    repository_id: str = REPOSITORY_ID,
) -> None:
    """Store one link from pull request `number` to `issue`."""
    link_id = f"PR_{repository_id}_{number}#{issue.issue_id}"
    repositories.github.put_link(
        IssueLink(
            workspace_id=WORKSPACE,
            github_key=link_key(link_id),
            ws_issue=f"{WORKSPACE}#{issue.issue_id}",
            link_id=link_id,
            issue_id=issue.issue_id,
            issue_key=issue.key,
            repository_full_name=full_name,
            repository_id=repository_id,
            pr_number=number,
            pr_title=title,
            pr_url=f"https://github.com/{full_name}/pull/{number}",
            pr_state=state,
            author_login="octocat",
            pr_updated_ms=updated_ms,
            detached=detached,
        )
    )


def numbers(client: TestClient, query: str) -> list[int]:
    """The pull request numbers the route answers for `query`, in order."""
    response = client.get(URL, params={"q": query})
    assert response.status_code == 200
    return [hit["number"] for hit in response.json()["pull_requests"]]


def test_title_words_match_newest_first(client: TestClient, repositories: Any, issue: Any) -> None:
    """Words match titles with the last word as a prefix, and the latest pull request leads."""
    put_link(repositories, issue, 10, "Add saved views", updated_ms=1)
    put_link(repositories, issue, 11, "Saved view subscriptions", updated_ms=2)
    put_link(repositories, issue, 12, "Fix the login page", updated_ms=3)
    sign_in(client, OWNER)

    assert numbers(client, "saved vie") == [11, 10]
    assert numbers(client, "login") == [12]


def test_a_reference_names_one_pull_request(client: TestClient, repositories: Any, issue: Any) -> None:
    """`owner/repo#n` and `repo#n` match that pull request alone, whatever the case."""
    put_link(repositories, issue, 10, "First")
    put_link(repositories, issue, 10, "Elsewhere", full_name="Other/thing", repository_id="77")
    sign_in(client, OWNER)

    assert numbers(client, "webbpulse/Standupless#10") == [10]
    response = client.get(URL, params={"q": "standupless#10"}).json()["pull_requests"]
    assert [hit["repository_full_name"] for hit in response] == [REPOSITORY_FULL_NAME]
    assert numbers(client, "standupless#11") == []


def test_a_bare_number_ranks_the_numbered_pull_request_first(client: TestClient, repositories: Any, issue: Any) -> None:
    """A number matches the pull request carrying it ahead of a title that only mentions it."""
    put_link(repositories, issue, 42, "Initial work", updated_ms=1)
    put_link(repositories, issue, 50, "Follow up to 42", updated_ms=5)
    sign_in(client, OWNER)

    assert numbers(client, "42") == [42, 50]
    assert numbers(client, "#42") == [42, 50]


def test_one_pull_request_linking_two_issues_is_one_hit(
    client: TestClient, repositories: Any, issue: Any, hidden_issue: Any
) -> None:
    """A pull request is grouped across its links and reads its newest row's state."""
    put_link(repositories, issue, 10, "Shared change", state="open", updated_ms=1)
    put_link(repositories, hidden_issue, 10, "Shared change", state="merged", updated_ms=2)
    sign_in(client, OWNER)

    hits = client.get(URL, params={"q": "shared"}).json()["pull_requests"]

    assert len(hits) == 1
    assert hits[0]["state"] == "merged"
    assert hits[0]["issue_keys"] == ["ABC-1", "XYZ-1"]
    assert hits[0]["url"] == f"https://github.com/{REPOSITORY_FULL_NAME}/pull/10"


def test_a_guest_sees_only_pull_requests_on_their_teams(
    client: TestClient, repositories: Any, issue: Any, hidden_issue: Any
) -> None:
    """Visibility follows the linked issue's team, and a shared pull request shows only visible keys."""
    put_link(repositories, issue, 10, "Visible change")
    put_link(repositories, hidden_issue, 11, "Hidden change")
    put_link(repositories, hidden_issue, 12, "Shared change")
    put_link(repositories, issue, 12, "Shared change")
    sign_in(client, GUEST)

    assert sorted(numbers(client, "change")) == [10, 12]
    hits = client.get(URL, params={"q": "shared"}).json()["pull_requests"]
    assert hits[0]["issue_keys"] == ["ABC-1"]
    assert numbers(client, "hidden") == []


def test_a_detached_link_never_makes_a_pull_request_visible(client: TestClient, repositories: Any, issue: Any) -> None:
    """A link the pull request no longer names is not a way to see it."""
    put_link(repositories, issue, 10, "Detached change", detached=True)
    sign_in(client, OWNER)

    assert numbers(client, "detached") == []


def test_an_outsider_sees_404(client: TestClient, workspace: str) -> None:
    """Someone outside the workspace must not learn it exists."""
    sign_in(client, OUTSIDER)

    assert client.get(URL, params={"q": "anything"}).status_code == 404


def test_an_issue_key_answers_no_pull_requests(client: TestClient, repositories: Any, issue: Any) -> None:
    """A key-shaped query is left to search's exact key lookup."""
    put_link(repositories, issue, 10, "ABC-1 make it work")
    sign_in(client, OWNER)

    assert numbers(client, "ABC-1") == []
    assert numbers(client, "abc") == [10]


def test_the_matcher_ignores_queries_with_nothing_to_match() -> None:
    """Whitespace and an issue key give no matcher, so no link rows are read."""
    assert link_matcher("   ") is None
    assert link_matcher("ENG-12") is None
    assert link_matcher("repo#3") is not None
