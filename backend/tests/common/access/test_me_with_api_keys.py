"""`GET /api/users/me` and `assignee_id: "me"` presented with an API key instead of a session.

A personal key names the person who minted it, which is how a command line
client learns who `me` is. A workspace key acts as the workspace, so it has no
person to name and both surfaces refuse it explicitly rather than answering
with the key's synthetic principal.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.common.access.test_key_creator_liveness import (
    TEAM,
    WORKSPACE,
    as_key,
    as_person,
    mint_through_route,
    remove,
)
from tests.domains.helpers import (
    ADMIN,
    MEMBER,
    OWNER,
    add_member,
    add_team_member,
    make_team,
    make_user,
    make_workspace,
)


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client carrying every domain, so minting and the account route share one app."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(list(DOMAINS.values()))
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A workspace with an owner, an admin and a member, and one team."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    make_user(repositories, OWNER, "owner@example.com", "Olive Owner")
    make_user(repositories, ADMIN, "admin@example.com", "Adam Admin")
    make_user(repositories, MEMBER, "member@example.com", "Mo Member")
    make_team(repositories, WORKSPACE, TEAM, "ABC")
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "member")
    return WORKSPACE


def test_a_personal_key_reads_its_own_person(client: TestClient, workspace: str) -> None:
    """The key's minter comes back in the same shape a session reads."""
    secret = mint_through_route(client, MEMBER, "user")
    as_key(client, secret)

    response = client.get("/api/users/me")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["id"] == MEMBER
    assert body["email"] == "member@example.com"


def test_a_workspace_key_has_no_person(client: TestClient, workspace: str) -> None:
    """A workspace key is a 403 with a code a client can branch on."""
    secret = mint_through_route(client, ADMIN, "workspace")
    as_key(client, secret)

    response = client.get("/api/users/me")

    assert response.status_code == 403, response.text
    assert response.json()["error_code"] == "WORKSPACE_KEY_HAS_NO_USER"


def test_a_personal_key_stops_naming_a_removed_person(client: TestClient, workspace: str) -> None:
    """Removing the minter from the key's workspace closes the account route too."""
    secret = mint_through_route(client, MEMBER, "user")
    remove(client, MEMBER)
    as_key(client, secret)

    response = client.get("/api/users/me")

    assert response.status_code == 401, response.text


def test_an_unknown_key_is_unauthenticated(client: TestClient, workspace: str) -> None:
    """A bearer shaped like a key that verifies against nothing is a 401."""
    secret = mint_through_route(client, MEMBER, "user")
    as_key(client, secret[:-4] + "0000")

    assert client.get("/api/users/me").status_code == 401


def test_a_key_may_not_change_preferences(client: TestClient, workspace: str) -> None:
    """Reading the account is all a key does on it; preferences stay a person's."""
    secret = mint_through_route(client, MEMBER, "user")
    as_key(client, secret)

    response = client.patch("/api/users/me/preferences", json={"email_notifications": False})

    assert response.status_code == 403, response.text
    assert response.json()["error_code"] == "API_KEY_ACTOR_REFUSED"


def test_a_personal_key_creates_an_issue_assigned_to_me(client: TestClient, workspace: str) -> None:
    """`me` on create resolves to the key's person."""
    secret = mint_through_route(client, MEMBER, "user")
    as_key(client, secret)

    response = client.post(
        f"/api/workspaces/{WORKSPACE}/issues", json={"team_id": TEAM, "title": "Mine", "assignee_id": "me"}
    )

    assert response.status_code == 201, response.text
    assert response.json()["assignee_id"] == MEMBER


def test_a_workspace_key_cannot_assign_me(client: TestClient, workspace: str) -> None:
    """`me` names nobody for a workspace key, so create and patch both refuse it with a 422."""
    as_person(client, OWNER)
    seeded = client.post(f"/api/workspaces/{WORKSPACE}/issues", json={"team_id": TEAM, "title": "Seeded"})
    assert seeded.status_code == 201, seeded.text

    secret = mint_through_route(client, ADMIN, "workspace")
    as_key(client, secret)

    created = client.post(
        f"/api/workspaces/{WORKSPACE}/issues", json={"team_id": TEAM, "title": "Nobody", "assignee_id": "me"}
    )
    assert created.status_code == 422, created.text

    patched = client.patch(f"/api/workspaces/{WORKSPACE}/issues/{seeded.json()['id']}", json={"assignee_id": "me"})
    assert patched.status_code == 422, patched.text
