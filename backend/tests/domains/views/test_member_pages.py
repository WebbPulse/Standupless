"""Member page routes: the profile header and the activity feed, against moto.

The properties worth holding are that a person outside the workspace is a 404,
that no email address leaves the profile, that the feed carries only rows on
issues the caller can read, and that its cursor walks both streams exactly once.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo import tables
from app.common.db.dynamo.activity import Activity, ws_issue, ws_team
from app.common.db.dynamo.base import as_item, build_repository
from app.common.db.dynamo.comments import build_comment
from app.common.db.dynamo.issues import Issue
from scripts.backfill_activity_actor_index import run as backfill
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OUTSIDER, OWNER, add_team_member, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM

OPEN_ISSUE = "01JB0000000000000000ISSUE1"
HIDDEN_ISSUE = "01JB0000000000000000ISSUE2"
GONE_ISSUE = "01JB0000000000000000ISSUE3"
START = datetime(2026, 10, 1, 12, 0, 0, tzinfo=UTC)


def _issue(repositories: Any, workspace: str, issue_id: str, team_id: str, number: int) -> None:
    """Put one issue straight into the table."""
    prefix = "ABC" if team_id == TEAM else "XYZ"
    repositories.issues.create(
        Issue(
            workspace_id=workspace,
            issue_id=issue_id,
            team_id=team_id,
            key=f"{prefix}-{number}",
            number=number,
            title=f"Issue {number}",
            status_id="01JB00000000000000000STAT1",
            created_by=OWNER,
        )
    )


def _change(
    repositories: Any, workspace: str, issue_id: str, team_id: str, at: datetime, *, actor_kind: str = "user"
) -> Activity:
    """Record one change by the owner at a fixed time."""
    return repositories.activity.record(
        Activity(
            ws_issue=ws_issue(workspace, issue_id),
            workspace_id=workspace,
            team_id=team_id,
            issue_id=issue_id,
            actor_id=OWNER,
            actor_kind=actor_kind,
            kind="field_changed",
            field="priority",
            from_value="none",
            to_value="high",
            created_at=at,
        )
    )


def _comment(repositories: Any, workspace: str, issue_id: str, team_id: str, at: datetime, body: str) -> Any:
    """Write one comment by the owner at a fixed time."""
    comment = build_comment(workspace, issue_id, team_id, OWNER, body)
    return repositories.comments.create(comment.model_copy(update={"created_at": at}))


def _seed(repositories: Any, workspace: str) -> None:
    """Changes and comments by the owner on a team the guest sees, one it does not, and a deleted issue."""
    _issue(repositories, workspace, OPEN_ISSUE, TEAM, 1)
    _issue(repositories, workspace, HIDDEN_ISSUE, OTHER_TEAM, 1)
    _change(repositories, workspace, OPEN_ISSUE, TEAM, START)
    _comment(repositories, workspace, OPEN_ISSUE, TEAM, START + timedelta(minutes=1), "Looks good")
    _change(repositories, workspace, HIDDEN_ISSUE, OTHER_TEAM, START + timedelta(minutes=2))
    _comment(repositories, workspace, HIDDEN_ISSUE, OTHER_TEAM, START + timedelta(minutes=3), "Secret plans")
    _comment(repositories, workspace, GONE_ISSUE, TEAM, START + timedelta(minutes=4), "On a deleted issue")


def _feed(client: TestClient, workspace: str, user_id: str, **params: Any) -> "dict[str, Any]":
    """Read one page of a member's feed, failing loudly on a refusal."""
    response = client.get(f"/api/workspaces/{workspace}/views/members/{user_id}/activity", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_the_profile_names_the_member_without_an_email(client: TestClient, workspace: str, repositories: Any) -> None:
    """Name, role and teams come back, and nothing that looks like an address."""
    add_team_member(repositories, workspace, TEAM, MEMBER, "member")
    sign_in(client, OWNER)
    response = client.get(f"/api/workspaces/{workspace}/views/members/{MEMBER}")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["user_id"] == MEMBER
    assert body["role"] == "member"
    assert body["team_ids"] == [TEAM]
    assert "email" not in body
    assert "@" not in response.text


def test_the_profile_hides_teams_the_caller_cannot_see(client: TestClient, workspace: str, repositories: Any) -> None:
    """A guest sees the member's teams they share, not the rest."""
    add_team_member(repositories, workspace, TEAM, MEMBER, "member")
    add_team_member(repositories, workspace, OTHER_TEAM, MEMBER, "member")
    sign_in(client, OWNER)
    assert client.get(f"/api/workspaces/{workspace}/views/members/{MEMBER}").json()["team_ids"] == sorted(
        [TEAM, OTHER_TEAM]
    )
    sign_in(client, GUEST)
    assert client.get(f"/api/workspaces/{workspace}/views/members/{MEMBER}").json()["team_ids"] == [TEAM]


def test_the_profile_carries_the_members_timezone(client: TestClient, workspace: str, repositories: Any) -> None:
    """The zone the member set comes back, and null for someone who set none."""
    add_team_member(repositories, workspace, TEAM, MEMBER, "member")
    repositories.users.update(MEMBER, timezone="Asia/Tokyo")
    sign_in(client, OWNER)
    assert client.get(f"/api/workspaces/{workspace}/views/members/{MEMBER}").json()["timezone"] == "Asia/Tokyo"
    assert client.get(f"/api/workspaces/{workspace}/views/members/{ADMIN}").json()["timezone"] is None


def test_a_guest_reads_no_timezone_for_someone_outside_their_teams(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """The timezone follows the status rule, so a guest sharing no team with the member sees none."""
    add_team_member(repositories, workspace, OTHER_TEAM, MEMBER, "member")
    repositories.users.update(MEMBER, timezone="Asia/Tokyo")
    sign_in(client, GUEST)
    body = client.get(f"/api/workspaces/{workspace}/views/members/{MEMBER}").json()
    assert body["team_ids"] == []
    assert body["timezone"] is None


def test_me_is_the_caller(client: TestClient, workspace: str) -> None:
    """`me` reads the caller's own page."""
    sign_in(client, MEMBER)
    assert client.get(f"/api/workspaces/{workspace}/views/members/me").json()["user_id"] == MEMBER


def test_someone_outside_the_workspace_is_not_found(client: TestClient, workspace: str) -> None:
    """Both routes answer 404 for a person who is not a member."""
    sign_in(client, OWNER)
    assert client.get(f"/api/workspaces/{workspace}/views/members/{OUTSIDER}").status_code == 404
    assert client.get(f"/api/workspaces/{workspace}/views/members/{OUTSIDER}/activity").status_code == 404


def test_the_feed_shows_only_issues_the_caller_can_read(client: TestClient, workspace: str, repositories: Any) -> None:
    """The owner sees both teams, the guest one, and nobody sees the deleted issue."""
    _seed(repositories, workspace)

    sign_in(client, OWNER)
    rows = _feed(client, workspace, OWNER)["activity"]
    assert [(row["type"], row["issue_id"]) for row in rows] == [
        ("comment", HIDDEN_ISSUE),
        ("issue_change", HIDDEN_ISSUE),
        ("comment", OPEN_ISSUE),
        ("issue_change", OPEN_ISSUE),
    ]
    assert rows[2]["comment"]["body"] == "Looks good"
    assert rows[2]["issue_key"] == "ABC-1"
    assert rows[3]["activity"]["field"] == "priority"

    sign_in(client, GUEST)
    rows = _feed(client, workspace, OWNER)["activity"]
    assert {row["issue_id"] for row in rows} == {OPEN_ISSUE}
    assert "Secret plans" not in str(rows)


def test_a_private_team_stays_out_of_an_outsiders_feed(client: TestClient, workspace: str, repositories: Any) -> None:
    """Once a team is private, its rows drop from the feed of anyone outside it."""
    _seed(repositories, workspace)
    add_team_member(repositories, workspace, OTHER_TEAM, OWNER, "member")
    repositories.memberships.set_team_private(workspace, OTHER_TEAM, True)

    sign_in(client, MEMBER)
    rows = _feed(client, workspace, OWNER)["activity"]
    assert {row["issue_id"] for row in rows} == {OPEN_ISSUE}


def test_only_the_persons_own_changes_join_the_feed(client: TestClient, workspace: str, repositories: Any) -> None:
    """A GitHub row carrying their id is not something they did."""
    _issue(repositories, workspace, OPEN_ISSUE, TEAM, 1)
    _change(repositories, workspace, OPEN_ISSUE, TEAM, START, actor_kind="github")
    sign_in(client, OWNER)
    assert _feed(client, workspace, OWNER)["activity"] == []


def test_the_cursor_walks_both_streams_once(client: TestClient, workspace: str, repositories: Any) -> None:
    """Paging two at a time returns every row, newest first, with none repeated."""
    _issue(repositories, workspace, OPEN_ISSUE, TEAM, 1)
    for minute in range(5):
        at = START + timedelta(minutes=minute)
        if minute % 2:
            _comment(repositories, workspace, OPEN_ISSUE, TEAM, at, f"Comment {minute}")
        else:
            _change(repositories, workspace, OPEN_ISSUE, TEAM, at)
    _change(repositories, workspace, OPEN_ISSUE, TEAM, START + timedelta(minutes=2))

    sign_in(client, OWNER)
    everything = [row["id"] for row in _feed(client, workspace, OWNER, limit=100)["activity"]]
    assert len(everything) == 6

    walked: list[str] = []
    cursor = None
    for _ in range(10):
        params: "dict[str, Any]" = {"limit": 2}
        if cursor:
            params["cursor"] = cursor
        page = _feed(client, workspace, OWNER, **params)
        walked += [row["id"] for row in page["activity"]]
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert walked == everything
    stamps = [row["created_at"] for row in _feed(client, workspace, OWNER, limit=100)["activity"]]
    assert stamps == sorted(stamps, reverse=True)


def test_the_backfill_stamps_older_rows_into_the_feed(client: TestClient, workspace: str, repositories: Any) -> None:
    """A row written before the index joins the feed after one run, and a second run writes nothing."""
    _issue(repositories, workspace, OPEN_ISSUE, TEAM, 1)
    old = Activity(
        ws_issue=ws_issue(workspace, OPEN_ISSUE),
        workspace_id=workspace,
        team_id=TEAM,
        issue_id=OPEN_ISSUE,
        actor_id=OWNER,
        kind="created",
        created_at=START,
    )
    table = build_repository(tables.ACTIVITY)
    table.put(as_item(old, ws_team=ws_team(workspace, TEAM)))
    sign_in(client, OWNER)
    assert _feed(client, workspace, OWNER)["activity"] == []

    first = backfill(repositories.activity, table.iter_scan(), [workspace], dry_run=False)
    assert first.stamped == 1
    assert [row["id"] for row in _feed(client, workspace, OWNER)["activity"]] == [old.activity_id]

    second = backfill(repositories.activity, table.iter_scan(), [workspace], dry_run=False)
    assert second.stamped == 0
