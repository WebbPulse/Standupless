"""A key restricted to some teams reaches those teams and nothing else.

The restriction lives in `AuthzContext` team visibility, so these tests hold it
across the routes that read through that one check in different ways: a team in
the path, an issue or cycle found by id, a list that fans out over every visible
team, and search. A team outside the key answers not found rather than forbidden,
the same as a team the caller cannot see, so a restricted key cannot learn what
else the workspace holds.

The merged application is used so one key is tried against every domain on the
same client.
"""

from __future__ import annotations

from typing import Any, Iterator, Optional

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.api_keys import TEAM_IDS_METADATA, restricted_team_ids
from app.common.db.dynamo.planning import Cycle, Project, cycle_key, project_key
from tests.domains.helpers import (
    ADMIN,
    GUEST,
    MEMBER,
    OWNER,
    add_member,
    add_team_member,
    make_team,
    make_user,
    make_workspace,
    sign_in,
    sign_out,
)
from tests.domains.integrations.conftest import seed_issue

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

OTHER_TEAM = "01JB000000000000000000PRJ2"

MISSING_TEAM = "01JB000000000000000000PRJ7"

ISSUE = "01JB0000000000000000000IS1"

OTHER_ISSUE = "01JB0000000000000000000IS2"

READ_SCOPES = ("issues:read", "teams:read", "projects:read", "cycles:read")


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client carrying every domain."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(list(DOMAINS.values()))
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A workspace with two teams, one issue, cycle and project on each.

    The guest belongs to `TEAM` alone, so it is the caller that cannot name
    `OTHER_TEAM` on a key.
    """
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    make_user(repositories, OWNER, "owner@example.com", "Olive Owner")
    make_user(repositories, MEMBER, "member@example.com", "Mo Member")
    make_user(repositories, GUEST, "guest@example.com", "Gale Guest")
    make_team(repositories, WORKSPACE, TEAM, "ABC")
    make_team(repositories, WORKSPACE, OTHER_TEAM, "XYZ")
    add_team_member(repositories, WORKSPACE, TEAM, GUEST, "member")
    seed_issue(repositories, WORKSPACE, TEAM, ISSUE, "ABC", 1)
    seed_issue(repositories, WORKSPACE, OTHER_TEAM, OTHER_ISSUE, "XYZ", 1)
    return WORKSPACE


def seed_cycle(repositories: Any, team_id: str) -> str:
    """One cycle on a team, answering its id."""
    cycle = Cycle(
        workspace_id=WORKSPACE,
        planning_key="",
        team_id=team_id,
        name=f"{team_id} cycle",
        start_date="2026-01-01",
        end_date="2099-12-31",
        created_by=OWNER,
    )
    cycle.planning_key = cycle_key(team_id, cycle.cycle_id)
    repositories.planning.create_cycle(cycle)
    return cycle.cycle_id


def seed_project(repositories: Any, team_id: str) -> str:
    """One project on a team, answering its id."""
    project = Project(
        workspace_id=WORKSPACE,
        planning_key="",
        team_ids=[team_id],
        name=f"{team_id} project",
        created_by=OWNER,
    )
    project.planning_key = project_key(project.project_id)
    repositories.planning.create_project(project)
    return project.project_id


def mint(repositories: Any, team_ids: Optional[list[str]], scopes: tuple[str, ...] = READ_SCOPES) -> str:
    """One member key, restricted to `team_ids` when given, answering its plaintext."""
    from webbpulse.identity.api_keys import mint as mint_key

    return mint_key(
        user_id=MEMBER,
        tenant_id=WORKSPACE,
        scopes=scopes,
        name="A team key",
        store=repositories.api_keys,
        created_by=MEMBER,
        metadata={TEAM_IDS_METADATA: team_ids} if team_ids is not None else None,
    ).plaintext


def present(client: TestClient, secret: str) -> None:
    """Make every later request on this client arrive as that key."""
    sign_out(client)
    client.headers["authorization"] = f"Bearer {secret}"


def test_restricted_team_ids_reads_absent_and_empty_as_every_team() -> None:
    """A legacy key carries no metadata, and an empty list means the same as none."""
    assert restricted_team_ids(None) is None
    assert restricted_team_ids({}) is None
    assert restricted_team_ids({TEAM_IDS_METADATA: []}) is None
    assert restricted_team_ids({TEAM_IDS_METADATA: [TEAM, f" {TEAM} ", OTHER_TEAM]}) == (TEAM, OTHER_TEAM)


def test_a_key_is_created_with_teams_and_lists_them(client: TestClient, workspace: str) -> None:
    """The create body takes `team_ids`, and the create answer and the listing both show them."""
    sign_in(client, MEMBER)

    created = client.post(
        f"/api/workspaces/{workspace}/api-keys",
        json={"name": "Scoped", "scopes": ["issues:read"], "team_ids": [TEAM, TEAM]},
    )
    unrestricted = client.post(f"/api/workspaces/{workspace}/api-keys", json={"name": "All", "scopes": ["issues:read"]})

    assert created.status_code == 201, created.text
    assert created.json()["team_ids"] == [TEAM]
    assert unrestricted.json()["team_ids"] == []
    listed = client.get(f"/api/workspaces/{workspace}/api-keys").json()["api_keys"]
    rows = {row["name"]: row["team_ids"] for row in listed}
    assert rows == {"Scoped": [TEAM], "All": []}


def test_a_key_cannot_name_a_team_its_creator_cannot_see(client: TestClient, workspace: str) -> None:
    """A guest outside `OTHER_TEAM` cannot restrict a key to it, and nobody can name a missing team."""
    sign_in(client, GUEST)
    hidden = client.post(
        f"/api/workspaces/{workspace}/api-keys",
        json={"name": "Hidden", "scopes": ["issues:read"], "team_ids": [OTHER_TEAM]},
    )
    sign_in(client, MEMBER)
    missing = client.post(
        f"/api/workspaces/{workspace}/api-keys",
        json={"name": "Missing", "scopes": ["issues:read"], "team_ids": [MISSING_TEAM]},
    )

    assert hidden.status_code == 422, hidden.text
    assert missing.status_code == 422, missing.text
    assert hidden.json()["error_code"] == "VALIDATION_ERROR"


def test_a_restricted_key_reads_its_own_team(client: TestClient, repositories: Any, workspace: str) -> None:
    """The listed team answers as it would to an unrestricted key."""
    present(client, mint(repositories, [TEAM]))

    assert client.get(f"/api/workspaces/{workspace}/teams/{TEAM}").status_code == 200
    assert client.get(f"/api/workspaces/{workspace}/issues/{ISSUE}").status_code == 200


def test_a_restricted_key_finds_nothing_in_another_team(client: TestClient, repositories: Any, workspace: str) -> None:
    """A team, issue, cycle and project outside the key answer not found."""
    cycle = seed_cycle(repositories, OTHER_TEAM)
    project = seed_project(repositories, OTHER_TEAM)
    present(client, mint(repositories, [TEAM]))

    for path in (
        f"/teams/{OTHER_TEAM}",
        f"/teams/{OTHER_TEAM}/statuses",
        f"/issues/{OTHER_ISSUE}",
        "/issues/by-key/XYZ-1",
        f"/cycles/{cycle}",
        f"/projects/{project}",
    ):
        response = client.get(f"/api/workspaces/{workspace}{path}")
        assert response.status_code == 404, (path, response.text)


def test_a_restricted_key_cannot_write_into_another_team(client: TestClient, repositories: Any, workspace: str) -> None:
    """Creating an issue in a team outside the key is refused as not found, and nothing is written."""
    present(client, mint(repositories, [TEAM], ("issues:write", "issues:read")))

    refused = client.post(f"/api/workspaces/{workspace}/issues", json={"team_id": OTHER_TEAM, "title": "Leak"})
    renamed = client.patch(f"/api/workspaces/{workspace}/issues/{OTHER_ISSUE}", json={"title": "Leak"})
    allowed = client.post(f"/api/workspaces/{workspace}/issues", json={"team_id": TEAM, "title": "Fine"})

    assert refused.status_code == 404, refused.text
    assert renamed.status_code == 404, renamed.text
    assert allowed.status_code == 201, allowed.text
    assert repositories.issues.get(WORKSPACE, OTHER_ISSUE).title == "An issue"


def test_lists_that_span_teams_answer_only_the_keys_teams(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """The workspace issue, team and project lists fan out over the key's teams alone."""
    seed_project(repositories, TEAM)
    seed_project(repositories, OTHER_TEAM)
    present(client, mint(repositories, [TEAM]))

    issues = client.get(f"/api/workspaces/{workspace}/issues").json()["issues"]
    teams = client.get(f"/api/workspaces/{workspace}/teams").json()["teams"]
    projects = client.get(f"/api/workspaces/{workspace}/projects").json()["projects"]

    assert {row["team_id"] for row in issues} == {TEAM}
    assert [row["id"] for row in teams] == [TEAM]
    assert {tuple(row["team_ids"]) for row in projects} == {(TEAM,)}


def test_a_restricted_key_cannot_list_another_teams_cycles(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A per-team list naming a team outside the key answers not found."""
    seed_cycle(repositories, OTHER_TEAM)
    present(client, mint(repositories, [TEAM]))

    response = client.get(f"/api/workspaces/{workspace}/cycles", params={"team_id": OTHER_TEAM})

    assert response.status_code == 404, response.text


def test_search_stays_inside_the_keys_teams(client: TestClient, repositories: Any, workspace: str) -> None:
    """A key outside the restriction finds nothing, one inside finds its issue, and naming the other team is a 404."""
    present(client, mint(repositories, [TEAM]))

    outside = client.get(f"/api/workspaces/{workspace}/search", params={"q": "XYZ-1"})
    inside = client.get(f"/api/workspaces/{workspace}/search", params={"q": "ABC-1"})
    narrowed = client.get(f"/api/workspaces/{workspace}/search", params={"q": "XYZ-1", "team_id": OTHER_TEAM})

    assert outside.status_code == 200, outside.text
    assert outside.json()["results"] == []
    assert [row["issue_id"] for row in inside.json()["results"]] == [ISSUE]
    assert narrowed.status_code == 404, narrowed.text


def test_an_unrestricted_key_still_reaches_every_team(client: TestClient, repositories: Any, workspace: str) -> None:
    """A key minted before restrictions existed carries no metadata and keeps its reach."""
    present(client, mint(repositories, None))

    issues = client.get(f"/api/workspaces/{workspace}/issues").json()["issues"]

    assert {row["team_id"] for row in issues} == {TEAM, OTHER_TEAM}
    assert client.get(f"/api/workspaces/{workspace}/issues/{OTHER_ISSUE}").status_code == 200


def test_a_deleted_team_leaves_the_rest_of_the_key_working(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """With one listed team gone the other still answers, and with both gone the key sees nothing."""
    secret = mint(repositories, [TEAM, OTHER_TEAM])
    repositories.teams.delete(WORKSPACE, OTHER_TEAM)
    present(client, secret)

    remaining = client.get(f"/api/workspaces/{workspace}/teams").json()["teams"]
    assert [row["id"] for row in remaining] == [TEAM]

    repositories.teams.delete(WORKSPACE, TEAM)
    make_team(repositories, WORKSPACE, "01JB000000000000000000PRJ3", "NEW")

    assert client.get(f"/api/workspaces/{workspace}/teams").json()["teams"] == []
    assert client.get(f"/api/workspaces/{workspace}/issues").json()["issues"] == []
