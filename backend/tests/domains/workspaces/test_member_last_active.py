"""Each member's last active time: stamped by authorization, throttled, and shown to admins only.

Run against real tables in moto, so the conditional update that carries the
throttle is the one DynamoDB evaluates.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Iterator
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.base import utc_now
from app.common.last_active import is_fresh, record_activity
from tests.domains.helpers import (
    ADMIN,
    GUEST,
    MEMBER,
    OWNER,
    add_member,
    make_user,
    make_workspace,
    sign_in,
    sign_out,
)

WORKSPACE = "01JB00000000000000000000WS"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client carrying every domain, so the stamp is tried on more than the workspaces routes."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(list(DOMAINS.values()))
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A workspace with an owner, an admin, a member and a guest who never signs in."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    for user_id, name in ((OWNER, "Olive"), (ADMIN, "Adam"), (MEMBER, "Mo"), (GUEST, "Gus")):
        make_user(repositories, user_id, f"{user_id.lower()}@example.com", name)
    return WORKSPACE


def members_by_id(client: TestClient) -> dict[str, Any]:
    """The members list, keyed by user id."""
    response = client.get(f"/api/workspaces/{WORKSPACE}/members")
    assert response.status_code == 200
    return {row["user_id"]: row for row in response.json()["members"]}


def test_a_request_stamps_the_callers_membership(client: TestClient, repositories: Any, workspace: str) -> None:
    """An authenticated request records when the member was last active."""
    assert repositories.memberships.get(WORKSPACE, MEMBER).last_active_at is None
    sign_in(client, MEMBER)

    assert client.get(f"/api/workspaces/{WORKSPACE}/teams").status_code == 200

    stamped = repositories.memberships.get(WORKSPACE, MEMBER).last_active_at
    assert stamped is not None
    assert utc_now() - stamped < timedelta(minutes=1)


def test_requests_inside_the_interval_do_not_write_again(client: TestClient, repositories: Any, workspace: str) -> None:
    """A fresh stamp is left alone, so a busy member costs one write per interval."""
    sign_in(client, MEMBER)
    client.get(f"/api/workspaces/{WORKSPACE}/teams")
    first = repositories.memberships.get(WORKSPACE, MEMBER).last_active_at

    client.get(f"/api/workspaces/{WORKSPACE}/teams")
    client.get(f"/api/workspaces/{WORKSPACE}/members")

    assert repositories.memberships.get(WORKSPACE, MEMBER).last_active_at == first


def test_the_conditional_update_carries_the_throttle(repositories: Any, workspace: str) -> None:
    """The write lands when unset or stale and refuses inside the interval, with no read first."""
    now = utc_now()
    memberships = repositories.memberships

    assert memberships.touch_last_active(WORKSPACE, MEMBER, now=now) is True
    assert memberships.touch_last_active(WORKSPACE, MEMBER, now=now + timedelta(minutes=5)) is False
    assert memberships.get(WORKSPACE, MEMBER).last_active_at == now
    assert memberships.touch_last_active(WORKSPACE, MEMBER, now=now + timedelta(minutes=16)) is True
    assert memberships.get(WORKSPACE, MEMBER).last_active_at == now + timedelta(minutes=16)


def test_a_stamp_never_creates_a_membership(repositories: Any, workspace: str) -> None:
    """Someone with no membership row gets no row from a stamp."""
    stranger = "01JB000000000000000000STRN"

    assert repositories.memberships.touch_last_active(WORKSPACE, stranger) is False
    assert repositories.memberships.get(WORKSPACE, stranger) is None


def test_an_api_key_on_behalf_of_a_member_stamps_them(client: TestClient, repositories: Any, workspace: str) -> None:
    """A personal key acts as its person, so its use counts as their activity."""
    from webbpulse.identity.api_keys import mint as mint_key

    secret = mint_key(
        user_id=MEMBER,
        tenant_id=WORKSPACE,
        scopes=("members:read",),
        name="Activity key",
        store=repositories.api_keys,
        created_by=MEMBER,
    ).plaintext
    sign_out(client)
    client.headers["authorization"] = f"Bearer {secret}"

    assert client.get(f"/api/workspaces/{WORKSPACE}/members").status_code == 200
    assert repositories.memberships.get(WORKSPACE, MEMBER).last_active_at is not None


def test_an_admin_sees_last_active_and_never_seen_is_null(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """The admin's list carries each stamp, and null for a member never seen."""
    sign_in(client, MEMBER)
    client.get(f"/api/workspaces/{WORKSPACE}/teams")
    sign_in(client, ADMIN)

    rows = members_by_id(client)

    assert rows[MEMBER]["last_active_at"] is not None
    assert rows[ADMIN]["last_active_at"] is not None
    assert rows[GUEST]["last_active_at"] is None


def test_a_member_who_is_not_an_admin_gets_null(client: TestClient, repositories: Any, workspace: str) -> None:
    """Seat usage is admin information, so everyone else reads null for every row."""
    sign_in(client, ADMIN)
    client.get(f"/api/workspaces/{WORKSPACE}/teams")
    sign_in(client, MEMBER)

    rows = members_by_id(client)

    assert repositories.memberships.get(WORKSPACE, ADMIN).last_active_at is not None
    assert all(row["last_active_at"] is None for row in rows.values())


def test_a_read_only_grant_skips_the_write(repositories: Any, workspace: str) -> None:
    """A function that may only read memberships never attempts the stamp."""
    bundle = MagicMock()
    bundle.is_read_only.return_value = True
    membership = repositories.memberships.get(WORKSPACE, MEMBER)

    assert record_activity(bundle, membership) is False
    bundle.memberships.touch_last_active.assert_not_called()


def test_a_failed_stamp_never_fails_the_request(repositories: Any, workspace: str) -> None:
    """Any error from the write is swallowed, because a missed stamp is worth less than the request."""
    bundle = MagicMock()
    bundle.is_read_only.return_value = False
    bundle.memberships.touch_last_active.side_effect = RuntimeError("throttled")
    membership = repositories.memberships.get(WORKSPACE, MEMBER)

    assert record_activity(bundle, membership) is False


def test_a_fresh_stamp_is_decided_in_memory() -> None:
    """Inside the interval nothing is written; past it, or never set, a write is due."""
    now = utc_now()

    assert is_fresh(now - timedelta(minutes=5), now=now)
    assert not is_fresh(now - timedelta(minutes=20), now=now)
    assert not is_fresh(None, now=now)
