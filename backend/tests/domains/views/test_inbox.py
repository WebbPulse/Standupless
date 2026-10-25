"""Inbox routes: listing, the unread badge, marking read, deleting and clearing.

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
from tests.domains.views.conftest import TEAM, WORKSPACE

BASE = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)


def put_notification(
    repositories: Any,
    recipient_id: str,
    notification_id: str,
    *,
    unread: bool = True,
    kind: str = "assigned",
    minutes: int = 0,
    new_value: str | None = None,
    actor_name: str = "Olive Owner",
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
        team_id=TEAM,
        comment_id=None,
        new_value=new_value,
        actor_id=OWNER,
        actor_name=actor_name,
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


def test_marking_all_read_keeps_to_the_kinds_named(client: TestClient, workspace: str, repositories: Any) -> None:
    """`kinds` narrows mark all read to the list's filter, so hidden types stay unread."""
    put_notification(repositories, MEMBER, "01N0000000000000000000A000", kind="mentioned")
    put_notification(repositories, MEMBER, "01N0000000000000000000B000", kind="assigned")
    put_notification(repositories, MEMBER, "01N0000000000000000000C000", kind="commented")

    sign_in(client, MEMBER)
    response = client.post(
        f"/api/workspaces/{workspace}/inbox/read", json={"all": True, "kinds": ["mentioned", "commented"]}
    )

    assert response.status_code == 200
    assert response.json()["updated"] == 2
    assert repositories.inbox.get(workspace, MEMBER, "01N0000000000000000000A000").unread is False
    assert repositories.inbox.get(workspace, MEMBER, "01N0000000000000000000B000").unread is True
    assert repositories.inbox.get(workspace, MEMBER, "01N0000000000000000000C000").unread is False
    assert client.get(f"/api/workspaces/{workspace}/inbox/count").json()["unread"] == 1


def test_marking_all_read_refuses_an_unknown_kind(client: TestClient, workspace: str) -> None:
    """A misspelt kind would otherwise mark nothing and look like success."""
    sign_in(client, MEMBER)

    response = client.post(f"/api/workspaces/{workspace}/inbox/read", json={"all": True, "kinds": ["nonsense"]})

    assert response.status_code == 422


def test_kinds_without_all_is_rejected(client: TestClient, workspace: str) -> None:
    """`kinds` narrows a mark of everything, so beside ids it means nothing and is refused."""
    sign_in(client, MEMBER)

    response = client.post(
        f"/api/workspaces/{workspace}/inbox/read",
        json={"notification_ids": ["01N0000000000000000000A000"], "kinds": ["mentioned"]},
    )

    assert response.status_code == 422


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


def test_clearing_read_notifications_keeps_the_unread_and_snoozed_ones(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """`read_only` takes the read rows alone, so nothing still waiting is lost."""
    put_notification(repositories, MEMBER, "01N0000000000000000000A000", unread=False)
    put_notification(repositories, MEMBER, "01N0000000000000000000B000", unread=True)
    put_notification(repositories, MEMBER, "01N0000000000000000000C000", unread=True)
    repositories.inbox.snooze(
        workspace, MEMBER, ["01N0000000000000000000C000"], datetime.now(timezone.utc) + timedelta(hours=1)
    )

    sign_in(client, MEMBER)
    response = client.post(f"/api/workspaces/{workspace}/inbox/clear", json={"read_only": True})

    assert response.status_code == 200
    assert response.json()["deleted"] == 1
    assert repositories.inbox.get(workspace, MEMBER, "01N0000000000000000000A000") is None
    assert repositories.inbox.get(workspace, MEMBER, "01N0000000000000000000B000") is not None
    assert repositories.inbox.get(workspace, MEMBER, "01N0000000000000000000C000") is not None
    assert client.get(f"/api/workspaces/{workspace}/inbox/count").json()["unread"] == 1


def test_clearing_everything_leaves_snoozed_rows_unless_asked(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A full clear takes read and unread rows, and snoozed ones only with `include_snoozed`."""
    put_notification(repositories, MEMBER, "01N0000000000000000000A000", unread=False)
    put_notification(repositories, MEMBER, "01N0000000000000000000B000", unread=True)
    put_notification(repositories, MEMBER, "01N0000000000000000000C000", unread=True)
    repositories.inbox.snooze(
        workspace, MEMBER, ["01N0000000000000000000C000"], datetime.now(timezone.utc) + timedelta(hours=1)
    )

    sign_in(client, MEMBER)
    first = client.post(f"/api/workspaces/{workspace}/inbox/clear", json={})

    assert first.json()["deleted"] == 2
    assert repositories.inbox.get(workspace, MEMBER, "01N0000000000000000000C000") is not None

    second = client.post(f"/api/workspaces/{workspace}/inbox/clear", json={"include_snoozed": True})

    assert second.json()["deleted"] == 1
    assert repositories.inbox.get(workspace, MEMBER, "01N0000000000000000000C000") is None
    assert client.get(f"/api/workspaces/{workspace}/inbox/count").json()["unread"] == 0


def test_clearing_keeps_to_the_kinds_named(client: TestClient, workspace: str, repositories: Any) -> None:
    """`kinds` narrows the clear the way the list's filter does."""
    put_notification(repositories, MEMBER, "01N0000000000000000000A000", kind="assigned")
    put_notification(repositories, MEMBER, "01N0000000000000000000B000", kind="mentioned")

    sign_in(client, MEMBER)
    response = client.post(f"/api/workspaces/{workspace}/inbox/clear", json={"kinds": ["mentioned"]})

    assert response.json()["deleted"] == 1
    assert _ids(client.get(f"/api/workspaces/{workspace}/inbox")) == ["01N0000000000000000000A000"]


def test_clearing_never_reaches_another_members_inbox(client: TestClient, workspace: str, repositories: Any) -> None:
    """Only the caller's own partition is read, so another member's rows survive a full clear."""
    put_notification(repositories, MEMBER, "01N0000000000000000000MINE", unread=False)
    put_notification(repositories, OWNER, "01N000000000000000000THEIR", unread=False)
    put_notification(repositories, OWNER, "01N000000000000000000THUNR", unread=True)

    sign_in(client, MEMBER)
    response = client.post(f"/api/workspaces/{workspace}/inbox/clear", json={"include_snoozed": True})

    assert response.json()["deleted"] == 1
    assert repositories.inbox.get(workspace, OWNER, "01N000000000000000000THEIR") is not None
    assert repositories.inbox.get(workspace, OWNER, "01N000000000000000000THUNR") is not None


def test_clearing_refuses_an_unknown_kind_and_a_non_member(client: TestClient, workspace: str) -> None:
    """An unknown kind is a 422, and no workspace membership is a 404."""
    sign_in(client, MEMBER)
    assert client.post(f"/api/workspaces/{workspace}/inbox/clear", json={"kinds": ["nonsense"]}).status_code == 422

    sign_in(client, "01JB000000000000000000OUTS")
    assert client.post(f"/api/workspaces/{workspace}/inbox/clear", json={}).status_code == 404


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


def _ids(response: Any) -> "list[str]":
    """The notification ids of one inbox list response."""
    return [row["notification_id"] for row in response.json()["notifications"]]


def test_marking_read_notifications_unread_returns_them_to_the_badge(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Mark unread writes `unread_at` back, so the row counts and lists as unread again."""
    put_notification(repositories, MEMBER, "01N0000000000000000000A000", unread=False)

    sign_in(client, MEMBER)
    body = {"notification_ids": ["01N0000000000000000000A000"]}
    response = client.post(f"/api/workspaces/{workspace}/inbox/unread", json=body)

    assert response.status_code == 200
    assert response.json()["updated"] == 1
    assert client.get(f"/api/workspaces/{workspace}/inbox/count").json()["unread"] == 1
    assert _ids(client.get(f"/api/workspaces/{workspace}/inbox", params={"unread": True})) == [
        "01N0000000000000000000A000"
    ]
    assert client.post(f"/api/workspaces/{workspace}/inbox/unread", json=body).json()["updated"] == 0


def test_read_then_unread_round_trips(client: TestClient, workspace: str, repositories: Any) -> None:
    """The U key toggles, so read and unread must each undo the other."""
    put_notification(repositories, MEMBER, "01N0000000000000000000A000")

    sign_in(client, MEMBER)
    body = {"notification_ids": ["01N0000000000000000000A000"]}
    client.post(f"/api/workspaces/{workspace}/inbox/read", json=body)
    assert client.get(f"/api/workspaces/{workspace}/inbox").json()["notifications"][0]["unread"] is False
    client.post(f"/api/workspaces/{workspace}/inbox/unread", json=body)
    assert client.get(f"/api/workspaces/{workspace}/inbox").json()["notifications"][0]["unread"] is True


def test_marking_another_members_notification_unread_creates_nothing(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A foreign or unknown id is not in the caller's partition, so no row appears."""
    put_notification(repositories, OWNER, "01N000000000000000000THEIR", unread=False)

    sign_in(client, MEMBER)
    response = client.post(
        f"/api/workspaces/{workspace}/inbox/unread",
        json={"notification_ids": ["01N000000000000000000THEIR", "01N00000000000000000NOSUCH"]},
    )

    assert response.status_code == 200
    assert response.json()["updated"] == 0
    assert repositories.inbox.get(workspace, OWNER, "01N000000000000000000THEIR").unread is False
    assert repositories.inbox.get(workspace, MEMBER, "01N000000000000000000THEIR") is None
    assert repositories.inbox.get(workspace, MEMBER, "01N00000000000000000NOSUCH") is None


def test_mark_unread_needs_ids(client: TestClient, workspace: str) -> None:
    """An empty request is a mistake rather than a silent no-op."""
    sign_in(client, MEMBER)

    assert client.post(f"/api/workspaces/{workspace}/inbox/unread", json={}).status_code == 422
    assert client.post(f"/api/workspaces/{workspace}/inbox/unread", json={"notification_ids": []}).status_code == 422


def test_a_snoozed_notification_leaves_the_inbox_until_its_time(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Snoozed rows leave the list, the unread list and the badge, and show under snoozed."""
    put_notification(repositories, MEMBER, "01N0000000000000000000A000")
    put_notification(repositories, MEMBER, "01N0000000000000000000B000")

    sign_in(client, MEMBER)
    until = (datetime.now(timezone.utc) + timedelta(hours=3)).isoformat()
    response = client.post(
        f"/api/workspaces/{workspace}/inbox/snooze",
        json={"notification_ids": ["01N0000000000000000000A000"], "until": until},
    )

    assert response.status_code == 200
    assert response.json()["updated"] == 1
    assert _ids(client.get(f"/api/workspaces/{workspace}/inbox")) == ["01N0000000000000000000B000"]
    assert _ids(client.get(f"/api/workspaces/{workspace}/inbox", params={"unread": True})) == [
        "01N0000000000000000000B000"
    ]
    assert client.get(f"/api/workspaces/{workspace}/inbox/count").json()["unread"] == 1
    snoozed = client.get(f"/api/workspaces/{workspace}/inbox", params={"snoozed": True}).json()["notifications"]
    assert [row["notification_id"] for row in snoozed] == ["01N0000000000000000000A000"]
    assert snoozed[0]["unread"] is False
    assert snoozed[0]["snoozed_until"] is not None


def test_mark_all_read_leaves_a_snoozed_notification_snoozed(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Marking what is on screen read does not swallow what is waiting to come back."""
    put_notification(repositories, MEMBER, "01N0000000000000000000A000")
    put_notification(repositories, MEMBER, "01N0000000000000000000B000")
    repositories.inbox.snooze(
        workspace, MEMBER, ["01N0000000000000000000A000"], datetime.now(timezone.utc) + timedelta(hours=1)
    )

    sign_in(client, MEMBER)

    assert client.post(f"/api/workspaces/{workspace}/inbox/read", json={"all": True}).json()["updated"] == 1
    assert repositories.inbox.get(workspace, MEMBER, "01N0000000000000000000A000").snoozed() is True


def test_a_snooze_that_has_run_out_returns_the_notification_unread(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """No sweep runs: once the moment passes, the row reads as unread by itself.

    A snooze already in the past stands in for time having passed, written through
    the repository since the route refuses a moment that is not in the future.
    """
    put_notification(repositories, MEMBER, "01N0000000000000000000A000", unread=False)
    repositories.inbox.snooze(
        workspace, MEMBER, ["01N0000000000000000000A000"], datetime.now(timezone.utc) - timedelta(seconds=1)
    )

    sign_in(client, MEMBER)

    assert client.get(f"/api/workspaces/{workspace}/inbox/count").json()["unread"] == 1
    row = client.get(f"/api/workspaces/{workspace}/inbox", params={"unread": True}).json()["notifications"][0]
    assert row["notification_id"] == "01N0000000000000000000A000"
    assert row["unread"] is True
    assert row["snoozed_until"] is None
    assert _ids(client.get(f"/api/workspaces/{workspace}/inbox", params={"snoozed": True})) == []


def test_marking_a_snoozed_notification_unread_ends_the_snooze(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Mark unread brings a snoozed row back at once."""
    put_notification(repositories, MEMBER, "01N0000000000000000000A000")
    repositories.inbox.snooze(
        workspace, MEMBER, ["01N0000000000000000000A000"], datetime.now(timezone.utc) + timedelta(days=1)
    )

    sign_in(client, MEMBER)
    response = client.post(
        f"/api/workspaces/{workspace}/inbox/unread", json={"notification_ids": ["01N0000000000000000000A000"]}
    )

    assert response.json()["updated"] == 1
    assert client.get(f"/api/workspaces/{workspace}/inbox/count").json()["unread"] == 1


def test_snoozing_another_members_notification_changes_nothing(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A foreign id is not in the caller's partition, so its owner still sees it."""
    put_notification(repositories, OWNER, "01N000000000000000000THEIR")

    sign_in(client, MEMBER)
    until = (datetime.now(timezone.utc) + timedelta(hours=3)).isoformat()
    response = client.post(
        f"/api/workspaces/{workspace}/inbox/snooze",
        json={"notification_ids": ["01N000000000000000000THEIR"], "until": until},
    )

    assert response.json()["updated"] == 0
    assert repositories.inbox.get(workspace, OWNER, "01N000000000000000000THEIR").unread is True
    assert repositories.inbox.get(workspace, MEMBER, "01N000000000000000000THEIR") is None


def test_a_snooze_must_be_in_the_future_and_within_retention(client: TestClient, workspace: str) -> None:
    """A moment past, naive, or beyond the 90 day retention is refused."""
    sign_in(client, MEMBER)
    now = datetime.now(timezone.utc)
    ids = ["01N0000000000000000000A000"]
    for until in (
        (now - timedelta(hours=1)).isoformat(),
        (now + timedelta(days=91)).isoformat(),
        (now + timedelta(hours=1)).replace(tzinfo=None).isoformat(),
    ):
        response = client.post(
            f"/api/workspaces/{workspace}/inbox/snooze", json={"notification_ids": ids, "until": until}
        )
        assert response.status_code == 422, until


def test_unread_and_snoozed_cannot_be_combined(client: TestClient, workspace: str) -> None:
    """Nothing is both unread and snoozed, so asking for both is a mistake."""
    sign_in(client, MEMBER)

    response = client.get(f"/api/workspaces/{workspace}/inbox", params={"unread": True, "snoozed": True})

    assert response.status_code == 422


def test_a_non_member_cannot_mark_unread_or_snooze(client: TestClient, workspace: str) -> None:
    """Fail closed: no workspace membership is a 404 on both writes."""
    sign_in(client, "01JB000000000000000000OUTS")
    ids = ["01N0000000000000000000A000"]
    until = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()

    assert client.post(f"/api/workspaces/{workspace}/inbox/unread", json={"notification_ids": ids}).status_code == 404
    assert (
        client.post(
            f"/api/workspaces/{workspace}/inbox/snooze", json={"notification_ids": ids, "until": until}
        ).status_code
        == 404
    )


def _snooze(client: TestClient, workspace: str, notification_id: str) -> None:
    """Snooze one of the signed in member's rows for three hours."""
    until = (datetime.now(timezone.utc) + timedelta(hours=3)).isoformat()
    response = client.post(
        f"/api/workspaces/{workspace}/inbox/snooze", json={"notification_ids": [notification_id], "until": until}
    )
    assert response.status_code == 200


def test_the_inbox_filters_by_kind(client: TestClient, workspace: str, repositories: Any) -> None:
    """Each repeated `kind` is ORed, and every other kind stays out of the page."""
    put_notification(repositories, MEMBER, "01N0000000000000000000A000", kind="assigned", minutes=0)
    put_notification(repositories, MEMBER, "01N0000000000000000000B000", kind="commented", minutes=1)
    put_notification(repositories, MEMBER, "01N0000000000000000000C000", kind="status_changed", minutes=2)

    sign_in(client, MEMBER)
    url = f"/api/workspaces/{workspace}/inbox"

    assert _ids(client.get(url, params={"kind": ["assigned", "status_changed"]})) == [
        "01N0000000000000000000C000",
        "01N0000000000000000000A000",
    ]
    assert _ids(client.get(url, params={"kind": "commented", "unread": True})) == ["01N0000000000000000000B000"]


def test_an_unknown_kind_is_rejected(client: TestClient, workspace: str) -> None:
    """A misspelt kind would silently empty the list, so it is a 422 instead."""
    sign_in(client, MEMBER)

    response = client.get(f"/api/workspaces/{workspace}/inbox", params={"kind": "nonsense"})

    assert response.status_code == 422


def test_include_snoozed_keeps_snoozed_rows_in_both_lists(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """The display option to show snoozed rows keeps them beside the rest, newest first."""
    put_notification(repositories, MEMBER, "01N0000000000000000000A000", minutes=0)
    put_notification(repositories, MEMBER, "01N0000000000000000000B000", minutes=1)
    put_notification(repositories, MEMBER, "01N0000000000000000000C000", minutes=2, unread=False)

    sign_in(client, MEMBER)
    _snooze(client, workspace, "01N0000000000000000000B000")
    url = f"/api/workspaces/{workspace}/inbox"

    assert _ids(client.get(url)) == ["01N0000000000000000000C000", "01N0000000000000000000A000"]
    assert _ids(client.get(url, params={"include_snoozed": True})) == [
        "01N0000000000000000000C000",
        "01N0000000000000000000B000",
        "01N0000000000000000000A000",
    ]
    assert _ids(client.get(url, params={"include_snoozed": True, "unread": True})) == [
        "01N0000000000000000000B000",
        "01N0000000000000000000A000",
    ]


def test_a_cursor_does_not_cross_a_kind_filter(client: TestClient, workspace: str, repositories: Any) -> None:
    """A cursor minted under one kind filter starts another filter from its first page."""
    for index in range(3):
        put_notification(repositories, MEMBER, f"01N0000000000000000000A00{index}", kind="assigned", minutes=index)

    sign_in(client, MEMBER)
    url = f"/api/workspaces/{workspace}/inbox"
    cursor = client.get(url, params={"kind": "assigned", "limit": 1}).json()["next_cursor"]

    assert cursor
    assert _ids(client.get(url, params={"kind": "assigned", "limit": 1, "cursor": cursor})) == [
        "01N0000000000000000000A001"
    ]
    assert _ids(client.get(url, params={"limit": 1, "cursor": cursor})) == ["01N0000000000000000000A002"]


def test_a_row_says_who_changed_what(client: TestClient, workspace: str, repositories: Any) -> None:
    """The summary names the actor and the new value, and falls back when either is missing."""
    put_notification(repositories, MEMBER, "01N0000000000000000000A000", kind="status_changed", new_value="Done")
    put_notification(repositories, MEMBER, "01N0000000000000000000B000", kind="status_changed", minutes=1)
    put_notification(repositories, MEMBER, "01N0000000000000000000C000", kind="assigned", minutes=2)
    put_notification(repositories, MEMBER, "01N0000000000000000000D000", kind="commented", minutes=3, actor_name="")

    sign_in(client, MEMBER)
    rows = client.get(f"/api/workspaces/{workspace}/inbox").json()["notifications"]
    by_id = {row["notification_id"]: row for row in rows}

    assert by_id["01N0000000000000000000A000"]["summary"] == "Olive Owner moved to Done"
    assert by_id["01N0000000000000000000A000"]["new_value"] == "Done"
    assert by_id["01N0000000000000000000B000"]["summary"] == "Olive Owner changed the status"
    assert by_id["01N0000000000000000000B000"]["new_value"] is None
    assert by_id["01N0000000000000000000C000"]["summary"] == "Olive Owner assigned you"
    assert by_id["01N0000000000000000000D000"]["summary"] == "New comment"


def _split_inbox(repositories: Any) -> None:
    """One unread mention and one unread comment, which land in Priority and Other by default."""
    put_notification(repositories, MEMBER, "01N0000000000000000000A000", kind="mentioned", minutes=0)
    put_notification(repositories, MEMBER, "01N0000000000000000000B000", kind="commented", minutes=1)
    put_notification(repositories, MEMBER, "01N0000000000000000000C000", kind="assigned", minutes=2, unread=False)


def test_the_bucket_keeps_the_list_to_one_tab(client: TestClient, workspace: str, repositories: Any) -> None:
    """Priority holds the default priority kinds, Other everything else, and all both."""
    _split_inbox(repositories)

    sign_in(client, MEMBER)
    url = f"/api/workspaces/{workspace}/inbox"

    assert _ids(client.get(url, params={"bucket": "priority"})) == [
        "01N0000000000000000000C000",
        "01N0000000000000000000A000",
    ]
    assert _ids(client.get(url, params={"bucket": "other"})) == ["01N0000000000000000000B000"]
    assert len(_ids(client.get(url, params={"bucket": "all"}))) == 3
    assert _ids(client.get(url, params={"bucket": "other", "kind": "mentioned"})) == []
    assert client.get(url, params={"bucket": "starred"}).status_code == 422


def test_the_count_splits_unread_and_the_badge_follows_priority(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """With the split on the badge counts Priority only; turned off it counts everything."""
    _split_inbox(repositories)

    sign_in(client, MEMBER)
    url = f"/api/workspaces/{workspace}/inbox/count"

    assert client.get(url).json() == {
        "unread": 2,
        "priority_unread": 1,
        "other_unread": 1,
        "priority_inbox": True,
        "badge": 1,
    }

    repositories.users.update(MEMBER, priority_inbox=False)

    split_off = client.get(url).json()
    assert split_off["priority_inbox"] is False
    assert split_off["badge"] == 2


def test_a_custom_priority_set_moves_kinds_between_tabs(client: TestClient, workspace: str, repositories: Any) -> None:
    """A kind the person adds joins Priority, and a default they remove drops to Other."""
    _split_inbox(repositories)
    repositories.users.update(MEMBER, priority_kinds={"commented": True, "mentioned": False})

    sign_in(client, MEMBER)
    url = f"/api/workspaces/{workspace}/inbox"

    assert _ids(client.get(url, params={"bucket": "priority"})) == [
        "01N0000000000000000000C000",
        "01N0000000000000000000B000",
    ]
    assert _ids(client.get(url, params={"bucket": "other"})) == ["01N0000000000000000000A000"]


def test_marking_all_read_keeps_to_the_bucket(client: TestClient, workspace: str, repositories: Any) -> None:
    """Mark all read inside the Other tab leaves the Priority tab unread."""
    _split_inbox(repositories)

    sign_in(client, MEMBER)
    response = client.post(f"/api/workspaces/{workspace}/inbox/read", json={"all": True, "bucket": "other"})

    assert response.json()["updated"] == 1
    assert repositories.inbox.get(workspace, MEMBER, "01N0000000000000000000A000").unread is True
    assert repositories.inbox.get(workspace, MEMBER, "01N0000000000000000000B000").unread is False


def test_a_bucket_without_all_is_rejected(client: TestClient, workspace: str) -> None:
    """`bucket` narrows a mark of everything, so beside ids it is refused."""
    sign_in(client, MEMBER)

    response = client.post(
        f"/api/workspaces/{workspace}/inbox/read",
        json={"notification_ids": ["01N0000000000000000000A000"], "bucket": "priority"},
    )

    assert response.status_code == 422


def test_clearing_keeps_to_the_bucket(client: TestClient, workspace: str, repositories: Any) -> None:
    """Clearing the Priority tab deletes only its rows."""
    _split_inbox(repositories)

    sign_in(client, MEMBER)
    response = client.post(f"/api/workspaces/{workspace}/inbox/clear", json={"bucket": "priority"})

    assert response.json()["deleted"] == 2
    assert _ids(client.get(f"/api/workspaces/{workspace}/inbox")) == ["01N0000000000000000000B000"]
