"""The team member, status and label routes, against real tables in moto.

These pin the configuration surface the contract fixes: who may change it, the
status invariant that a category keeps its last status, and the envelopes.
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
    make_user,
    make_workspace,
    sign_in,
)

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["teams"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def team(repositories: Any) -> str:
    """A workspace with every role, holding one team with seeded statuses."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    make_team(repositories, WORKSPACE, TEAM, "APO")
    return TEAM


def test_team_members_are_listed_with_their_user_rows(client: TestClient, team: str, repositories: Any) -> None:
    """The list joins the team membership with the user row for display."""
    make_user(repositories, GUEST, "guest@example.com", "Grace")
    add_team_member(repositories, WORKSPACE, team, GUEST, "member")
    sign_in(client, OWNER)

    members = client.get(f"/api/workspaces/{WORKSPACE}/teams/{team}/members").json()["members"]

    assert len(members) == 1
    assert members[0]["user_id"] == GUEST
    assert members[0]["display_name"] == "Grace"
    assert members[0]["role"] == "member"


def test_adding_a_team_member_needs_a_workspace_member(client: TestClient, team: str) -> None:
    """A team membership narrows workspace access, so it never grants it."""
    sign_in(client, OWNER)
    response = client.put(
        f"/api/workspaces/{WORKSPACE}/teams/{team}/members/{OUTSIDER}",
        json={"role": "member"},
    )

    assert response.status_code == 400
    assert response.json()["error_code"] == "NOT_A_WORKSPACE_MEMBER"


def test_putting_a_team_member_is_idempotent(client: TestClient, team: str) -> None:
    """A put sets the role whether or not the membership already existed."""
    sign_in(client, OWNER)
    path = f"/api/workspaces/{WORKSPACE}/teams/{team}/members/{GUEST}"

    first = client.put(path, json={"role": "member"})
    second = client.put(path, json={"role": "admin"})

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["role"] == "admin"


def test_removing_a_team_member_closes_a_guest_out(client: TestClient, team: str, repositories: Any) -> None:
    """Losing the membership is what takes a guest's access back."""
    add_team_member(repositories, WORKSPACE, team, GUEST, "member")
    sign_in(client, GUEST)
    assert client.get(f"/api/workspaces/{WORKSPACE}/teams/{team}").status_code == 200

    sign_in(client, OWNER)
    assert client.delete(f"/api/workspaces/{WORKSPACE}/teams/{team}/members/{GUEST}").status_code == 204

    sign_in(client, GUEST)
    assert client.get(f"/api/workspaces/{WORKSPACE}/teams/{team}").status_code == 404


def test_a_plain_member_cannot_change_team_membership(client: TestClient, team: str) -> None:
    """Managing who is in a team is team admin work."""
    sign_in(client, MEMBER)
    response = client.put(
        f"/api/workspaces/{WORKSPACE}/teams/{team}/members/{GUEST}",
        json={"role": "member"},
    )
    assert response.status_code == 403


def test_the_status_list_is_an_envelope_ordered_by_position(client: TestClient, team: str) -> None:
    """The contract fixes both the plural key and the ordering."""
    sign_in(client, MEMBER)
    body = client.get(f"/api/workspaces/{WORKSPACE}/teams/{team}/statuses").json()

    assert list(body) == ["statuses"]
    positions = [row["position"] for row in body["statuses"]]
    assert positions == sorted(positions)


def test_a_status_is_created_at_the_end_by_default(client: TestClient, team: str) -> None:
    """Omitting a position appends rather than colliding with an existing one."""
    sign_in(client, OWNER)
    response = client.post(
        f"/api/workspaces/{WORKSPACE}/teams/{team}/statuses",
        json={"name": "Blocked", "category": "started"},
    )

    assert response.status_code == 201
    assert response.json()["position"] == 5


def test_a_status_can_be_renamed_and_moved(client: TestClient, team: str) -> None:
    """A patch changes only the fields it names."""
    sign_in(client, OWNER)
    statuses = client.get(f"/api/workspaces/{WORKSPACE}/teams/{team}/statuses").json()["statuses"]
    status_id = statuses[0]["id"]

    response = client.patch(
        f"/api/workspaces/{WORKSPACE}/teams/{team}/statuses/{status_id}",
        json={"name": "Icebox", "position": 9},
    )

    assert response.status_code == 200
    assert response.json()["name"] == "Icebox"
    assert response.json()["position"] == 9
    assert response.json()["category"] == "backlog"


def test_the_last_status_of_a_category_cannot_be_deleted(client: TestClient, team: str) -> None:
    """The invariant the contract states: 409, not a silently empty category.

    The board renders a column per category, so removing the only status of one
    would leave a category that can be assigned but never displayed.
    """
    sign_in(client, OWNER)
    statuses = client.get(f"/api/workspaces/{WORKSPACE}/teams/{team}/statuses").json()["statuses"]
    backlog = next(row for row in statuses if row["category"] == "backlog")

    response = client.delete(f"/api/workspaces/{WORKSPACE}/teams/{team}/statuses/{backlog['id']}")

    assert response.status_code == 409


def test_a_status_is_deletable_once_its_category_has_another(client: TestClient, team: str) -> None:
    """The rule counts siblings, so a second status in the category releases it."""
    sign_in(client, OWNER)
    base = f"/api/workspaces/{WORKSPACE}/teams/{team}/statuses"
    client.post(base, json={"name": "Icebox", "category": "backlog"})
    backlog = next(row for row in client.get(base).json()["statuses"] if row["name"] == "Backlog")

    assert client.delete(f"{base}/{backlog['id']}").status_code == 204


def test_a_member_cannot_change_statuses(client: TestClient, team: str) -> None:
    """Team configuration is team admin work, per the capability table."""
    sign_in(client, MEMBER)
    response = client.post(
        f"/api/workspaces/{WORKSPACE}/teams/{team}/statuses",
        json={"name": "Blocked", "category": "started"},
    )
    assert response.status_code == 403


def test_a_label_round_trips(client: TestClient, team: str) -> None:
    """Create, list, patch and delete, which is the whole label surface."""
    sign_in(client, OWNER)
    base = f"/api/workspaces/{WORKSPACE}/teams/{team}/labels"

    created = client.post(base, json={"name": "bug", "color": "#FF0000"})
    assert created.status_code == 201
    assert created.json()["color"] == "#ff0000"
    label_id = created.json()["id"]

    listed = client.get(base).json()
    assert list(listed) == ["labels"]
    assert [row["id"] for row in listed["labels"]] == [label_id]

    patched = client.patch(f"{base}/{label_id}", json={"name": "defect"})
    assert patched.status_code == 200
    assert patched.json()["name"] == "defect"
    assert patched.json()["color"] == "#ff0000"

    assert client.delete(f"{base}/{label_id}").status_code == 204
    assert client.get(base).json()["labels"] == []


def test_a_bad_label_colour_is_refused(client: TestClient, team: str) -> None:
    """The colour format is held at the edge, so it names the field."""
    sign_in(client, OWNER)
    response = client.post(
        f"/api/workspaces/{WORKSPACE}/teams/{team}/labels",
        json={"name": "bug", "color": "red"},
    )
    assert response.status_code == 422


def test_a_member_reads_labels_but_does_not_write_them(client: TestClient, team: str) -> None:
    """Reading is open to the team's readers; writing is admin work."""
    sign_in(client, MEMBER)
    base = f"/api/workspaces/{WORKSPACE}/teams/{team}/labels"

    assert client.get(base).status_code == 200
    assert client.post(base, json={"name": "bug", "color": "#ff0000"}).status_code == 403


def test_a_guest_in_the_team_reads_its_configuration(client: TestClient, team: str, repositories: Any) -> None:
    """A guest with a membership is a team reader, statuses and labels included."""
    add_team_member(repositories, WORKSPACE, team, GUEST, "member")
    sign_in(client, GUEST)

    assert client.get(f"/api/workspaces/{WORKSPACE}/teams/{team}/statuses").status_code == 200
    assert client.get(f"/api/workspaces/{WORKSPACE}/teams/{team}/labels").status_code == 200
