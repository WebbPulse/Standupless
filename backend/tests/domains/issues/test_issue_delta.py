"""Delta reads of the issue list: `updated_since` answers only what moved.

A polling client reads the list once, keeps `synced_at`, and sends it back to get
the changed rows that match its filter, the ids that left it, and a resync signal
when a delta cannot be trusted.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, cast

import pytest
from fastapi.testclient import TestClient

from app.common import issue_changes
from app.common.db.dynamo.activity import TOMBSTONE_RETENTION, Activity, as_item, tombstone_partition
from app.common.db.dynamo.base import utc_now
from app.domains.issues.consumers.purge import step
from tests.domains.helpers import ADMIN, GUEST, MEMBER, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, WORKSPACE, create_issue

BASE = f"/api/workspaces/{WORKSPACE}/issues"


def _since(moment: datetime) -> str:
    """A cursor as the client sends it back."""
    return moment.isoformat()


def _delta(client: TestClient, since: datetime, **params: Any) -> "dict[str, Any]":
    """One delta read of the list, failing loudly on a refusal."""
    response = client.get(BASE, params={"updated_since": _since(since), **params})
    assert response.status_code == 200, response.text
    return response.json()


def _ids(body: "dict[str, Any]") -> "set[str]":
    """The issue ids a list body carries."""
    return {row["id"] for row in body["issues"]}


def test_a_full_read_hands_out_a_cursor_just_behind_now(client: TestClient, workspace: str) -> None:
    """The cursor sits the overlap behind the read, and the body keeps its old shape."""
    sign_in(client, MEMBER)
    create_issue(client, workspace)
    before = utc_now()

    body = client.get(BASE, params={"team_id": TEAM}).json()

    synced = datetime.fromisoformat(body["synced_at"])
    assert before - issue_changes.SYNC_OVERLAP - timedelta(seconds=2) <= synced <= utc_now()
    assert body["removed_ids"] == []
    assert body["resync_required"] is False
    assert len(body["issues"]) == 1


def test_a_delta_answers_only_the_issues_changed_since(client: TestClient, workspace: str) -> None:
    """An issue created before the cursor is left out, one created after is returned."""
    sign_in(client, MEMBER)
    create_issue(client, workspace, title="Old")
    cursor = utc_now()
    fresh = create_issue(client, workspace, title="New")

    body = _delta(client, cursor, team_id=TEAM)

    assert _ids(body) == {fresh["id"]}
    assert body["removed_ids"] == []
    assert body["next_cursor"] is None
    assert datetime.fromisoformat(body["synced_at"]) >= cursor


def test_an_empty_delta_echoes_its_cursor(client: TestClient, workspace: str) -> None:
    """Nothing moved, so the answer is the same bytes every time, which is what an ETag needs."""
    sign_in(client, MEMBER)
    create_issue(client, workspace)
    cursor = utc_now() + timedelta(seconds=1)

    first = client.get(BASE, params={"updated_since": _since(cursor), "team_id": TEAM})
    second = client.get(BASE, params={"updated_since": _since(cursor), "team_id": TEAM})

    assert first.json()["issues"] == []
    assert datetime.fromisoformat(first.json()["synced_at"]) == cursor
    assert first.content == second.content


def test_a_quiet_delta_answers_304_to_its_own_etag(client: TestClient, workspace: str) -> None:
    """A poll that sends back the tag of an unchanged answer gets a 304 with no body."""
    sign_in(client, MEMBER)
    create_issue(client, workspace)
    params = {"updated_since": _since(utc_now() + timedelta(seconds=1)), "team_id": TEAM}

    first = client.get(BASE, params=params)
    etag = first.headers["etag"]
    second = client.get(BASE, params=params, headers={"If-None-Match": etag})

    assert first.status_code == 200
    assert etag.startswith('W/"')
    assert second.status_code == 304
    assert second.content == b""
    assert second.headers["etag"] == etag


def test_a_change_answers_a_new_etag_and_the_full_body(client: TestClient, workspace: str) -> None:
    """A stale tag is not honoured once something moved, so the poll reads the change."""
    sign_in(client, MEMBER)
    create_issue(client, workspace)
    cursor = utc_now()
    params = {"updated_since": _since(cursor), "team_id": TEAM}
    stale = client.get(BASE, params=params).headers["etag"]
    fresh = create_issue(client, workspace, title="New")

    response = client.get(BASE, params=params, headers={"If-None-Match": stale})

    assert response.status_code == 200, response.text
    assert response.headers["etag"] != stale
    assert _ids(response.json()) == {fresh["id"]}


def test_a_full_read_carries_no_etag(client: TestClient, workspace: str) -> None:
    """A full read keeps its old contract: a 200 every time, with no validator to send back."""
    sign_in(client, MEMBER)
    create_issue(client, workspace)

    response = client.get(BASE, params={"team_id": TEAM}, headers={"If-None-Match": "*"})

    assert response.status_code == 200
    assert "etag" not in response.headers


def test_an_edit_that_leaves_the_filter_is_reported_as_removed(
    client: TestClient, workspace: str, statuses: "dict[str, Any]"
) -> None:
    """Moving an issue out of the filtered status names it in removed_ids."""
    sign_in(client, MEMBER)
    issue = create_issue(client, workspace)
    cursor = utc_now()
    done = statuses["completed"].status_id
    client.patch(f"{BASE}/{issue['id']}", json={"status_id": done})

    body = _delta(client, cursor, team_id=TEAM, status_id=issue["status_id"])

    assert body["issues"] == []
    assert body["removed_ids"] == [issue["id"]]


def test_archive_and_delete_are_reported_as_removed(client: TestClient, workspace: str) -> None:
    """An archived issue and a deleted one both leave the default list by id."""
    sign_in(client, ADMIN)
    archived = create_issue(client, workspace, title="Archived")
    deleted = create_issue(client, workspace, title="Deleted")
    cursor = utc_now()

    assert client.post(f"{BASE}/{archived['id']}/archive").status_code == 200
    assert client.delete(f"{BASE}/{deleted['id']}").status_code == 204

    body = _delta(client, cursor, team_id=TEAM)

    assert body["issues"] == []
    assert set(body["removed_ids"]) == {archived["id"], deleted["id"]}


def test_a_restore_brings_the_issue_back_in_the_delta(client: TestClient, workspace: str) -> None:
    """Unarchiving counts as a change the default list picks up again."""
    sign_in(client, MEMBER)
    issue = create_issue(client, workspace)
    client.post(f"{BASE}/{issue['id']}/archive")
    cursor = utc_now()
    client.post(f"{BASE}/{issue['id']}/unarchive")

    body = _delta(client, cursor, team_id=TEAM)

    assert _ids(body) == {issue["id"]}


def test_a_rollup_write_is_seen_although_it_leaves_updated_at_alone(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Progress counts come from the consumer and still move the change feed."""
    sign_in(client, MEMBER)
    issue = create_issue(client, workspace)
    cursor = utc_now()
    repositories.issues.set_progress(WORKSPACE, issue["id"], 3, 1)

    body = _delta(client, cursor, team_id=TEAM)

    assert _ids(body) == {issue["id"]}
    assert body["issues"][0]["updated_at"] == issue["updated_at"]
    assert body["issues"][0]["progress"] == {"total": 3, "completed": 1}


def test_a_cursor_older_than_the_tombstones_asks_for_a_resync(client: TestClient, workspace: str) -> None:
    """Deletions before the retention are forgotten, so the delta refuses rather than guessing."""
    sign_in(client, MEMBER)
    create_issue(client, workspace)

    body = _delta(client, utc_now() - TOMBSTONE_RETENTION, team_id=TEAM)

    assert body["resync_required"] is True
    assert body["issues"] == []


def test_a_delta_too_large_to_carry_asks_for_a_resync(
    client: TestClient, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Past the per-team cap the client is told to read the list in full."""
    monkeypatch.setattr(issue_changes, "DELTA_TEAM_CAP", 1)
    sign_in(client, MEMBER)
    cursor = utc_now()
    create_issue(client, workspace)
    create_issue(client, workspace)

    body = _delta(client, cursor, team_id=TEAM)

    assert body["resync_required"] is True
    assert datetime.fromisoformat(body["synced_at"]) == cursor


def test_a_guest_sees_no_other_teams_changes_or_deletions(client: TestClient, workspace: str) -> None:
    """The workspace-wide delta keeps to the caller's teams, tombstones included."""
    sign_in(client, ADMIN)
    cursor = utc_now()
    mine = create_issue(client, workspace, team_id=TEAM)
    hidden = create_issue(client, workspace, team_id=OTHER_TEAM)
    gone = create_issue(client, workspace, team_id=OTHER_TEAM)
    client.delete(f"{BASE}/{gone['id']}")

    sign_in(client, GUEST)
    body = _delta(client, cursor)

    assert _ids(body) == {mine["id"]}
    assert hidden["id"] not in body["removed_ids"]
    assert gone["id"] not in body["removed_ids"]


def test_the_subscribed_delta_drops_issues_the_caller_does_not_follow(client: TestClient, workspace: str) -> None:
    """A delta of My issues' subscribed tab reports an unfollowed change as removed."""
    sign_in(client, MEMBER)
    issue = create_issue(client, workspace)
    cursor = utc_now()
    client.delete(f"{BASE}/{issue['id']}/subscribers/me")
    client.patch(f"{BASE}/{issue['id']}", json={"title": "Renamed"})

    body = _delta(client, cursor, subscriber_id="me")

    assert body["issues"] == []
    assert body["removed_ids"] == [issue["id"]]


def test_recording_a_tombstone_prunes_expired_ones(repositories: Any, workspace: str) -> None:
    """Tombstones past the retention go on the next delete, so the partition stays small."""
    old = Activity(
        ws_issue=tombstone_partition(WORKSPACE),
        activity_id="01A00000000000000000000000",
        workspace_id=WORKSPACE,
        team_id=TEAM,
        issue_id="stale",
        actor_id=MEMBER,
        kind="deleted",
        created_at=utc_now() - TOMBSTONE_RETENTION - timedelta(days=1),
    )
    repositories.activity._repository.put(as_item(old))

    repositories.activity.record_tombstone(WORKSPACE, TEAM, "fresh", MEMBER)

    rows = repositories.activity.tombstones_since(WORKSPACE, datetime(2000, 1, 1).astimezone())
    assert [row.issue_id for row in rows] == ["fresh"]


def test_the_team_purge_removes_that_teams_tombstones(repositories: Any, workspace: str) -> None:
    """A purged team leaves no tombstones behind, and other teams keep theirs."""
    repositories.activity.record_tombstone(WORKSPACE, TEAM, "one", MEMBER)
    repositories.activity.record_tombstone(WORKSPACE, OTHER_TEAM, "two", MEMBER)

    class Job:
        """The two fields the stage reads."""

        workspace_id = WORKSPACE
        team_id = TEAM

    class Forever:
        """A deadline that never expires."""

        def expired(self) -> bool:
            """Never."""
            return False

    assert step(repositories, cast(Any, Job()), cast(Any, Forever())) is None

    rows = repositories.activity.tombstones_since(WORKSPACE, utc_now() - timedelta(minutes=1))
    assert [row.issue_id for row in rows] == ["two"]
