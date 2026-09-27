"""A key acts with its scopes and its creator's current role, read on every request.

The owner decided this in design section 2: demoting or removing the person who
minted a key closes the access that role gave it on the very next request, with
nobody having to revoke anything. These tests drive that end to end through the
merged application: the key is minted and used over REST, and the creator is
demoted or removed over the same member routes an admin would use, with no cache
or token lifetime between the two.

Both key kinds are covered. A user key acts as its creator, so a demotion to guest
shrinks it to the guest's teams and a removal closes it. A workspace key acts as
the service principal, so what it hangs on is its creator still being an owner or
admin, which is the role minting one needs.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import (
    ADMIN,
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

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

OTHER_TEAM = "01JB000000000000000000PRJ2"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client carrying every domain, so minting, membership and issues share one app."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(list(DOMAINS.values()))
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A workspace with an owner, an admin, a member in one of two teams, and an issue in each."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    make_user(repositories, OWNER, "owner@example.com", "Olive Owner")
    make_user(repositories, ADMIN, "admin@example.com", "Adam Admin")
    make_user(repositories, MEMBER, "member@example.com", "Mo Member")
    make_team(repositories, WORKSPACE, TEAM, "ABC")
    make_team(repositories, WORKSPACE, OTHER_TEAM, "XYZ")
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "member")
    return WORKSPACE


def as_person(client: TestClient, subject: str) -> None:
    """Make later requests arrive as a signed in person, with no key presented."""
    client.headers.pop("authorization", None)
    sign_in(client, subject)


def as_key(client: TestClient, secret: str) -> None:
    """Make later requests arrive as an API key alone, with no session beside it."""
    sign_out(client)
    client.headers["authorization"] = f"Bearer {secret}"


def mint_through_route(client: TestClient, creator: str, kind: str) -> str:
    """Mint a key over REST as `creator` and return the one plaintext copy."""
    as_person(client, creator)
    response = client.post(
        f"/api/workspaces/{WORKSPACE}/api-keys",
        json={"name": "A key", "scopes": ["issues:read", "issues:write"], "kind": kind},
    )
    assert response.status_code == 201, response.text
    return str(response.json()["secret"])


def seed_issue(client: TestClient, team_id: str) -> str:
    """One issue in `team_id`, created by the owner over a session."""
    as_person(client, OWNER)
    response = client.post(f"/api/workspaces/{WORKSPACE}/issues", json={"team_id": team_id, "title": "An issue"})
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


def set_role(client: TestClient, subject: str, role: str) -> None:
    """Change a member's workspace role as the owner, over the member route."""
    as_person(client, OWNER)
    response = client.patch(f"/api/workspaces/{WORKSPACE}/members/{subject}", json={"role": role})
    assert response.status_code == 200, response.text


def remove(client: TestClient, subject: str) -> None:
    """Remove a member as the owner, over the member route."""
    as_person(client, OWNER)
    response = client.delete(f"/api/workspaces/{WORKSPACE}/members/{subject}")
    assert response.status_code == 204, response.text


def read_issue(client: TestClient, secret: str, issue_id: str) -> int:
    """The status one key gets reading one issue."""
    as_key(client, secret)
    return client.get(f"/api/workspaces/{WORKSPACE}/issues/{issue_id}").status_code


def test_demoting_a_user_keys_creator_to_guest_narrows_it_to_their_teams(client: TestClient, workspace: str) -> None:
    """A member's key reaches both teams, then only the granted one once they are a guest."""
    inside = seed_issue(client, TEAM)
    outside = seed_issue(client, OTHER_TEAM)
    secret = mint_through_route(client, MEMBER, "user")
    assert read_issue(client, secret, inside) == 200
    assert read_issue(client, secret, outside) == 200

    set_role(client, MEMBER, "guest")

    assert read_issue(client, secret, inside) == 200
    assert read_issue(client, secret, outside) == 404
    as_key(client, secret)
    created = client.post(f"/api/workspaces/{WORKSPACE}/issues", json={"team_id": OTHER_TEAM, "title": "Nope"})
    assert created.status_code == 404, created.text


def test_removing_a_user_keys_creator_closes_the_key(client: TestClient, workspace: str) -> None:
    """The key stops on the next request after its creator leaves the workspace."""
    issue = seed_issue(client, TEAM)
    secret = mint_through_route(client, MEMBER, "user")
    assert read_issue(client, secret, issue) == 200

    remove(client, MEMBER)

    assert read_issue(client, secret, issue) == 404


def test_a_workspace_key_works_while_its_creator_is_an_admin(client: TestClient, workspace: str) -> None:
    """The baseline the next two tests take away."""
    issue = seed_issue(client, TEAM)
    secret = mint_through_route(client, ADMIN, "workspace")

    assert read_issue(client, secret, issue) == 200


def test_demoting_a_workspace_keys_creator_closes_the_key(client: TestClient, workspace: str) -> None:
    """An admin demoted to member no longer holds the role a workspace key needs.

    Restoring the role restores the key, which shows the decision is read live on
    each request rather than written once into the key.
    """
    issue = seed_issue(client, TEAM)
    secret = mint_through_route(client, ADMIN, "workspace")
    assert read_issue(client, secret, issue) == 200

    set_role(client, ADMIN, "member")
    assert read_issue(client, secret, issue) == 404

    set_role(client, ADMIN, "admin")
    assert read_issue(client, secret, issue) == 200


def test_removing_a_workspace_keys_creator_closes_the_key(client: TestClient, workspace: str) -> None:
    """A workspace key does not outlive the admin who minted it."""
    issue = seed_issue(client, TEAM)
    secret = mint_through_route(client, ADMIN, "workspace")
    assert read_issue(client, secret, issue) == 200

    remove(client, ADMIN)

    assert read_issue(client, secret, issue) == 404
