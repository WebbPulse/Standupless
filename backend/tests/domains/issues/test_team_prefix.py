"""Team key prefixes wherever a route takes a team id, and the not-found an unknown one gets.

The body, the query string and the `teams/{team_id}` path segment each carry a team
id, and each is expected to take the team's key prefix in any case as well. An
unknown reference, and a team a guest is outside, answer the same message naming
the reference, so it reads as a missing team rather than a permissions problem.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.api.middleware.team_refs import _rewrite_body, _rewrite_path, _rewrite_query
from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.team_refs import TEAM_NOT_FOUND_CODE, team_not_found_message
from tests.domains.helpers import GUEST, OWNER, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, create_issue


@pytest.fixture
def teams_client(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application, whose routes carry the team in the path."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["teams"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


def test_create_issue_takes_a_prefix_in_any_case(client: TestClient, workspace: str, statuses: Any) -> None:
    """A body `team_id` of `abc` lands the issue on the team holding ABC."""
    sign_in(client, OWNER)

    created = create_issue(client, workspace, team_id="abc", title="By prefix")
    upper = create_issue(client, workspace, team_id="XYZ", title="Upper")

    assert created["team_id"] == TEAM
    assert created["key"] == "ABC-1"
    assert upper["team_id"] == OTHER_TEAM


def test_list_issues_takes_a_prefix_in_the_query(client: TestClient, workspace: str, statuses: Any) -> None:
    """The `team_id` filter resolves a prefix the same way the body does."""
    sign_in(client, OWNER)
    create_issue(client, workspace, title="Mine")
    create_issue(client, workspace, team_id=OTHER_TEAM, title="Theirs")

    response = client.get(f"/api/workspaces/{workspace}/issues", params={"team_id": "Abc"})

    assert response.status_code == 200, response.text
    assert [row["team_id"] for row in response.json()["issues"]] == [TEAM]


def test_an_unknown_team_names_itself(client: TestClient, workspace: str, statuses: Any) -> None:
    """An unknown prefix and an unknown id both answer the team's own not-found."""
    sign_in(client, OWNER)

    by_prefix = client.post(f"/api/workspaces/{workspace}/issues", json={"team_id": "NOPE", "title": "x"})
    by_id = client.get(f"/api/workspaces/{workspace}/issues", params={"team_id": "01JB0000000000000000000000"})

    assert by_prefix.status_code == 404
    assert by_prefix.json()["error_code"] == TEAM_NOT_FOUND_CODE
    assert by_prefix.json()["message"] == team_not_found_message("NOPE")
    assert by_id.status_code == 404
    assert by_id.json()["message"] == team_not_found_message("01JB0000000000000000000000")


def test_a_guest_outside_a_team_reads_it_as_absent(client: TestClient, workspace: str, statuses: Any) -> None:
    """A guest naming a team they are outside gets exactly the unknown team's answer."""
    sign_in(client, GUEST)

    response = client.post(f"/api/workspaces/{workspace}/issues", json={"team_id": "xyz", "title": "x"})

    assert response.status_code == 404
    assert response.json()["message"] == team_not_found_message("xyz")


def test_a_team_path_takes_a_prefix(teams_client: TestClient, workspace: str) -> None:
    """A `teams/{team_id}` route resolves a prefix, and names an unknown one."""
    sign_in(teams_client, OWNER)

    found = teams_client.get(f"/api/workspaces/{workspace}/teams/abc/labels")
    missing = teams_client.get(f"/api/workspaces/{workspace}/teams/NOPE/labels")

    assert found.status_code == 200, found.text
    assert missing.status_code == 404
    assert missing.json()["message"] == team_not_found_message("NOPE")


def test_the_rewrites_leave_ids_and_other_fields_alone() -> None:
    """Only prefix-shaped team references are resolved, and nothing else is touched."""
    resolve = {"ABC": TEAM, "abc": TEAM, "XYZ": OTHER_TEAM}.get

    def lookup(reference: str) -> str:
        """The fixed resolution, or the reference unchanged."""
        return resolve(reference) or reference

    assert _rewrite_path("/api/workspaces/W/teams/abc/labels", lookup) == f"/api/workspaces/W/teams/{TEAM}/labels"
    assert _rewrite_path(f"/api/workspaces/W/teams/{TEAM}", lookup) == f"/api/workspaces/W/teams/{TEAM}"
    assert _rewrite_query(b"team_id=abc&q=abc", lookup) == f"team_id={TEAM}&q=abc".encode()
    assert _rewrite_query(b"q=abc", lookup) == b"q=abc"
    assert _rewrite_body(b'{"team_ids": ["abc", "XYZ"], "name": "abc"}', lookup) == (
        f'{{"team_ids": ["{TEAM}", "{OTHER_TEAM}"], "name": "abc"}}'.encode()
    )
    assert _rewrite_body(f'{{"team_id": "{TEAM}"}}'.encode(), lookup) is None
