"""The workspaces routes, against real tables in moto.

These cover the contract's workspace, member and invite routes plus the tenancy
invariants design section 2 lists: a non-member gets 404 rather than 403, and the
last owner can neither leave nor be demoted.
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
    make_user,
    make_workspace,
    sign_in,
)

WORKSPACE = "01JB00000000000000000000WS"

OTHER_WORKSPACE = "01JB0000000000000000000WS2"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the workspaces application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["workspaces"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


def test_health_reads_nothing(client: TestClient) -> None:
    """The domain probe answers without touching a table."""
    response = client.get("/api/workspaces/health")
    assert response.status_code == 200
    assert response.json()["domain"] == "workspaces"


def test_an_anonymous_caller_is_refused(client: TestClient) -> None:
    """No claims means 401, not an empty list: the route fails closed."""
    response = client.get("/api/workspaces")
    assert response.status_code == 401
    assert response.json()["error_code"] == "NOT_AUTHENTICATED"


def test_a_new_account_sees_an_empty_list(client: TestClient) -> None:
    """A caller in no workspace gets the envelope with an empty list, not a 404."""
    sign_in(client, OWNER)
    response = client.get("/api/workspaces")
    assert response.status_code == 200
    assert response.json() == {"workspaces": []}


def test_the_list_body_is_an_envelope_not_a_bare_array(client: TestClient) -> None:
    """The envelope is the contract the frontend reads, so it is pinned here."""
    sign_in(client, OWNER)
    body = client.get("/api/workspaces").json()
    assert isinstance(body, dict)
    assert list(body) == ["workspaces"]


def test_a_caller_sees_every_workspace_they_belong_to(client: TestClient, repositories: Any) -> None:
    """Membership, not ownership, is what puts a workspace in the list.

    The member is not the owner of either row, so an owner-based read would
    answer nothing and this is what catches that regression.
    """
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    make_workspace(repositories, OTHER_WORKSPACE, "theirs", OWNER)
    add_member(repositories, WORKSPACE, MEMBER, "member")
    sign_in(client, MEMBER)

    body = client.get("/api/workspaces").json()

    assert [row["id"] for row in body["workspaces"]] == [WORKSPACE]
    assert body["workspaces"][0]["role"] == "member"


def test_a_workspace_carries_the_fields_the_frontend_reads(client: TestClient, repositories: Any) -> None:
    """One row's field set, which the frontend `Workspace` type mirrors."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    sign_in(client, OWNER)

    row = client.get("/api/workspaces").json()["workspaces"][0]

    assert set(row) == {"id", "name", "slug", "plan", "created_at", "role"}
    assert row["id"] == WORKSPACE
    assert row["plan"] == "free"
    assert row["role"] == "owner"


def test_creating_a_workspace_makes_the_caller_its_owner(client: TestClient, repositories: Any) -> None:
    """A created workspace is immediately readable by its creator."""
    sign_in(client, OWNER)
    response = client.post("/api/workspaces", json={"name": "Acme", "slug": "acme"})

    assert response.status_code == 201
    assert response.json()["role"] == "owner"
    created = response.json()["id"]
    assert repositories.memberships.get(created, OWNER).role == "owner"


def test_a_duplicate_slug_is_a_conflict(client: TestClient) -> None:
    """Slug uniqueness is enforced by the conditional write, surfaced as 409."""
    sign_in(client, OWNER)
    client.post("/api/workspaces", json={"name": "Acme", "slug": "acme"})
    response = client.post("/api/workspaces", json={"name": "Other", "slug": "acme"})

    assert response.status_code == 409


def test_a_bad_slug_is_rejected_before_the_table(client: TestClient) -> None:
    """The alphabet is held at the edge, so a bad slug names the field."""
    sign_in(client, OWNER)
    response = client.post("/api/workspaces", json={"name": "Acme", "slug": "Not A Slug"})
    assert response.status_code == 422


def test_a_non_member_gets_404_not_403(client: TestClient, repositories: Any) -> None:
    """The invariant: a caller outside a workspace cannot probe for its existence.

    A 403 would confirm the workspace is real, so every route inside it answers
    404 to someone who is not a member.
    """
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    sign_in(client, OUTSIDER)

    assert client.get(f"/api/workspaces/{WORKSPACE}").status_code == 404
    assert client.get(f"/api/workspaces/{WORKSPACE}/members").status_code == 404
    assert client.patch(f"/api/workspaces/{WORKSPACE}", json={"name": "x"}).status_code == 404


def test_a_member_cannot_rename_a_workspace(client: TestClient, repositories: Any) -> None:
    """Renaming is admin work, so a plain member is refused rather than 404."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    add_member(repositories, WORKSPACE, MEMBER, "member")
    sign_in(client, MEMBER)

    assert client.patch(f"/api/workspaces/{WORKSPACE}", json={"name": "x"}).status_code == 403


def test_an_admin_renames_but_only_an_owner_deletes(client: TestClient, repositories: Any) -> None:
    """The capability split the contract states, asserted from one caller."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    sign_in(client, ADMIN)

    assert client.patch(f"/api/workspaces/{WORKSPACE}", json={"name": "New"}).status_code == 200
    assert client.delete(f"/api/workspaces/{WORKSPACE}").status_code == 403


def test_members_are_listed_with_their_user_rows(client: TestClient, repositories: Any) -> None:
    """A member list joins the membership with the user row for display."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    make_user(repositories, OWNER, "owner@example.com", "Ada")
    sign_in(client, OWNER)

    members = client.get(f"/api/workspaces/{WORKSPACE}/members").json()["members"]

    assert len(members) == 1
    assert members[0]["user_id"] == OWNER
    assert members[0]["email"] == "owner@example.com"
    assert members[0]["display_name"] == "Ada"
    assert members[0]["role"] == "owner"


def test_only_an_owner_may_grant_ownership(client: TestClient, repositories: Any) -> None:
    """An admin manages members but cannot make one an owner."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    sign_in(client, ADMIN)

    response = client.patch(f"/api/workspaces/{WORKSPACE}/members/{MEMBER}", json={"role": "owner"})

    assert response.status_code == 403


def test_the_last_owner_cannot_be_demoted(client: TestClient, repositories: Any) -> None:
    """A workspace with no owner could never be deleted or transferred again."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    sign_in(client, OWNER)

    response = client.patch(f"/api/workspaces/{WORKSPACE}/members/{OWNER}", json={"role": "admin"})

    assert response.status_code == 409


def test_the_last_owner_cannot_leave(client: TestClient, repositories: Any) -> None:
    """The invariant design section 2 names, asserted on the delete path too."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    sign_in(client, OWNER)

    response = client.delete(f"/api/workspaces/{WORKSPACE}/members/{OWNER}")

    assert response.status_code == 409
    assert repositories.memberships.get(WORKSPACE, OWNER) is not None


def test_an_owner_may_leave_once_another_owner_exists(client: TestClient, repositories: Any) -> None:
    """The last-owner rule counts owners, so a second one releases the first."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "owner")
    sign_in(client, OWNER)

    assert client.delete(f"/api/workspaces/{WORKSPACE}/members/{OWNER}").status_code == 204
    assert repositories.memberships.get(WORKSPACE, OWNER) is None


def test_a_member_may_leave_but_not_remove_someone_else(client: TestClient, repositories: Any) -> None:
    """Leaving is a member's own right; removing another is admin work."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    sign_in(client, MEMBER)

    assert client.delete(f"/api/workspaces/{WORKSPACE}/members/{GUEST}").status_code == 403
    assert client.delete(f"/api/workspaces/{WORKSPACE}/members/{MEMBER}").status_code == 204


def test_an_invite_returns_its_token_exactly_once(client: TestClient, repositories: Any) -> None:
    """The create response is the only readable form of the token.

    Only the hash is stored, so the list route must never carry one back.
    """
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    sign_in(client, OWNER)

    created = client.post(
        f"/api/workspaces/{WORKSPACE}/invites",
        json={"email": "new@example.com", "role": "member"},
    )
    assert created.status_code == 201
    assert created.json()["token"]

    listed = client.get(f"/api/workspaces/{WORKSPACE}/invites").json()["invites"]
    assert len(listed) == 1
    assert "token" not in listed[0]


def test_an_invite_cannot_grant_ownership(client: TestClient, repositories: Any) -> None:
    """Ownership is granted to an existing member, never to an email address."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    sign_in(client, OWNER)

    response = client.post(
        f"/api/workspaces/{WORKSPACE}/invites",
        json={"email": "new@example.com", "role": "owner"},
    )

    assert response.status_code == 422


def test_a_member_cannot_read_or_create_invites(client: TestClient, repositories: Any) -> None:
    """Invites are admin work, so a member is refused both ways."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    add_member(repositories, WORKSPACE, MEMBER, "member")
    sign_in(client, MEMBER)

    assert client.get(f"/api/workspaces/{WORKSPACE}/invites").status_code == 403
    assert (
        client.post(
            f"/api/workspaces/{WORKSPACE}/invites",
            json={"email": "x@example.com", "role": "member"},
        ).status_code
        == 403
    )


def test_accepting_an_invite_creates_the_membership(client: TestClient, repositories: Any) -> None:
    """The token turns into a membership carrying the invited role."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    sign_in(client, OWNER)
    token = client.post(
        f"/api/workspaces/{WORKSPACE}/invites",
        json={"email": "new@example.com", "role": "guest"},
    ).json()["token"]

    sign_in(client, OUTSIDER)
    response = client.post("/api/invites/accept", json={"token": token})

    assert response.status_code == 201
    assert response.json()["role"] == "guest"
    assert repositories.memberships.get(WORKSPACE, OUTSIDER).role == "guest"


def test_accepting_twice_is_idempotent_for_an_existing_member(client: TestClient, repositories: Any) -> None:
    """A second accept answers the existing membership rather than failing.

    The contract calls the route idempotent for an existing member, so a client
    retrying a request never sees an error it cannot act on.
    """
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    add_member(repositories, WORKSPACE, MEMBER, "member")
    sign_in(client, OWNER)
    token = client.post(
        f"/api/workspaces/{WORKSPACE}/invites",
        json={"email": "member@example.com", "role": "guest"},
    ).json()["token"]

    sign_in(client, MEMBER)
    response = client.post("/api/invites/accept", json={"token": token})

    assert response.status_code == 201
    assert response.json()["role"] == "member"


def test_an_unknown_token_is_refused(client: TestClient) -> None:
    """An unknown and an expired token answer alike, so neither can be probed."""
    sign_in(client, OUTSIDER)
    response = client.post("/api/invites/accept", json={"token": "not-a-real-token"})

    assert response.status_code == 400
    assert response.json()["error_code"] == "INVALID_INVITE"


def test_accepting_an_invite_needs_a_signed_in_caller(client: TestClient) -> None:
    """The route has no workspace in its path, so it still fails closed."""
    response = client.post("/api/invites/accept", json={"token": "anything"})
    assert response.status_code == 401
