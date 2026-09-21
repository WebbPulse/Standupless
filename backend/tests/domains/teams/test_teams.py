"""The team routes, against real tables in moto.

These cover the contract's team routes and the guest invariant design section
2 names: a guest 404s on a team they hold no membership in, and never sees it
in a list.
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
    OUTSIDER,
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
    """A workspace with one owner, one admin, one member and one guest."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    return WORKSPACE


def test_an_anonymous_caller_is_refused(client: TestClient, workspace: str) -> None:
    """No claims means 401 before any table is read."""
    assert client.get(f"/api/workspaces/{workspace}/teams").status_code == 401


def test_a_non_member_gets_404(client: TestClient, workspace: str) -> None:
    """Someone outside the workspace cannot tell whether it holds teams."""
    sign_in(client, OUTSIDER)
    assert client.get(f"/api/workspaces/{workspace}/teams").status_code == 404


def test_a_member_creates_a_team_and_becomes_its_admin(client: TestClient, workspace: str, repositories: Any) -> None:
    """Creating seeds the default statuses and an admin membership for the creator."""
    sign_in(client, MEMBER)
    response = client.post(f"/api/workspaces/{workspace}/teams", json={"name": "Apollo", "key_prefix": "APO"})

    assert response.status_code == 201
    body = response.json()
    assert body["key_prefix"] == "APO"
    assert body["estimate_scale"] == "off"
    assert body["role"] == "admin"

    membership = repositories.memberships.get_team_membership(workspace, body["id"], MEMBER)
    assert membership is not None
    assert membership.role == "admin"


def test_creating_seeds_the_five_default_statuses(client: TestClient, workspace: str) -> None:
    """The seed the contract fixes, in the order and categories it names."""
    sign_in(client, MEMBER)
    team_id = client.post(f"/api/workspaces/{workspace}/teams", json={"name": "Apollo", "key_prefix": "APO"}).json()[
        "id"
    ]

    statuses = client.get(f"/api/workspaces/{workspace}/teams/{team_id}/statuses").json()["statuses"]

    assert [(row["name"], row["category"], row["position"]) for row in statuses] == [
        ("Backlog", "backlog", 0),
        ("Todo", "unstarted", 1),
        ("In Progress", "started", 2),
        ("Done", "completed", 3),
        ("Cancelled", "cancelled", 4),
    ]


def test_a_guest_cannot_create_a_team(client: TestClient, workspace: str) -> None:
    """Team creation is closed to guests, per the capability table."""
    sign_in(client, GUEST)
    response = client.post(f"/api/workspaces/{workspace}/teams", json={"name": "Apollo", "key_prefix": "APO"})
    assert response.status_code == 403


def test_a_duplicate_key_prefix_is_a_conflict(client: TestClient, workspace: str) -> None:
    """Prefix uniqueness per workspace is the conditional write, surfaced as 409."""
    sign_in(client, MEMBER)
    client.post(f"/api/workspaces/{workspace}/teams", json={"name": "Apollo", "key_prefix": "APO"})
    response = client.post(f"/api/workspaces/{workspace}/teams", json={"name": "Other", "key_prefix": "APO"})

    assert response.status_code == 409


def test_the_same_prefix_is_free_in_another_workspace(client: TestClient, workspace: str, repositories: Any) -> None:
    """The uniqueness index is workspace scoped, so two tenants never collide."""
    other = "01JB0000000000000000000WS2"
    make_workspace(repositories, other, "other", MEMBER)
    sign_in(client, MEMBER)

    first = client.post(f"/api/workspaces/{workspace}/teams", json={"name": "Apollo", "key_prefix": "APO"})
    second = client.post(f"/api/workspaces/{other}/teams", json={"name": "Apollo", "key_prefix": "APO"})

    assert first.status_code == 201
    assert second.status_code == 201


def test_a_bad_key_prefix_is_rejected_before_the_table(client: TestClient, workspace: str) -> None:
    """The alphabet is held at the edge, so a bad prefix names the field."""
    sign_in(client, MEMBER)
    response = client.post(f"/api/workspaces/{workspace}/teams", json={"name": "Apollo", "key_prefix": "lower"})
    assert response.status_code == 422


def test_a_guest_404s_on_a_team_they_are_not_in(client: TestClient, workspace: str, repositories: Any) -> None:
    """The invariant design section 2 names explicitly.

    A 403 would confirm the team exists, so a guest outside it gets the same
    404 a non-member gets on the workspace.
    """
    make_team(repositories, workspace, TEAM, "APO")
    sign_in(client, GUEST)

    assert client.get(f"/api/workspaces/{workspace}/teams/{TEAM}").status_code == 404
    assert client.get(f"/api/workspaces/{workspace}/teams/{TEAM}/statuses").status_code == 404
    assert client.get(f"/api/workspaces/{workspace}/teams/{TEAM}/labels").status_code == 404


def test_a_guest_reaches_a_team_they_are_in(client: TestClient, workspace: str, repositories: Any) -> None:
    """A team membership is what widens a guest, and nothing else does."""
    make_team(repositories, workspace, TEAM, "APO")
    add_team_member(repositories, workspace, TEAM, GUEST, "member")
    sign_in(client, GUEST)

    response = client.get(f"/api/workspaces/{workspace}/teams/{TEAM}")

    assert response.status_code == 200
    assert response.json()["role"] == "member"


def test_a_guest_lists_only_the_teams_they_are_in(client: TestClient, workspace: str, repositories: Any) -> None:
    """The list applies the same rule the single read does, not a looser one."""
    make_team(repositories, workspace, TEAM, "APO")
    make_team(repositories, workspace, OTHER_TEAM, "BET")
    add_team_member(repositories, workspace, TEAM, GUEST, "member")
    sign_in(client, GUEST)

    body = client.get(f"/api/workspaces/{workspace}/teams").json()

    assert [row["id"] for row in body["teams"]] == [TEAM]


def test_a_member_sees_every_team_in_the_workspace(client: TestClient, workspace: str, repositories: Any) -> None:
    """Only a guest is narrowed; a member reads the whole workspace."""
    make_team(repositories, workspace, TEAM, "APO")
    make_team(repositories, workspace, OTHER_TEAM, "BET")
    sign_in(client, MEMBER)

    body = client.get(f"/api/workspaces/{workspace}/teams").json()

    assert {row["id"] for row in body["teams"]} == {TEAM, OTHER_TEAM}
    assert {row["role"] for row in body["teams"]} == {"member"}


def test_the_list_body_is_an_envelope(client: TestClient, workspace: str) -> None:
    """The plural key envelope the contract fixes, with nowhere for a bare array."""
    sign_in(client, MEMBER)
    body = client.get(f"/api/workspaces/{workspace}/teams").json()
    assert list(body) == ["teams"]


def test_a_team_carries_the_fields_the_frontend_reads(client: TestClient, workspace: str, repositories: Any) -> None:
    """The field set, and `next_issue_number` asserted absent."""
    make_team(repositories, workspace, TEAM, "APO")
    sign_in(client, OWNER)

    row = client.get(f"/api/workspaces/{workspace}/teams/{TEAM}").json()

    assert set(row) == {
        "id",
        "workspace_id",
        "name",
        "key_prefix",
        "description",
        "estimate_scale",
        "created_at",
        "updated_at",
        "role",
    }
    assert "next_issue_number" not in row


def test_a_workspace_admin_implies_team_admin(client: TestClient, workspace: str, repositories: Any) -> None:
    """An admin administers every team without an explicit membership."""
    make_team(repositories, workspace, TEAM, "APO")
    sign_in(client, ADMIN)

    response = client.patch(f"/api/workspaces/{workspace}/teams/{TEAM}", json={"name": "Renamed"})

    assert response.status_code == 200
    assert response.json()["name"] == "Renamed"
    assert response.json()["role"] == "admin"


def test_a_plain_member_cannot_administer_a_team(client: TestClient, workspace: str, repositories: Any) -> None:
    """A member reads a team but does not configure one they do not admin."""
    make_team(repositories, workspace, TEAM, "APO")
    sign_in(client, MEMBER)

    assert client.get(f"/api/workspaces/{workspace}/teams/{TEAM}").status_code == 200
    assert client.patch(f"/api/workspaces/{workspace}/teams/{TEAM}", json={"name": "x"}).status_code == 403


def test_a_team_member_with_admin_may_administer_it(client: TestClient, workspace: str, repositories: Any) -> None:
    """The team membership promotes a member for that team alone."""
    make_team(repositories, workspace, TEAM, "APO")
    make_team(repositories, workspace, OTHER_TEAM, "BET")
    add_team_member(repositories, workspace, TEAM, MEMBER, "admin")
    sign_in(client, MEMBER)

    assert client.patch(f"/api/workspaces/{workspace}/teams/{TEAM}", json={"name": "x"}).status_code == 200
    assert client.patch(f"/api/workspaces/{workspace}/teams/{OTHER_TEAM}", json={"name": "x"}).status_code == 403


def test_only_a_workspace_admin_deletes_a_team(client: TestClient, workspace: str, repositories: Any) -> None:
    """Deleting is workspace admin work, not something a team admin may do."""
    make_team(repositories, workspace, TEAM, "APO")
    add_team_member(repositories, workspace, TEAM, MEMBER, "admin")
    sign_in(client, MEMBER)
    assert client.delete(f"/api/workspaces/{workspace}/teams/{TEAM}").status_code == 403

    sign_in(client, ADMIN)
    assert client.delete(f"/api/workspaces/{workspace}/teams/{TEAM}").status_code == 204
    assert repositories.teams.get(workspace, TEAM) is None


def test_deleting_a_team_takes_its_configuration_with_it(client: TestClient, workspace: str, repositories: Any) -> None:
    """Statuses would otherwise outlive the team and be unreachable forever."""
    make_team(repositories, workspace, TEAM, "APO")
    sign_in(client, OWNER)

    client.delete(f"/api/workspaces/{workspace}/teams/{TEAM}")

    assert repositories.team_config.list_statuses(workspace, TEAM) == []


def test_a_failed_create_leaves_nothing_behind_and_the_prefix_free(
    client: TestClient, workspace: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A create that cannot write every row writes none of them.

    This is the staging failure: the membership write failed, the team row
    survived, and the prefix was then taken by a team with no statuses that
    could neither be used nor recreated.
    """

    def refuse(_membership: Any) -> dict[str, Any]:
        """Stand in for the IAM refusal the membership write hit in staging."""
        raise RuntimeError("AccessDeniedException on memberships")

    monkeypatch.setattr(repositories.memberships, "put_action", refuse)
    sign_in(client, MEMBER)

    with pytest.raises(RuntimeError):
        client.post(f"/api/workspaces/{workspace}/teams", json={"name": "Apollo", "key_prefix": "APO"})

    assert repositories.teams.get_by_key_prefix(workspace, "APO") is None

    monkeypatch.undo()
    retried = client.post(f"/api/workspaces/{workspace}/teams", json={"name": "Apollo", "key_prefix": "APO"})
    assert retried.status_code == 201
    team_id = retried.json()["id"]
    assert len(repositories.team_config.list_statuses(workspace, team_id)) == 5
    assert repositories.memberships.get_team_membership(workspace, team_id, MEMBER) is not None


def test_a_failed_status_seed_leaves_no_team_row(
    client: TestClient, workspace: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The seed is in the same transaction, so its failure takes the team with it."""

    def refuse(_status: Any) -> dict[str, Any]:
        """Stand in for a failure while building the seeded status writes."""
        raise RuntimeError("seed unavailable")

    monkeypatch.setattr(repositories.team_config, "create_status_action", refuse)
    sign_in(client, MEMBER)

    with pytest.raises(RuntimeError):
        client.post(f"/api/workspaces/{workspace}/teams", json={"name": "Beta", "key_prefix": "BET"})

    assert repositories.teams.get_by_key_prefix(workspace, "BET") is None
