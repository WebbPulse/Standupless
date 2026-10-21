"""`PATCH /api/users/me/profile`: the caller's full name and handle, and what a rename keeps."""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.mentions import resolve_mentions
from tests.domains.helpers import MEMBER, OUTSIDER, OWNER, add_member, make_user, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000WKSP1"

OTHER_WORKSPACE = "01JB00000000000000000WKSP2"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the identity application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["identity"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def people(repositories: Any) -> None:
    """The owner and a member sharing one workspace, and an outsider in another."""
    make_user(repositories, OWNER, "owner@example.com", display_name="owner")
    make_user(repositories, MEMBER, "member@example.com", display_name="sam")
    make_user(repositories, OUTSIDER, "outsider@example.com", display_name="taken")
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, MEMBER, "member")
    make_workspace(repositories, OTHER_WORKSPACE, "elsewhere", OUTSIDER)


def test_the_full_name_and_handle_change_together(client: TestClient, repositories: Any, people: None) -> None:
    """Both fields store, and the next read of the profile carries them."""
    sign_in(client, OWNER)
    response = client.patch("/api/users/me/profile", json={"full_name": "  Olive   Owner ", "display_name": "olive"})
    assert response.status_code == 200
    assert response.json()["full_name"] == "Olive Owner"
    assert response.json()["display_name"] == "olive"
    assert client.get("/api/users/me").json()["display_name"] == "olive"
    assert repositories.users.get(OWNER).previous_handles == ["owner"]


def test_a_member_list_shows_the_new_name(client: TestClient, repositories: Any, people: None) -> None:
    """Names are read from the row, so the member list changes with no new sign in."""
    from app.common.api.schemas.workspaces import MemberRead

    sign_in(client, OWNER)
    client.patch("/api/users/me/profile", json={"display_name": "olive", "full_name": "Olive Owner"})
    membership = repositories.memberships.get(WORKSPACE, OWNER)
    read = MemberRead.from_rows(membership, repositories.users.get(OWNER))
    assert read.display_name == "olive"
    assert read.full_name == "Olive Owner"
    assert read.previous_handles == ["owner"]


def test_a_handle_another_member_holds_is_refused(client: TestClient, people: None) -> None:
    """A clash in a shared workspace is a 409 naming the workspace, in any case."""
    sign_in(client, OWNER)
    response = client.patch("/api/users/me/profile", json={"display_name": "SAM"})
    assert response.status_code == 409
    body = response.json()
    assert body["error_code"] == "HANDLE_TAKEN"
    assert body["details"]["workspaces"] == [{"id": WORKSPACE, "name": "Acme"}]


def test_an_email_local_part_counts_as_a_handle(client: TestClient, people: None) -> None:
    """A mention resolves on the email local part too, so that is taken as well."""
    sign_in(client, OWNER)
    assert client.patch("/api/users/me/profile", json={"display_name": "member"}).status_code == 409


def test_a_handle_held_only_outside_the_callers_workspaces_is_free(client: TestClient, people: None) -> None:
    """Uniqueness is per workspace, so a stranger's handle is available."""
    sign_in(client, OWNER)
    assert client.patch("/api/users/me/profile", json={"display_name": "taken"}).status_code == 200


def test_a_handle_someone_gave_up_stays_theirs(client: TestClient, people: None) -> None:
    """Taking a former handle would point old mentions at the wrong person, so it is refused."""
    sign_in(client, MEMBER)
    assert client.patch("/api/users/me/profile", json={"display_name": "samantha"}).status_code == 200
    sign_in(client, OWNER)
    assert client.patch("/api/users/me/profile", json={"display_name": "sam"}).status_code == 409


def test_a_handle_must_take_the_mention_shape(client: TestClient, people: None) -> None:
    """Spaces and punctuation cannot be read back out of a mention."""
    sign_in(client, OWNER)
    for bad in ("two words", "-dash", "dot.name", "x" * 40):
        assert client.patch("/api/users/me/profile", json={"display_name": bad}).status_code == 422


def test_changing_only_the_case_keeps_no_previous_handle(
    client: TestClient, repositories: Any, people: None
) -> None:
    """A case change names the same handle, so nothing is recorded or checked."""
    sign_in(client, OWNER)
    assert client.patch("/api/users/me/profile", json={"display_name": "Owner"}).status_code == 200
    assert repositories.users.get(OWNER).previous_handles == []


def test_a_rename_keeps_old_mentions_resolving(client: TestClient, repositories: Any, people: None) -> None:
    """A mention written under the old handle still names the person after the rename."""
    sign_in(client, MEMBER)
    client.patch("/api/users/me/profile", json={"display_name": "samantha"})
    assert resolve_mentions(repositories, WORKSPACE, ["sam"]) == [MEMBER]
    assert resolve_mentions(repositories, WORKSPACE, ["samantha"]) == [MEMBER]


def test_a_current_handle_beats_a_former_one(client: TestClient, repositories: Any, people: None) -> None:
    """When a former handle and a current one coincide, the current holder is named."""
    repositories.users.update(MEMBER, previous_handles=["owner"])
    assert resolve_mentions(repositories, WORKSPACE, ["owner"]) == [OWNER]


def test_the_profile_needs_a_signed_in_person(client: TestClient) -> None:
    """No claims is a 401."""
    assert client.patch("/api/users/me/profile", json={"full_name": "x"}).status_code == 401
