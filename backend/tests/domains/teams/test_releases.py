"""The release routes, against real tables in moto.

These pin who may record, change and delete a release and its team's pipeline,
that one commit lands on one release however many times it is reported, that
issue references which name nothing are echoed rather than refused, and that an
issue lists the releases it shipped in only to callers who can see their team.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.issues import Issue
from tests.domains.helpers import (
    ADMIN,
    GUEST,
    MEMBER,
    OWNER,
    add_member,
    add_team_member,
    make_team,
    make_workspace,
    sign_in,
)

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

OTHER = "01JB000000000000000000PRJ2"

BASE = f"/api/workspaces/{WORKSPACE}"

RELEASES = f"{BASE}/teams/{TEAM}/releases"

PIPELINE = f"{BASE}/teams/{TEAM}/release-pipeline"


def _app(repositories: Any, domain: str) -> Any:
    """One domain's application bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS[domain])
    bind_repositories(app, repositories)
    return app


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application over a workspace with every role and two teams."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    make_team(repositories, WORKSPACE, TEAM, "APO")
    make_team(repositories, WORKSPACE, OTHER, "GEM")
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "member")
    with TestClient(_app(repositories, "teams")) as test_client:
        yield test_client


def _issue(repositories: Any, team_id: str, prefix: str, number: int) -> Issue:
    """Put one issue in, in the team's first status, as the issues domain would have stored it."""
    status_id = repositories.team_config.list_statuses(WORKSPACE, team_id)[0].status_id
    return repositories.issues.create(
        Issue(
            workspace_id=WORKSPACE,
            team_id=team_id,
            key=f"{prefix}-{number}",
            number=number,
            title=f"Issue {number}",
            status_id=status_id,
            created_by=OWNER,
        )
    )


def test_a_team_with_no_pipeline_reads_the_default(client: TestClient) -> None:
    """Every team can record releases before anyone sets stages up."""
    sign_in(client, MEMBER)
    response = client.get(PIPELINE)

    assert response.status_code == 200
    assert response.json() == {
        "team_id": TEAM,
        "configured": False,
        "stages": [{"stage_id": "production", "name": "Production", "github_environments": ["production"]}],
    }


def test_only_a_team_admin_sets_the_pipeline(client: TestClient) -> None:
    """A member may record releases but not change where they go."""
    body = {"stages": [{"name": "Staging", "github_environments": ["staging"]}, {"name": "Production"}]}
    sign_in(client, MEMBER)
    assert client.put(PIPELINE, json=body).status_code == 403

    sign_in(client, ADMIN)
    response = client.put(PIPELINE, json=body)

    assert response.status_code == 200, response.text
    assert response.json()["configured"] is True
    assert [stage["name"] for stage in response.json()["stages"]] == ["Staging", "Production"]


def test_one_environment_maps_to_one_stage(client: TestClient) -> None:
    """A deployment must mean exactly one stage."""
    sign_in(client, ADMIN)
    body = {
        "stages": [
            {"name": "Staging", "github_environments": ["prod"]},
            {"name": "Production", "github_environments": ["prod"]},
        ]
    }
    assert client.put(PIPELINE, json=body).status_code == 422


def test_a_guest_outside_the_team_cannot_see_releases(client: TestClient) -> None:
    """Releases are as hidden as the team they belong to."""
    sign_in(client, GUEST)
    assert client.get(RELEASES).status_code == 404
    assert client.post(RELEASES, json={"name": "1.0"}).status_code == 404


def test_create_resolves_keys_and_echoes_what_named_nothing(client: TestClient, repositories: Any) -> None:
    """Keys, ids and keys in commit messages all land, and a bad key is reported back."""
    first = _issue(repositories, TEAM, "APO", 1)
    second = _issue(repositories, TEAM, "APO", 2)
    third = _issue(repositories, TEAM, "APO", 3)
    elsewhere = _issue(repositories, OTHER, "GEM", 1)
    sign_in(client, MEMBER)
    response = client.post(
        RELEASES,
        json={
            "version": "1.4.0",
            "issues": ["apo-1", second.issue_id, "APO-99", "GEM-1"],
            "commit_messages": ["Fix the thing (APO-3)", "Mention GEM-1"],
        },
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["name"] == "1.4.0"
    assert body["source"] == "manual"
    assert body["current_stage"]["name"] == "Production"
    assert {issue["issue_id"] for issue in body["issues"]} == {first.issue_id, second.issue_id, third.issue_id}
    assert elsewhere.issue_id not in {issue["issue_id"] for issue in body["issues"]}
    assert body["skipped_issues"] == ["APO-99", "GEM-1"]
    assert "APO-1 Issue 1" in body["notes"]


def test_the_same_sha_lands_on_one_release(client: TestClient) -> None:
    """A retry or a promotion of a commit advances its release instead of making another."""
    sign_in(client, ADMIN)
    client.put(PIPELINE, json={"stages": [{"name": "Staging"}, {"name": "Production"}]})
    sign_in(client, MEMBER)
    created = client.post(RELEASES, json={"sha": "a" * 40, "stage": "staging"})
    again = client.post(RELEASES, json={"sha": "a" * 40, "stage": "Production"})

    assert created.status_code == 201, created.text
    assert again.status_code == 200, again.text
    assert again.json()["release_id"] == created.json()["release_id"]
    assert [stage["name"] for stage in again.json()["stages"]] == ["Staging", "Production"]
    assert again.json()["current_stage"]["name"] == "Production"
    assert created.json()["name"].endswith("-aaaaaaa")
    assert len(client.get(RELEASES).json()["releases"]) == 1


def test_an_unknown_stage_is_refused(client: TestClient) -> None:
    """A typo in a stage name names the stages there are."""
    sign_in(client, MEMBER)
    response = client.post(RELEASES, json={"stage": "prod-eu"})

    assert response.status_code == 422
    assert "Production" in response.text


def test_advance_edit_and_issue_changes(client: TestClient, repositories: Any) -> None:
    """A release moves through stages, is renamed, and gains and loses issues."""
    issue = _issue(repositories, TEAM, "APO", 1)
    sign_in(client, ADMIN)
    client.put(PIPELINE, json={"stages": [{"name": "Staging"}, {"name": "Production"}]})
    sign_in(client, MEMBER)
    release_id = client.post(RELEASES, json={"name": "Draft"}).json()["release_id"]
    url = f"{RELEASES}/{release_id}"

    advanced = client.post(f"{url}/stages", json={"stage": "Production", "environment": "prod"})
    assert advanced.status_code == 200, advanced.text
    assert advanced.json()["current_stage"]["environment"] == "prod"

    renamed = client.patch(url, json={"name": "Spring", "version": "2.0.0"})
    assert renamed.json()["name"] == "Spring"
    assert client.patch(url, json={"name": None}).status_code == 422

    added = client.post(f"{url}/issues", json={"issues": ["APO-1", "APO-7"]})
    assert [row["key"] for row in added.json()["issues"]] == ["APO-1"]
    assert added.json()["skipped_issues"] == ["APO-7"]

    removed = client.delete(f"{url}/issues/APO-1")
    assert removed.status_code == 200
    assert removed.json()["issues"] == []
    assert issue.issue_id not in repositories.releases.get(WORKSPACE, TEAM, release_id).issue_ids


def test_only_a_team_admin_deletes_a_release(client: TestClient) -> None:
    """Deleting a release loses its record, so it is an administrator's call."""
    sign_in(client, MEMBER)
    release_id = client.post(RELEASES, json={"name": "Gone"}).json()["release_id"]
    assert client.delete(f"{RELEASES}/{release_id}").status_code == 403

    sign_in(client, ADMIN)
    assert client.delete(f"{RELEASES}/{release_id}").status_code == 204
    assert client.get(f"{RELEASES}/{release_id}").status_code == 404


def test_listing_pages_newest_first(client: TestClient) -> None:
    """The cursor walks every release once, newest id first."""
    sign_in(client, MEMBER)
    names = [client.post(RELEASES, json={"name": f"R{index}"}).json()["name"] for index in range(3)]
    first = client.get(RELEASES, params={"limit": 2}).json()
    second = client.get(RELEASES, params={"limit": 2, "cursor": first["next_cursor"]}).json()

    listed = [row["release_id"] for row in first["releases"] + second["releases"]]
    assert sorted(row["name"] for row in first["releases"] + second["releases"]) == sorted(names)
    assert listed == sorted(listed, reverse=True)
    assert second["next_cursor"] is None


def test_an_issue_lists_the_releases_it_shipped_in(client: TestClient, repositories: Any) -> None:
    """The issue page shows where its work went, hidden from callers who cannot see the team."""
    issue = _issue(repositories, TEAM, "APO", 1)
    sign_in(client, MEMBER)
    client.post(RELEASES, json={"name": "Older", "issues": ["APO-1"]})
    client.post(RELEASES, json={"name": "Newer", "issues": ["APO-1"]})

    with TestClient(_app(repositories, "issues")) as issues_client:
        sign_in(issues_client, MEMBER)
        response = issues_client.get(f"{BASE}/issues/{issue.issue_id}/releases")
        sign_in(issues_client, GUEST)
        hidden = issues_client.get(f"{BASE}/issues/{issue.issue_id}/releases")

    assert response.status_code == 200, response.text
    assert sorted(row["name"] for row in response.json()["releases"]) == ["Newer", "Older"]
    assert response.json()["releases"][0]["current_stage"]["name"] == "Production"
    assert hidden.status_code == 404


def test_purging_a_team_removes_its_releases_and_links(client: TestClient, repositories: Any) -> None:
    """A deleted team leaves no release rows and no issue links behind."""
    issue = _issue(repositories, TEAM, "APO", 1)
    sign_in(client, MEMBER)
    client.post(RELEASES, json={"name": "One", "sha": "b" * 40, "issues": ["APO-1"]})

    while repositories.releases.delete_team_page(WORKSPACE, TEAM):
        pass

    assert repositories.releases.list_for_team(WORKSPACE, TEAM, limit=10)[0] == []
    assert repositories.releases.list_for_issue(WORKSPACE, issue.issue_id) == []
    assert repositories.releases.release_for_sha(WORKSPACE, TEAM, "", "b" * 40) is None
