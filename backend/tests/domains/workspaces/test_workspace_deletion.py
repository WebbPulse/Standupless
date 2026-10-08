"""Scheduling and cancelling a workspace's deletion through its routes.

The speed bumps are what these hold: admins and owners only, a signed in person
only, the name typed out again, a fourteen day grace period that a repeat does not
reset, a notice to every owner and admin, and nothing reachable once the purge has
started.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.workspaces import DELETION_GRACE_DAYS
from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_member, make_user, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the workspaces application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["workspaces"])
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
    """A workspace named Mine with an owner, an admin and a member, all with addresses."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    make_user(repositories, OWNER, "owner@example.com", "Olive")
    make_user(repositories, ADMIN, "admin@example.com", "Ada")
    make_user(repositories, MEMBER, "member@example.com", "Max")
    return repositories


def schedule(client: TestClient, name: str = "Mine") -> Any:
    """Ask for the workspace's deletion with `name` typed as the confirmation."""
    return client.post(f"/api/workspaces/{WORKSPACE}/deletion", json={"confirm_name": name})


def test_a_member_cannot_schedule_or_cancel(client: TestClient, seeded: Any) -> None:
    """Deletion is an owner's or admin's call, never a member's."""
    sign_in(client, MEMBER)

    assert schedule(client).status_code == 403
    assert client.delete(f"/api/workspaces/{WORKSPACE}/deletion").status_code == 403
    assert seeded.workspaces.get(WORKSPACE).purge_after is None


def test_an_api_key_or_token_is_refused(client: TestClient, seeded: Any) -> None:
    """A delegated credential never schedules a deletion, even one carrying an owner's authority."""
    sign_in(client, OWNER, actor="api_key", workspace_id=WORKSPACE)

    response = schedule(client)

    assert response.status_code in (401, 403)
    assert seeded.workspaces.get(WORKSPACE).purge_after is None


def test_the_typed_name_has_to_match(client: TestClient, seeded: Any) -> None:
    """A wrong or partial name is refused with a code the dialog can show."""
    sign_in(client, OWNER)

    response = schedule(client, "Min")

    assert response.status_code == 400
    assert response.json()["error_code"] == "CONFIRMATION_MISMATCH"
    assert seeded.workspaces.get(WORKSPACE).purge_after is None


def test_scheduling_sets_a_fourteen_day_grace_period_and_mails_the_admins(
    client: TestClient, seeded: Any, recorder: Any
) -> None:
    """The row carries who asked and when the purge runs, and every owner and admin is told."""
    sign_in(client, ADMIN)

    response = schedule(client)

    assert response.status_code == 200
    body = response.json()
    assert body["deletion_scheduled_by"] == ADMIN
    row = seeded.workspaces.get(WORKSPACE)
    assert row.purge_after - row.deletion_scheduled_at == timedelta(days=DELETION_GRACE_DAYS)
    assert DELETION_GRACE_DAYS == 14
    assert sorted(message.to for message in recorder.sent) == ["admin@example.com", "owner@example.com"]
    notice = recorder.sent[0]
    assert "scheduled" in notice.subject
    assert row.purge_after.strftime("%d %B %Y") in notice.text
    assert "/w/mine/settings" in notice.text
    assert "\u2014" not in notice.text and "\u2014" not in notice.html


def test_the_deletion_notice_is_drawn_in_the_workspace_accent(client: TestClient, seeded: Any, recorder: Any) -> None:
    """A dark accent is used as set, with white text on the button."""
    from app.common.email.brand import BRAND_ACCENT

    seeded.workspaces.set_accent_color(WORKSPACE, "#1d4ed8")
    sign_in(client, ADMIN)

    assert schedule(client).status_code == 200

    notice = recorder.sent[0]
    assert 'bgcolor="#1d4ed8"' in notice.html
    assert "color:#ffffff;text-decoration:none" in notice.html
    assert BRAND_ACCENT not in notice.html


def test_repeating_keeps_the_first_date_and_mails_once(client: TestClient, seeded: Any, recorder: Any) -> None:
    """A second request cannot push the purge out, and does not mail the admins twice."""
    sign_in(client, OWNER)
    first = schedule(client).json()["purge_after"]

    second = schedule(client)

    assert second.status_code == 200
    assert second.json()["purge_after"] == first
    assert len(recorder.sent) == 2


def test_the_workspace_stays_usable_during_the_grace_period(client: TestClient, seeded: Any) -> None:
    """Members keep working, and the read carries the date for the banner."""
    sign_in(client, OWNER)
    schedule(client)
    sign_in(client, MEMBER)

    listed = client.get("/api/workspaces").json()["workspaces"]
    read = client.get(f"/api/workspaces/{WORKSPACE}")

    assert [row["id"] for row in listed] == [WORKSPACE]
    assert read.status_code == 200
    assert read.json()["purge_after"] is not None


def test_cancelling_clears_the_schedule_and_is_idempotent(client: TestClient, seeded: Any, recorder: Any) -> None:
    """Any admin can cancel, the admins are told once, and a second cancel is a quiet no-op."""
    sign_in(client, OWNER)
    schedule(client)
    recorder.sent.clear()
    sign_in(client, ADMIN)

    cancelled = client.delete(f"/api/workspaces/{WORKSPACE}/deletion")
    again = client.delete(f"/api/workspaces/{WORKSPACE}/deletion")

    assert cancelled.status_code == 200
    assert cancelled.json()["purge_after"] is None
    assert again.status_code == 200
    assert seeded.workspaces.get(WORKSPACE).purge_after is None
    assert len(recorder.sent) == 2
    assert all("cancelled" in message.subject for message in recorder.sent)


def test_a_purging_workspace_is_gone_and_cannot_be_cancelled(client: TestClient, seeded: Any) -> None:
    """Not before the grace period runs out, and once the purge starts nothing brings it back."""
    sign_in(client, OWNER)
    schedule(client)
    assert seeded.workspaces.begin_purge(WORKSPACE, [OWNER, ADMIN, MEMBER]) is False
    later = utc_now() + timedelta(days=DELETION_GRACE_DAYS, minutes=1)
    assert seeded.workspaces.begin_purge(WORKSPACE, [OWNER, ADMIN, MEMBER], now=later) is True

    assert client.get(f"/api/workspaces/{WORKSPACE}").status_code == 404
    assert client.get("/api/workspaces").json()["workspaces"] == []
    assert client.delete(f"/api/workspaces/{WORKSPACE}/deletion").status_code == 409
    assert schedule(client).status_code == 404


def test_the_old_hard_delete_route_is_gone(client: TestClient, seeded: Any) -> None:
    """There is no way to delete a workspace at once, only to schedule it."""
    sign_in(client, OWNER)

    assert client.delete(f"/api/workspaces/{WORKSPACE}").status_code == 405
    assert seeded.workspaces.get(WORKSPACE) is not None
