"""Inbox routes: listing, the unread badge, marking read and deleting.

The property worth holding is that the partition is built from the authorization
context and never from a parameter, so there is no route by which one member reads
or changes another's inbox, and a foreign notification id is not reachable rather
than being reachable and refused.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.inbox import Notification, expires_at, inbox_partition
from tests.domains.helpers import GUEST, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import PROJECT, WORKSPACE

BASE = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)


def put_notification(
    repositories: Any,
    recipient_id: str,
    notification_id: str,
    *,
    unread: bool = True,
    kind: str = "assigned",
    minutes: int = 0,
) -> Notification:
    """Write one inbox row straight in, so a route test needs no consumer run."""
    created_at = BASE + timedelta(minutes=minutes)
    row = Notification(
        ws_user=inbox_partition(WORKSPACE, recipient_id),
        notification_id=notification_id,
        workspace_id=WORKSPACE,
        kind=kind,
        issue_id="01JB0000000000000000ISSUE1",
        issue_key="ABC-1",
        issue_title="An issue",
        project_id=PROJECT,
        comment_id=None,
        actor_id=OWNER,
        actor_name="Olive Owner",
        recipient_id=recipient_id,
        created_at=created_at,
        unread_at=created_at.isoformat() if unread else None,
        expires_at=expires_at(created_at),
    )
    repositories.inbox.create(row)
    return row


def test_the_inbox_lists_only_the_callers_own_notifications(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """The partition comes from the context, so another member's rows never appear."""
    put_notification(repositories, MEMBER, "01N0000000000000000000MINE")
    put_notification(repositories, OWNER, "01N000000000000000000THEIR")

    sign_in(client, MEMBER)
    response = client.get(f"/api/workspaces/{workspace}/inbox")

    assert response.status_code == 200
    assert [row["notification_id"] for row in response.json()["notifications"]] == ["01N0000000000000000000MINE"]


def test_the_inbox_reads_newest_first(client: TestClient, workspace: str, repositories: Any) -> None:
    """Newest first, because a notification list is read from the top.

    The order is the sort key's own, which the consumer makes chronological by
    giving every id a ULID timestamp prefix, so the ids here ascend the way real
    ones do rather than being arbitrary strings.
    """
    put_notification(repositories, MEMBER, "01N0000000000000000000A001", minutes=0)
    put_notification(repositories, MEMBER, "01N0000000000000000000B002", minutes=5)

    sign_in(client, MEMBER)
    ids = [row["notification_id"] for row in client.get(f"/api/workspaces/{workspace}/inbox").json()["notifications"]]

    assert ids == ["01N0000000000000000000B002", "01N0000000000000000000A001"]


def test_unread_only_reads_the_sparse_index(client: TestClient, workspace: str, repositories: Any) -> None:
    """A read notification leaves the index, so the unread list is short by design."""
    put_notification(repositories, MEMBER, "01N000000000000000000UNRD", unread=True)
    put_notification(repositories, MEMBER, "01N000000000000000000READ", unread=False)

    sign_in(client, MEMBER)
    response = client.get(f"/api/workspaces/{workspace}/inbox", params={"unread": True})

    assert [row["notification_id"] for row in response.json()["notifications"]] == ["01N000000000000000000UNRD"]


def test_the_unread_count_counts_only_unread(client: TestClient, workspace: str, repositories: Any) -> None:
    """The badge is the sparse index's length, not the partition's."""
    put_notification(repositories, MEMBER, "01N0000000000000000000A000", unread=True)
    put_notification(repositories, MEMBER, "01N0000000000000000000B000", unread=True)
    put_notification(repositories, MEMBER, "01N0000000000000000000C000", unread=False)

    sign_in(client, MEMBER)
    response = client.get(f"/api/workspaces/{workspace}/inbox/count")

    assert response.status_code == 200
    assert response.json()["unread"] == 2


def test_the_unread_count_is_zero_for_an_empty_inbox(client: TestClient, workspace: str) -> None:
    """Nothing to count is a zero, not a missing field."""
    sign_in(client, GUEST)

    assert client.get(f"/api/workspaces/{workspace}/inbox/count").json()["unread"] == 0


def test_marking_ids_read_removes_them_from_the_badge(client: TestClient, workspace: str, repositories: Any) -> None:
    """Marking read deletes `unread_at`, which drops the row from the index."""
    put_notification(repositories, MEMBER, "01N0000000000000000000A000")
    put_notification(repositories, MEMBER, "01N0000000000000000000B000")

    sign_in(client, MEMBER)
    response = client.post(
        f"/api/workspaces/{workspace}/inbox/read",
        json={"notification_ids": ["01N0000000000000000000A000"]},
    )

    assert response.status_code == 200
    assert response.json()["updated"] == 1
    assert client.get(f"/api/workspaces/{workspace}/inbox/count").json()["unread"] == 1


def test_marking_the_same_id_read_twice_updates_nothing_the_second_time(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """The write is conditional on being unread, so a repeat is a no-op."""
    put_notification(repositories, MEMBER, "01N0000000000000000000A000")

    sign_in(client, MEMBER)
    body = {"notification_ids": ["01N0000000000000000000A000"]}
    assert client.post(f"/api/workspaces/{workspace}/inbox/read", json=body).json()["updated"] == 1
    assert client.post(f"/api/workspaces/{workspace}/inbox/read", json=body).json()["updated"] == 0


def test_marking_another_members_notification_read_changes_nothing(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A foreign id is not in the caller's partition, so it cannot be reached.

    Counted as nothing changed rather than refused, because reporting a 404 would
    tell the caller whether that id exists in someone else's inbox.
    """
    put_notification(repositories, OWNER, "01N000000000000000000THEIR")

    sign_in(client, MEMBER)
    response = client.post(
        f"/api/workspaces/{workspace}/inbox/read",
        json={"notification_ids": ["01N000000000000000000THEIR"]},
    )

    assert response.status_code == 200
    assert response.json()["updated"] == 0
    assert repositories.inbox.get(workspace, OWNER, "01N000000000000000000THEIR").unread is True


def test_marking_all_read_empties_the_badge(client: TestClient, workspace: str, repositories: Any) -> None:
    """Mark all read is the whole sparse index for this one member."""
    put_notification(repositories, MEMBER, "01N0000000000000000000A000")
    put_notification(repositories, MEMBER, "01N0000000000000000000B000")
    put_notification(repositories, OWNER, "01N000000000000000000THEIR")

    sign_in(client, MEMBER)
    response = client.post(f"/api/workspaces/{workspace}/inbox/read", json={"all": True})

    assert response.json()["updated"] == 2
    assert client.get(f"/api/workspaces/{workspace}/inbox/count").json()["unread"] == 0
    assert repositories.inbox.get(workspace, OWNER, "01N000000000000000000THEIR").unread is True


def test_marking_read_with_neither_ids_nor_all_is_rejected(client: TestClient, workspace: str) -> None:
    """An empty request is a mistake rather than a silent no-op."""
    sign_in(client, MEMBER)

    response = client.post(f"/api/workspaces/{workspace}/inbox/read", json={})

    assert response.status_code == 422
    assert response.json()["error_code"] == "VALIDATION_ERROR"


def test_deleting_a_notification_removes_it(client: TestClient, workspace: str, repositories: Any) -> None:
    """Delete answers 204 and the row stops appearing."""
    put_notification(repositories, MEMBER, "01N0000000000000000000A000")

    sign_in(client, MEMBER)
    assert client.delete(f"/api/workspaces/{workspace}/inbox/01N0000000000000000000A000").status_code == 204
    assert client.get(f"/api/workspaces/{workspace}/inbox").json()["notifications"] == []


def test_deleting_another_members_notification_is_not_found(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A foreign id is not in the caller's partition, so it reads as absent."""
    put_notification(repositories, OWNER, "01N000000000000000000THEIR")

    sign_in(client, MEMBER)
    response = client.delete(f"/api/workspaces/{workspace}/inbox/01N000000000000000000THEIR")

    assert response.status_code == 404
    assert repositories.inbox.get(workspace, OWNER, "01N000000000000000000THEIR") is not None


def test_a_non_member_cannot_read_an_inbox(client: TestClient, workspace: str) -> None:
    """Fail closed: no workspace membership is a 404."""
    sign_in(client, "01JB000000000000000000OUTS")

    assert client.get(f"/api/workspaces/{workspace}/inbox").status_code == 404


def test_the_inbox_pages(client: TestClient, workspace: str, repositories: Any) -> None:
    """A cursor walks the partition without repeating or dropping a row."""
    for index in range(5):
        put_notification(repositories, MEMBER, f"01N000000000000000000{index:03d}", minutes=index)

    sign_in(client, MEMBER)
    seen: list[str] = []
    cursor: Any = None
    for _ in range(5):
        params: "dict[str, Any]" = {"limit": 2}
        if cursor:
            params["cursor"] = cursor
        page = client.get(f"/api/workspaces/{workspace}/inbox", params=params)
        assert page.status_code == 200
        seen.extend(row["notification_id"] for row in page.json()["notifications"])
        cursor = page.json()["next_cursor"]
        if not cursor:
            break

    assert len(seen) == 5
    assert len(set(seen)) == 5


def test_a_notification_carries_the_title_it_was_written_with(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Denormalised on write, so a deleted issue does not 404 a whole list."""
    put_notification(repositories, MEMBER, "01N0000000000000000000A000")

    sign_in(client, MEMBER)
    row = client.get(f"/api/workspaces/{workspace}/inbox").json()["notifications"][0]

    assert row["issue_key"] == "ABC-1"
    assert row["issue_title"] == "An issue"
    assert row["actor_name"] == "Olive Owner"
    assert row["unread"] is True
