"""`GET /api/users/me`, the route the frontend's auth shell boots from."""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.inbox import NOTIFICATION_KINDS
from tests.domains.helpers import OWNER, make_user, sign_in, sign_in_through_gate

ALL_ON = {"in_app": True, "email": True}


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the identity application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["identity"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


def test_an_anonymous_caller_is_refused(client: TestClient) -> None:
    """No claims at all is a 401, never an empty profile."""
    response = client.get("/api/users/me")
    assert response.status_code == 401
    assert response.json()["error_code"] == "NOT_AUTHENTICATED"


def test_the_caller_reads_their_own_row(client: TestClient, repositories: Any) -> None:
    """The body carries exactly the fields the frontend's `UserRead` declares."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)
    response = client.get("/api/users/me")
    assert response.status_code == 200
    assert response.json() == {
        "id": OWNER,
        "email": "owner@example.com",
        "display_name": "Owner",
        "email_verified": False,
        "email_notifications": True,
        "notification_preferences": {kind: ALL_ON for kind in NOTIFICATION_KINDS},
    }


def test_email_notifications_default_on_and_can_be_turned_off(client: TestClient, repositories: Any) -> None:
    """The switch defaults to on and the profile route is what turns it off."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    assert client.get("/api/users/me").json()["email_notifications"] is True

    response = client.patch("/api/users/me/preferences", json={"email_notifications": False})
    assert response.status_code == 200
    assert response.json()["email_notifications"] is False

    assert repositories.users.get(OWNER).email_notifications is False
    assert client.get("/api/users/me").json()["email_notifications"] is False


def test_one_kind_can_be_turned_off_per_channel(client: TestClient, repositories: Any) -> None:
    """A partial patch changes the named channel of the named kind and nothing else."""
    make_user(repositories, OWNER, "owner@example.com", display_name="Owner")
    sign_in(client, OWNER)

    response = client.patch(
        "/api/users/me/preferences",
        json={"notification_preferences": {"commented": {"email": False}}},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["notification_preferences"]["commented"] == {"in_app": True, "email": False}
    assert body["notification_preferences"]["mentioned"] == ALL_ON
    assert body["email_notifications"] is True

    client.patch(
        "/api/users/me/preferences",
        json={"notification_preferences": {"commented": {"in_app": False}}},
    )
    stored = repositories.users.get(OWNER)
    assert stored.notification_preferences == {"commented": {"email": False, "in_app": False}}
    assert stored.wants_notification("commented", "email") is False
    assert stored.wants_notification("assigned", "email") is True


def test_turning_a_channel_back_on_keeps_the_row_sparse(client: TestClient, repositories: Any) -> None:
    """A switch turned back on is removed rather than stored, so defaults stay on."""
    make_user(repositories, OWNER, "owner@example.com")
    sign_in(client, OWNER)

    client.patch("/api/users/me/preferences", json={"notification_preferences": {"assigned": {"email": False}}})
    client.patch("/api/users/me/preferences", json={"notification_preferences": {"assigned": {"email": True}}})

    assert repositories.users.get(OWNER).notification_preferences == {}


def test_the_global_email_switch_overrides_every_kind(client: TestClient, repositories: Any) -> None:
    """With email off for the account, no kind wants email whatever its own switch says."""
    make_user(repositories, OWNER, "owner@example.com")
    sign_in(client, OWNER)

    client.patch("/api/users/me/preferences", json={"email_notifications": False})

    stored = repositories.users.get(OWNER)
    assert stored.wants_notification("mentioned", "email") is False
    assert stored.wants_notification("mentioned", "in_app") is True


def test_an_unknown_kind_is_refused(client: TestClient, repositories: Any) -> None:
    """Preferences are only accepted for kinds the inbox actually sends."""
    make_user(repositories, OWNER, "owner@example.com")
    sign_in(client, OWNER)

    response = client.patch(
        "/api/users/me/preferences",
        json={"notification_preferences": {"digest": {"email": False}}},
    )
    assert response.status_code == 422


def test_changing_preferences_needs_a_signed_in_caller(client: TestClient) -> None:
    """The preference is on the caller's own row, so anonymous is a 401."""
    response = client.patch("/api/users/me/preferences", json={"email_notifications": False})
    assert response.status_code == 401


def test_the_staging_gate_shape_reads_the_same_row(client: TestClient, repositories: Any) -> None:
    """Claims arriving under `authorizer.lambda` name the same caller."""
    make_user(repositories, OWNER, "owner@example.com")
    sign_in_through_gate(client, OWNER)
    response = client.get("/api/users/me")
    assert response.status_code == 200
    assert response.json()["id"] == OWNER


def test_a_token_without_a_row_is_not_found(client: TestClient) -> None:
    """A verified subject whose row is gone is a 404, so the session survives."""
    sign_in(client, OWNER)
    response = client.get("/api/users/me")
    assert response.status_code == 404
    assert response.json()["error_code"] == "NOT_FOUND"
