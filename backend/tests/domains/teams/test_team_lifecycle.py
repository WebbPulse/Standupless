"""Team lifecycle routes: create fields, key changes, join and leave, counts and delete.

Key changes keep the old prefix as an alias row, so these check that an old key
still resolves, that no other team can take it, and that the team can take it
back. Delete is checked for the rows it purges and for being safe to repeat.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
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

OTHER_TEAM = "01JB000000000000000000PRJ2"

BASE = f"/api/workspaces/{WORKSPACE}/teams"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["teams"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A workspace with one of each role and two teams, APO and BET."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    make_team(repositories, WORKSPACE, TEAM, "APO")
    make_team(repositories, WORKSPACE, OTHER_TEAM, "BET")
    return WORKSPACE


def test_create_takes_a_description(client: TestClient, workspace: str) -> None:
    """The create body carries the description, so no follow-up patch is needed."""
    sign_in(client, MEMBER)
    response = client.post(BASE, json={"name": "Core", "key_prefix": "CORE", "description": "Platform work"})

    assert response.status_code == 201
    body = response.json()
    assert body["description"] == "Platform work"
    assert body["member_count"] == 1
    assert body["is_member"] is True
    assert client.get(f"{BASE}/{body['id']}").json()["description"] == "Platform work"


def test_a_team_admin_changes_the_key_and_the_old_one_still_resolves(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """The old prefix becomes an alias of the team rather than disappearing."""
    add_team_member(repositories, workspace, TEAM, MEMBER, "admin")
    sign_in(client, MEMBER)

    response = client.patch(f"{BASE}/{TEAM}", json={"key_prefix": "APX", "name": "Apex"})

    assert response.status_code == 200
    body = response.json()
    assert body["key_prefix"] == "APX"
    assert body["name"] == "Apex"
    assert body["retired_key_prefixes"] == ["APO"]
    assert repositories.teams.get_by_key_prefix(workspace, "APO").team_id == TEAM
    assert repositories.teams.get_by_key_prefix(workspace, "APX").team_id == TEAM
    listed = client.get(BASE).json()["teams"]
    assert sorted(row["key_prefix"] for row in listed) == ["APX", "BET"]


def test_a_plain_member_cannot_change_the_key(client: TestClient, workspace: str) -> None:
    """Changing the key is team admin work."""
    sign_in(client, MEMBER)
    assert client.patch(f"{BASE}/{TEAM}", json={"key_prefix": "APX"}).status_code == 403


def test_a_retired_key_is_unavailable_to_other_teams(client: TestClient, workspace: str) -> None:
    """Neither a new team nor another team's key change can take a retired prefix."""
    sign_in(client, OWNER)
    assert client.patch(f"{BASE}/{TEAM}", json={"key_prefix": "APX"}).status_code == 200

    assert client.post(BASE, json={"name": "Again", "key_prefix": "APO"}).status_code == 409
    assert client.patch(f"{BASE}/{OTHER_TEAM}", json={"key_prefix": "APO"}).status_code == 409
    assert client.patch(f"{BASE}/{OTHER_TEAM}", json={"key_prefix": "APX"}).status_code == 409


def test_a_taken_key_leaves_the_rest_of_the_patch_unapplied(client: TestClient, workspace: str) -> None:
    """A 409 on the key means the name in the same body did not change either."""
    sign_in(client, OWNER)
    response = client.patch(f"{BASE}/{TEAM}", json={"key_prefix": "BET", "name": "Renamed"})

    assert response.status_code == 409
    assert client.get(f"{BASE}/{TEAM}").json()["name"] == "Apo"


def test_a_team_can_take_back_its_own_retired_key(client: TestClient, workspace: str, repositories: Any) -> None:
    """Going APO to APX and back retires APX and drops the APO alias."""
    sign_in(client, OWNER)
    client.patch(f"{BASE}/{TEAM}", json={"key_prefix": "APX"})
    response = client.patch(f"{BASE}/{TEAM}", json={"key_prefix": "APO"})

    assert response.status_code == 200
    assert response.json()["key_prefix"] == "APO"
    assert response.json()["retired_key_prefixes"] == ["APX"]
    assert repositories.teams.get_by_key_prefix(workspace, "APX").team_id == TEAM


def test_a_lowercase_key_is_refused(client: TestClient, workspace: str) -> None:
    """The patch holds the key to the same alphabet create does."""
    sign_in(client, OWNER)
    assert client.patch(f"{BASE}/{TEAM}", json={"key_prefix": "apx"}).status_code == 422


def test_a_member_joins_and_leaves_a_team(client: TestClient, workspace: str) -> None:
    """Joining writes an explicit membership, leaving removes it, both counted."""
    sign_in(client, MEMBER)

    joined = client.post(f"{BASE}/{TEAM}/join")
    assert joined.status_code == 200
    assert joined.json()["role"] == "member"
    assert client.post(f"{BASE}/{TEAM}/join").status_code == 200

    row = next(team for team in client.get(BASE).json()["teams"] if team["id"] == TEAM)
    assert row["is_member"] is True
    assert row["member_count"] == 1

    assert client.post(f"{BASE}/{TEAM}/leave").status_code == 204
    assert client.post(f"{BASE}/{TEAM}/leave").status_code == 404
    row = next(team for team in client.get(BASE).json()["teams"] if team["id"] == TEAM)
    assert row["is_member"] is False
    assert row["member_count"] == 0


def test_joining_keeps_an_existing_admin_role(client: TestClient, workspace: str, repositories: Any) -> None:
    """Join is not a demotion for someone already in the team."""
    add_team_member(repositories, workspace, TEAM, MEMBER, "admin")
    add_team_member(repositories, workspace, TEAM, ADMIN, "admin")
    sign_in(client, MEMBER)
    assert client.post(f"{BASE}/{TEAM}/join").json()["role"] == "admin"


def test_a_guest_cannot_join_a_team_they_were_not_added_to(client: TestClient, workspace: str) -> None:
    """Guests stay invite only: the team is a 404 to them."""
    sign_in(client, GUEST)
    assert client.post(f"{BASE}/{TEAM}/join").status_code == 404


def test_the_last_admin_cannot_leave_or_be_removed(client: TestClient, workspace: str, repositories: Any) -> None:
    """A team keeps at least one explicit admin until someone else is promoted."""
    add_team_member(repositories, workspace, TEAM, MEMBER, "admin")
    sign_in(client, MEMBER)
    response = client.post(f"{BASE}/{TEAM}/leave")
    assert response.status_code == 409
    assert response.json()["error_code"] == "LAST_TEAM_ADMIN"
    assert client.delete(f"{BASE}/{TEAM}/members/{MEMBER}").status_code == 409
    assert client.put(f"{BASE}/{TEAM}/members/{MEMBER}", json={"role": "member"}).status_code == 409

    add_team_member(repositories, workspace, TEAM, ADMIN, "admin")
    assert client.post(f"{BASE}/{TEAM}/leave").status_code == 204


def test_list_counts_members_per_team(client: TestClient, workspace: str, repositories: Any) -> None:
    """Every row carries its explicit member count from one read."""
    add_team_member(repositories, workspace, TEAM, MEMBER, "admin")
    add_team_member(repositories, workspace, TEAM, GUEST, "member")
    add_team_member(repositories, workspace, OTHER_TEAM, ADMIN, "admin")
    sign_in(client, OWNER)

    counts = {row["id"]: row["member_count"] for row in client.get(BASE).json()["teams"]}

    assert counts == {TEAM: 2, OTHER_TEAM: 1}


def test_delete_purges_team_rows_and_frees_the_key(client: TestClient, workspace: str, repositories: Any) -> None:
    """Memberships, config, counters and aliases go, and every key is free again."""
    add_team_member(repositories, workspace, TEAM, MEMBER, "admin")
    repositories.counters.allocate_issue_number(workspace, TEAM)
    sign_in(client, OWNER)
    assert client.post(f"{BASE}/{TEAM}/labels", json={"name": "bug", "color": "#ff0000"}).status_code == 201
    client.patch(f"{BASE}/{TEAM}", json={"key_prefix": "APX"})

    assert client.delete(f"{BASE}/{TEAM}").status_code == 204

    assert repositories.teams.get(workspace, TEAM) is None
    assert repositories.teams.is_deleting(workspace, TEAM)
    assert repositories.memberships.list_team_members(workspace, TEAM) == []
    assert repositories.team_config.list_statuses(workspace, TEAM) == []
    assert repositories.team_config.list_labels(workspace, TEAM) == []
    assert repositories.counters.peek_issue_number(workspace, TEAM) == 0
    assert repositories.teams.list_aliases(workspace, TEAM) == []
    assert repositories.teams.get_by_key_prefix(workspace, "APO") is None
    assert [row["id"] for row in client.get(BASE).json()["teams"]] == [OTHER_TEAM]
    assert client.get(f"{BASE}/{TEAM}").status_code == 404
    assert client.post(BASE, json={"name": "Reuse", "key_prefix": "APO"}).status_code == 201
    assert client.post(BASE, json={"name": "Reuse too", "key_prefix": "APX"}).status_code == 201


def test_delete_is_safe_to_repeat_and_resumes(client: TestClient, workspace: str, repositories: Any) -> None:
    """A retry after a crash part way finishes the purge, and a repeat is a 204."""
    add_team_member(repositories, workspace, TEAM, MEMBER, "admin")
    repositories.teams.mark_deleting(workspace, TEAM)
    sign_in(client, OWNER)

    assert client.delete(f"{BASE}/{TEAM}").status_code == 204
    assert repositories.memberships.list_team_members(workspace, TEAM) == []
    assert repositories.team_config.list_statuses(workspace, TEAM) == []
    assert client.delete(f"{BASE}/{TEAM}").status_code == 204


def test_delete_pages_through_a_large_team(client: TestClient, workspace: str, repositories: Any) -> None:
    """More rows than one page still all go."""
    for index in range(250):
        add_team_member(repositories, workspace, TEAM, f"01JB00000000000000000U{index:04d}", "member")
    sign_in(client, OWNER)

    assert client.delete(f"{BASE}/{TEAM}").status_code == 204
    assert repositories.memberships.list_team_members(workspace, TEAM, limit=1000) == []


def test_a_deleting_team_cannot_be_patched_or_joined(client: TestClient, workspace: str, repositories: Any) -> None:
    """The tombstone hides the team from every write route too."""
    repositories.teams.mark_deleting(workspace, TEAM)
    sign_in(client, OWNER)

    assert client.patch(f"{BASE}/{TEAM}", json={"name": "x"}).status_code == 404
    assert client.patch(f"{BASE}/{TEAM}", json={"key_prefix": "APX"}).status_code == 404
    assert client.post(f"{BASE}/{TEAM}/join").status_code == 404
