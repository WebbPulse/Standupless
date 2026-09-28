"""Deleting an account through the identity routes.

The sole owner rule is the one that matters most: an account cannot leave a
workspace other people still use with nobody to own it. Once the rule passes, the
account is deleted at once: it can no longer sign in or use a token issued
earlier, its credentials are revoked, and its purge is requested straight away.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.identity import AuthenticationRefused

from app.common import team_purge
from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.domains.identity import account_revocation
from app.domains.identity.identity_hooks import StanduplessIdentityHooks
from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_member, make_user, make_workspace, sign_in

SHARED = "01JB00000000000000000000WS"

SOLO = "01JB0000000000000000000WS2"

ELSEWHERE = "01JB0000000000000000000WS3"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the identity application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["identity"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def recorder() -> Iterator[Any]:
    """A recording sender installed as the process-wide one for one test."""
    from webbpulse.identity.email import RecordingEmailSender

    from app.common.email import reset_email_sender

    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


@pytest.fixture
def purges(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Every account purge the route requests, captured rather than sent."""
    requested: list[str] = []

    def fake_request(user_id: str) -> bool:
        """Record the request and report it sent."""
        requested.append(user_id)
        return True

    monkeypatch.setattr(team_purge, "request_account_purge", fake_request)
    return requested


@pytest.fixture
def revocations(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Every user whose refresh families and connected apps the route revoked."""
    revoked: list[str] = []

    def fake_refresh(user_id: str) -> int:
        """Record the refresh revocation."""
        revoked.append(user_id)
        return 2

    monkeypatch.setattr(account_revocation, "_revoke_refresh_families", fake_refresh)
    monkeypatch.setattr(account_revocation, "_revoke_connected_apps", lambda user_id: 0)
    return revoked


@pytest.fixture
def seeded(repositories: Any) -> Any:
    """The owner owns a shared workspace alone, owns a solo one, and is a member of a third."""
    make_user(repositories, OWNER, "owner@example.com", "Olive")
    make_user(repositories, MEMBER, "member@example.com", "Max")
    make_workspace(repositories, SHARED, "shared", OWNER)
    add_member(repositories, SHARED, MEMBER, "member")
    make_workspace(repositories, SOLO, "solo", OWNER)
    make_workspace(repositories, ELSEWHERE, "elsewhere", ADMIN)
    add_member(repositories, ELSEWHERE, OWNER, "member")
    return repositories


def delete(client: TestClient, email: str = "owner@example.com") -> Any:
    """Ask for the caller's account deletion with `email` typed as the confirmation."""
    return client.post("/api/users/me/deletion", json={"confirm_email": email})


def test_the_plan_sorts_every_workspace(client: TestClient, seeded: Any) -> None:
    """The plan names what blocks, what is deleted with the account, and what is left."""
    sign_in(client, OWNER)

    plan = client.get("/api/users/me/deletion-plan").json()

    assert [row["id"] for row in plan["blocking"]] == [SHARED]
    assert [row["id"] for row in plan["deleted_with_account"]] == [SOLO]
    assert [row["id"] for row in plan["leaving"]] == [ELSEWHERE]


def test_a_sole_owner_of_a_shared_workspace_is_blocked(
    client: TestClient, seeded: Any, purges: list[str], revocations: list[str]
) -> None:
    """The 409 names each blocking workspace, and nothing is deleted or revoked."""
    sign_in(client, OWNER)

    response = delete(client)

    assert response.status_code == 409
    body = response.json()
    assert body["error_code"] == "SOLE_OWNER"
    assert [row["slug"] for row in body["details"]["workspaces"]] == ["shared"]
    assert not seeded.users.get(OWNER).is_deleted
    assert purges == [] and revocations == []


def test_a_scheduled_workspace_still_blocks_until_ownership_moves(client: TestClient, seeded: Any) -> None:
    """A workspace only scheduled for deletion can be cancelled, so it still needs an owner."""
    sign_in(client, OWNER)
    seeded.workspaces.schedule_deletion(SHARED, OWNER)

    blocking = client.get("/api/users/me/deletion-plan").json()["blocking"]

    assert [(row["id"], row["deletion_scheduled"]) for row in blocking] == [(SHARED, True)]

    seeded.memberships.set_role(SHARED, MEMBER, "owner")

    assert client.get("/api/users/me/deletion-plan").json()["blocking"] == []


def test_the_typed_email_has_to_match(client: TestClient, seeded: Any, purges: list[str]) -> None:
    """A different address is refused before anything else is checked."""
    sign_in(client, MEMBER)

    response = delete(client, "owner@example.com")

    assert response.status_code == 400
    assert response.json()["error_code"] == "CONFIRMATION_MISMATCH"
    assert not seeded.users.get(MEMBER).is_deleted
    assert purges == []


def test_deleting_is_immediate(
    client: TestClient, seeded: Any, recorder: Any, purges: list[str], revocations: list[str]
) -> None:
    """The account is marked, signed out everywhere, its keys go, its purge is requested and it is mailed."""
    seeded.api_keys.put(_personal_key(MEMBER, SHARED))
    sign_in(client, MEMBER)

    response = delete(client, "Member@Example.com")

    assert response.status_code == 204
    row = seeded.users.get(MEMBER)
    assert row.is_deleted
    assert row.purge_after is not None and row.purge_after == row.deletion_scheduled_at
    assert revocations == [MEMBER]
    assert seeded.api_keys.list_for_user(MEMBER) == []
    assert purges == [MEMBER]
    assert [message.to for message in recorder.sent] == ["member@example.com"]
    notice = recorder.sent[0]
    assert "was deleted" in notice.subject
    assert "deleted user" in notice.text
    assert "cancel" not in notice.text.lower()
    assert "\u2014" not in notice.text and "\u2014" not in notice.html


def test_a_deleted_account_is_refused_with_its_old_token(
    client: TestClient, seeded: Any, purges: list[str], revocations: list[str]
) -> None:
    """A token issued before the deletion no longer reads or changes the account."""
    sign_in(client, MEMBER)
    assert delete(client, "member@example.com").status_code == 204

    for response in (
        client.get("/api/users/me"),
        client.get("/api/users/me/deletion-plan"),
        client.patch("/api/users/me/preferences", json={"email_notifications": False}),
    ):
        assert response.status_code == 401
        assert response.json()["error_code"] == "ACCOUNT_DELETED"


def test_repeating_requests_the_purge_again_without_mailing(
    client: TestClient, seeded: Any, recorder: Any, purges: list[str], revocations: list[str]
) -> None:
    """A retried request is answered the same and only nudges the purge."""
    sign_in(client, MEMBER)

    assert delete(client, "member@example.com").status_code == 204
    assert delete(client, "member@example.com").status_code == 204

    assert purges == [MEMBER, MEMBER]
    assert len(recorder.sent) == 1


def test_a_failed_revocation_or_purge_request_still_deletes(
    client: TestClient, seeded: Any, recorder: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The account is already marked, so a failure after that is logged and the sweep catches up."""

    def broken(user_id: str) -> Any:
        """Fail the way an unreachable table or queue would."""
        raise RuntimeError("unreachable")

    monkeypatch.setattr(account_revocation, "_revoke_refresh_families", broken)
    monkeypatch.setattr(account_revocation, "_revoke_connected_apps", broken)
    monkeypatch.setattr(team_purge, "request_account_purge", broken)
    sign_in(client, MEMBER)

    assert delete(client, "member@example.com").status_code == 204
    assert seeded.users.get(MEMBER).is_deleted
    assert len(recorder.sent) == 1


def test_a_token_or_api_key_is_refused(client: TestClient, seeded: Any, purges: list[str]) -> None:
    """Only the person themselves, signed in, can delete their account."""
    sign_in(client, MEMBER, scope="issues:read")

    assert delete(client, "member@example.com").status_code == 403
    assert client.get("/api/users/me/deletion-plan").status_code == 403
    assert not seeded.users.get(MEMBER).is_deleted
    assert purges == []


def test_cancelling_is_gone(client: TestClient, seeded: Any) -> None:
    """There is no grace period, so there is nothing to cancel."""
    sign_in(client, MEMBER)

    assert client.delete("/api/users/me/deletion").status_code == 405


def test_a_deleted_account_may_not_sign_in(seeded: Any) -> None:
    """Every sign in method and refresh consults the hook, which refuses a marked account."""
    hooks = StanduplessIdentityHooks(seeded.users)
    seeded.users.update(MEMBER, email_verified=True)
    hooks.may_authenticate(hooks.load_user_by_id(MEMBER) or {})

    seeded.users.mark_deleted(MEMBER)

    with pytest.raises(AuthenticationRefused) as refused:
        hooks.may_authenticate(hooks.load_user_by_id(MEMBER) or {})
    assert refused.value.error_code == "ACCOUNT_DELETED"


def _personal_key(user_id: str, workspace_id: str) -> Any:
    """A personal API key record for one user in one workspace."""
    from webbpulse.identity.api_keys import ApiKeyRecord

    return ApiKeyRecord(
        key_hash=f"hash-{user_id}",
        key_id=f"key-{user_id}",
        user_id=user_id,
        tenant_id=workspace_id,
        name="laptop",
        prefix="sl_test",
        scopes=("issues:read",),
        created_at="2026-09-01T00:00:00Z",
    )
