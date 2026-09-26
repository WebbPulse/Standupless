"""Scheduling and cancelling an account's deletion through the identity routes.

The sole owner rule is the one that matters most: an account cannot leave a
workspace other people still use with nobody to own it.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.users import ACCOUNT_DELETION_GRACE_DAYS
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


def schedule(client: TestClient, email: str = "owner@example.com") -> Any:
    """Ask for the caller's account deletion with `email` typed as the confirmation."""
    return client.post("/api/users/me/deletion", json={"confirm_email": email})


def test_the_plan_sorts_every_workspace(client: TestClient, seeded: Any) -> None:
    """The plan names what blocks, what is deleted with the account, and what is left."""
    sign_in(client, OWNER)

    plan = client.get("/api/users/me/deletion-plan").json()

    assert [row["id"] for row in plan["blocking"]] == [SHARED]
    assert [row["id"] for row in plan["deleted_with_account"]] == [SOLO]
    assert [row["id"] for row in plan["leaving"]] == [ELSEWHERE]


def test_a_sole_owner_of_a_shared_workspace_is_blocked(client: TestClient, seeded: Any) -> None:
    """The 409 names each blocking workspace, and nothing is scheduled."""
    sign_in(client, OWNER)

    response = schedule(client)

    assert response.status_code == 409
    body = response.json()
    assert body["error_code"] == "SOLE_OWNER"
    assert [row["slug"] for row in body["details"]["workspaces"]] == ["shared"]
    assert seeded.users.get(OWNER).purge_after is None


def test_a_second_owner_or_a_scheduled_workspace_lifts_the_block(client: TestClient, seeded: Any) -> None:
    """Handing over ownership, or deleting the workspace, is the way out of the block."""
    sign_in(client, OWNER)
    seeded.workspaces.schedule_deletion(SHARED, OWNER)

    assert client.get("/api/users/me/deletion-plan").json()["blocking"] == []

    seeded.workspaces.cancel_deletion(SHARED)
    seeded.memberships.set_role(SHARED, MEMBER, "owner")

    assert client.get("/api/users/me/deletion-plan").json()["blocking"] == []


def test_the_typed_email_has_to_match(client: TestClient, seeded: Any) -> None:
    """A different address is refused before anything else is checked."""
    sign_in(client, MEMBER)

    response = schedule(client, "owner@example.com")

    assert response.status_code == 400
    assert response.json()["error_code"] == "CONFIRMATION_MISMATCH"


def test_scheduling_sets_a_fourteen_day_grace_period_and_mails_the_account(
    client: TestClient, seeded: Any, recorder: Any
) -> None:
    """The address is matched without regard to case, and the notice names the date."""
    sign_in(client, MEMBER)

    response = schedule(client, "Member@Example.com")

    assert response.status_code == 200
    row = seeded.users.get(MEMBER)
    assert row.purge_after - row.deletion_scheduled_at == timedelta(days=ACCOUNT_DELETION_GRACE_DAYS)
    assert ACCOUNT_DELETION_GRACE_DAYS == 14
    assert response.json()["purge_after"] is not None
    assert [message.to for message in recorder.sent] == ["member@example.com"]
    notice = recorder.sent[0]
    assert row.purge_after.strftime("%d %B %Y") in notice.text
    assert "deleted user" in notice.text
    assert "\u2014" not in notice.text and "\u2014" not in notice.html


def test_repeating_keeps_the_date_and_cancelling_is_idempotent(client: TestClient, seeded: Any, recorder: Any) -> None:
    """A repeat does not move the date or mail again, and a second cancel is a no-op."""
    sign_in(client, MEMBER)
    first = schedule(client, "member@example.com").json()["purge_after"]
    assert schedule(client, "member@example.com").json()["purge_after"] == first
    assert len(recorder.sent) == 1

    cancelled = client.delete("/api/users/me/deletion")
    again = client.delete("/api/users/me/deletion")

    assert cancelled.status_code == 200
    assert cancelled.json()["purge_after"] is None
    assert again.status_code == 200
    assert seeded.users.get(MEMBER).purge_after is None
    assert len(recorder.sent) == 2
    assert "cancelled" in recorder.sent[1].subject.lower()


def test_a_token_or_api_key_is_refused(client: TestClient, seeded: Any) -> None:
    """Only the person themselves, signed in, can delete their account."""
    sign_in(client, MEMBER, scope="issues:read")

    assert schedule(client, "member@example.com").status_code == 403
    assert client.get("/api/users/me/deletion-plan").status_code == 403
    assert client.delete("/api/users/me/deletion").status_code == 403
    assert seeded.users.get(MEMBER).purge_after is None


def test_a_purging_account_cannot_be_cancelled(client: TestClient, seeded: Any) -> None:
    """Once the account purge starts, the schedule is final."""
    sign_in(client, MEMBER)
    schedule(client, "member@example.com")
    later = seeded.users.get(MEMBER).purge_after + timedelta(minutes=1)
    assert seeded.users.begin_purge(MEMBER, [SHARED], now=later) is True

    assert client.delete("/api/users/me/deletion").status_code == 409
