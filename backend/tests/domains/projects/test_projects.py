"""The project routes, against real tables in moto.

These cover the contract's project routes and the guest invariant design section
2 names: a guest 404s on a project they hold no membership in, and never sees it
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
    add_project_member,
    make_project,
    make_workspace,
    sign_in,
)

WORKSPACE = "01JB00000000000000000000WS"

PROJECT = "01JB000000000000000000PRJ1"

OTHER_PROJECT = "01JB000000000000000000PRJ2"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the projects application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["projects"])
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
    assert client.get(f"/api/workspaces/{workspace}/projects").status_code == 401


def test_a_non_member_gets_404(client: TestClient, workspace: str) -> None:
    """Someone outside the workspace cannot tell whether it holds projects."""
    sign_in(client, OUTSIDER)
    assert client.get(f"/api/workspaces/{workspace}/projects").status_code == 404


def test_a_member_creates_a_project_and_becomes_its_admin(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Creating seeds the default statuses and an admin membership for the creator."""
    sign_in(client, MEMBER)
    response = client.post(f"/api/workspaces/{workspace}/projects", json={"name": "Apollo", "key_prefix": "APO"})

    assert response.status_code == 201
    body = response.json()
    assert body["key_prefix"] == "APO"
    assert body["estimate_scale"] == "off"
    assert body["role"] == "admin"

    membership = repositories.memberships.get_project_membership(workspace, body["id"], MEMBER)
    assert membership is not None
    assert membership.role == "admin"


def test_creating_seeds_the_five_default_statuses(client: TestClient, workspace: str) -> None:
    """The seed the contract fixes, in the order and categories it names."""
    sign_in(client, MEMBER)
    project_id = client.post(
        f"/api/workspaces/{workspace}/projects", json={"name": "Apollo", "key_prefix": "APO"}
    ).json()["id"]

    statuses = client.get(f"/api/workspaces/{workspace}/projects/{project_id}/statuses").json()["statuses"]

    assert [(row["name"], row["category"], row["position"]) for row in statuses] == [
        ("Backlog", "backlog", 0),
        ("Todo", "unstarted", 1),
        ("In Progress", "started", 2),
        ("Done", "completed", 3),
        ("Cancelled", "cancelled", 4),
    ]


def test_a_guest_cannot_create_a_project(client: TestClient, workspace: str) -> None:
    """Project creation is closed to guests, per the capability table."""
    sign_in(client, GUEST)
    response = client.post(f"/api/workspaces/{workspace}/projects", json={"name": "Apollo", "key_prefix": "APO"})
    assert response.status_code == 403


def test_a_duplicate_key_prefix_is_a_conflict(client: TestClient, workspace: str) -> None:
    """Prefix uniqueness per workspace is the conditional write, surfaced as 409."""
    sign_in(client, MEMBER)
    client.post(f"/api/workspaces/{workspace}/projects", json={"name": "Apollo", "key_prefix": "APO"})
    response = client.post(f"/api/workspaces/{workspace}/projects", json={"name": "Other", "key_prefix": "APO"})

    assert response.status_code == 409


def test_the_same_prefix_is_free_in_another_workspace(client: TestClient, workspace: str, repositories: Any) -> None:
    """The uniqueness index is workspace scoped, so two tenants never collide."""
    other = "01JB0000000000000000000WS2"
    make_workspace(repositories, other, "other", MEMBER)
    sign_in(client, MEMBER)

    first = client.post(f"/api/workspaces/{workspace}/projects", json={"name": "Apollo", "key_prefix": "APO"})
    second = client.post(f"/api/workspaces/{other}/projects", json={"name": "Apollo", "key_prefix": "APO"})

    assert first.status_code == 201
    assert second.status_code == 201


def test_a_bad_key_prefix_is_rejected_before_the_table(client: TestClient, workspace: str) -> None:
    """The alphabet is held at the edge, so a bad prefix names the field."""
    sign_in(client, MEMBER)
    response = client.post(f"/api/workspaces/{workspace}/projects", json={"name": "Apollo", "key_prefix": "lower"})
    assert response.status_code == 422


def test_a_guest_404s_on_a_project_they_are_not_in(client: TestClient, workspace: str, repositories: Any) -> None:
    """The invariant design section 2 names explicitly.

    A 403 would confirm the project exists, so a guest outside it gets the same
    404 a non-member gets on the workspace.
    """
    make_project(repositories, workspace, PROJECT, "APO")
    sign_in(client, GUEST)

    assert client.get(f"/api/workspaces/{workspace}/projects/{PROJECT}").status_code == 404
    assert client.get(f"/api/workspaces/{workspace}/projects/{PROJECT}/statuses").status_code == 404
    assert client.get(f"/api/workspaces/{workspace}/projects/{PROJECT}/labels").status_code == 404


def test_a_guest_reaches_a_project_they_are_in(client: TestClient, workspace: str, repositories: Any) -> None:
    """A project membership is what widens a guest, and nothing else does."""
    make_project(repositories, workspace, PROJECT, "APO")
    add_project_member(repositories, workspace, PROJECT, GUEST, "member")
    sign_in(client, GUEST)

    response = client.get(f"/api/workspaces/{workspace}/projects/{PROJECT}")

    assert response.status_code == 200
    assert response.json()["role"] == "member"


def test_a_guest_lists_only_the_projects_they_are_in(client: TestClient, workspace: str, repositories: Any) -> None:
    """The list applies the same rule the single read does, not a looser one."""
    make_project(repositories, workspace, PROJECT, "APO")
    make_project(repositories, workspace, OTHER_PROJECT, "BET")
    add_project_member(repositories, workspace, PROJECT, GUEST, "member")
    sign_in(client, GUEST)

    body = client.get(f"/api/workspaces/{workspace}/projects").json()

    assert [row["id"] for row in body["projects"]] == [PROJECT]


def test_a_member_sees_every_project_in_the_workspace(client: TestClient, workspace: str, repositories: Any) -> None:
    """Only a guest is narrowed; a member reads the whole workspace."""
    make_project(repositories, workspace, PROJECT, "APO")
    make_project(repositories, workspace, OTHER_PROJECT, "BET")
    sign_in(client, MEMBER)

    body = client.get(f"/api/workspaces/{workspace}/projects").json()

    assert {row["id"] for row in body["projects"]} == {PROJECT, OTHER_PROJECT}
    assert {row["role"] for row in body["projects"]} == {"member"}


def test_the_list_body_is_an_envelope(client: TestClient, workspace: str) -> None:
    """The plural key envelope the contract fixes, with nowhere for a bare array."""
    sign_in(client, MEMBER)
    body = client.get(f"/api/workspaces/{workspace}/projects").json()
    assert list(body) == ["projects"]


def test_a_project_carries_the_fields_the_frontend_reads(client: TestClient, workspace: str, repositories: Any) -> None:
    """The field set, and `next_issue_number` asserted absent."""
    make_project(repositories, workspace, PROJECT, "APO")
    sign_in(client, OWNER)

    row = client.get(f"/api/workspaces/{workspace}/projects/{PROJECT}").json()

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


def test_a_workspace_admin_implies_project_admin(client: TestClient, workspace: str, repositories: Any) -> None:
    """An admin administers every project without an explicit membership."""
    make_project(repositories, workspace, PROJECT, "APO")
    sign_in(client, ADMIN)

    response = client.patch(f"/api/workspaces/{workspace}/projects/{PROJECT}", json={"name": "Renamed"})

    assert response.status_code == 200
    assert response.json()["name"] == "Renamed"
    assert response.json()["role"] == "admin"


def test_a_plain_member_cannot_administer_a_project(client: TestClient, workspace: str, repositories: Any) -> None:
    """A member reads a project but does not configure one they do not admin."""
    make_project(repositories, workspace, PROJECT, "APO")
    sign_in(client, MEMBER)

    assert client.get(f"/api/workspaces/{workspace}/projects/{PROJECT}").status_code == 200
    assert client.patch(f"/api/workspaces/{workspace}/projects/{PROJECT}", json={"name": "x"}).status_code == 403


def test_a_project_member_with_admin_may_administer_it(client: TestClient, workspace: str, repositories: Any) -> None:
    """The project membership promotes a member for that project alone."""
    make_project(repositories, workspace, PROJECT, "APO")
    make_project(repositories, workspace, OTHER_PROJECT, "BET")
    add_project_member(repositories, workspace, PROJECT, MEMBER, "admin")
    sign_in(client, MEMBER)

    assert client.patch(f"/api/workspaces/{workspace}/projects/{PROJECT}", json={"name": "x"}).status_code == 200
    assert client.patch(f"/api/workspaces/{workspace}/projects/{OTHER_PROJECT}", json={"name": "x"}).status_code == 403


def test_only_a_workspace_admin_deletes_a_project(client: TestClient, workspace: str, repositories: Any) -> None:
    """Deleting is workspace admin work, not something a project admin may do."""
    make_project(repositories, workspace, PROJECT, "APO")
    add_project_member(repositories, workspace, PROJECT, MEMBER, "admin")
    sign_in(client, MEMBER)
    assert client.delete(f"/api/workspaces/{workspace}/projects/{PROJECT}").status_code == 403

    sign_in(client, ADMIN)
    assert client.delete(f"/api/workspaces/{workspace}/projects/{PROJECT}").status_code == 204
    assert repositories.projects.get(workspace, PROJECT) is None


def test_deleting_a_project_takes_its_configuration_with_it(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Statuses would otherwise outlive the project and be unreachable forever."""
    make_project(repositories, workspace, PROJECT, "APO")
    sign_in(client, OWNER)

    client.delete(f"/api/workspaces/{workspace}/projects/{PROJECT}")

    assert repositories.project_config.list_statuses(workspace, PROJECT) == []
