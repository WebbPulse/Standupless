"""Issue subscribers: who an issue write subscribes, and the routes to follow or leave.

Subscriptions are written by the domain that owns the write, so these tests drive
the issues routes and read the `subscriptions` table back. The fan-out that reads
them lives in the views notify consumer and is tested there.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_team_member, make_user, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, WORKSPACE, create_issue


@pytest.fixture
def people(repositories: Any, workspace: str) -> str:
    """Named users for every role, so `@member` and `@admin` resolve to someone."""
    make_user(repositories, OWNER, "owner@example.com", "Olive Owner")
    make_user(repositories, ADMIN, "admin@example.com", "Adam Admin")
    make_user(repositories, MEMBER, "member@example.com", "Mo Member")
    make_user(repositories, GUEST, "guest@example.com", "Gale Guest")
    return workspace


def reasons(repositories: Any, workspace: str, issue_id: str) -> "dict[str, str]":
    """Each subscriber of one issue mapped to the reason they first followed it."""
    return {row.user_id: row.reason for row in repositories.subscriptions.list_for_issue(workspace, issue_id)}


def test_creating_an_issue_subscribes_its_creator_assignee_and_mentions(
    client: TestClient, people: str, repositories: Any
) -> None:
    """A new issue is followed by whoever it already involves."""
    sign_in(client, OWNER)
    issue = create_issue(client, people, assignee_id=MEMBER, body="Looping in @admin")

    assert reasons(repositories, people, issue["id"]) == {
        OWNER: "creator",
        MEMBER: "assignee",
        ADMIN: "mentioned",
    }
    stored = repositories.issues.get(people, issue["id"])
    assert stored.mentioned_user_ids == [ADMIN]
    assert stored.updated_by == OWNER


def test_an_update_subscribes_a_new_assignee_and_new_mentions_only(
    client: TestClient, people: str, repositories: Any
) -> None:
    """Someone who left the issue is not pulled back by an edit that still names them."""
    sign_in(client, OWNER)
    issue = create_issue(client, people, body="cc @admin")
    client.delete(f"/api/workspaces/{people}/issues/{issue['id']}/subscribers/me")
    repositories.subscriptions.unsubscribe(people, issue["id"], ADMIN)

    response = client.patch(
        f"/api/workspaces/{people}/issues/{issue['id']}",
        json={"body": "cc @admin and @member", "assignee_id": GUEST},
    )
    assert response.status_code == 200, response.text

    assert reasons(repositories, people, issue["id"]) == {MEMBER: "mentioned", GUEST: "assignee"}
    assert repositories.issues.get(people, issue["id"]).mentioned_user_ids == [ADMIN, MEMBER]


def test_the_subscribe_routes_round_trip(client: TestClient, people: str) -> None:
    """Following and leaving an issue is reflected in the list and in `subscribed`."""
    sign_in(client, OWNER)
    issue = create_issue(client, people)
    path = f"/api/workspaces/{people}/issues/{issue['id']}/subscribers"

    sign_in(client, ADMIN)
    before = client.get(path).json()
    assert before["subscribed"] is False
    assert [row["user_id"] for row in before["subscribers"]] == [OWNER]
    assert before["subscribers"][0]["display_name"] == "Olive Owner"

    joined = client.put(f"{path}/me")
    assert joined.status_code == 200, joined.text
    assert joined.json()["subscribed"] is True
    assert [row["user_id"] for row in joined.json()["subscribers"]] == [OWNER, ADMIN]
    assert joined.json()["subscribers"][1]["reason"] == "manual"

    assert client.put(f"{path}/me").json()["subscribed"] is True

    left = client.delete(f"{path}/me")
    assert left.status_code == 200, left.text
    assert left.json()["subscribed"] is False
    assert client.delete(f"{path}/me").status_code == 200


def test_a_guest_cannot_follow_an_issue_in_a_team_they_are_outside(client: TestClient, people: str) -> None:
    """The routes answer 404 for an invisible issue, exactly as reading it does."""
    sign_in(client, OWNER)
    hidden = create_issue(client, people, team_id=OTHER_TEAM)
    path = f"/api/workspaces/{people}/issues/{hidden['id']}/subscribers"

    sign_in(client, GUEST)
    assert client.get(path).status_code == 404
    assert client.put(f"{path}/me").status_code == 404
    assert client.delete(f"{path}/me").status_code == 404


def test_deleting_an_issue_removes_its_subscriptions(client: TestClient, people: str, repositories: Any) -> None:
    """Nothing but the issue names the partition, so its rows go with it."""
    sign_in(client, OWNER)
    issue = create_issue(client, people, assignee_id=MEMBER)

    response = client.delete(f"/api/workspaces/{people}/issues/{issue['id']}")
    assert response.status_code == 204, response.text

    assert repositories.subscriptions.list_for_issue(people, issue["id"]) == []


def subscriber_activity(repositories: Any, workspace: str, issue_id: str) -> "list[tuple[str, str, Any, Any]]":
    """The subscriber history rows of one issue as (kind, actor, from, to), oldest first."""
    rows = repositories.activity.list_for_issue(workspace, issue_id, limit=50).items
    picked = [row for row in rows if str(row["kind"]).startswith("subscriber_")]
    return [(row["kind"], row["actor_id"], row.get("from_value"), row.get("to_value")) for row in reversed(picked)]


def test_a_member_subscribes_and_unsubscribes_a_teammate(client: TestClient, people: str, repositories: Any) -> None:
    """Naming someone else writes their row with `added_by` and records who did it."""
    sign_in(client, OWNER)
    issue = create_issue(client, people)
    path = f"/api/workspaces/{people}/issues/{issue['id']}/subscribers"

    added = client.put(f"{path}/{MEMBER}")
    assert added.status_code == 200, added.text
    assert added.json()["subscribed"] is True
    assert [row["user_id"] for row in added.json()["subscribers"]] == [OWNER, MEMBER]
    row = repositories.subscriptions.get(people, issue["id"], MEMBER)
    assert row.reason == "manual"
    assert row.added_by == OWNER

    assert client.put(f"{path}/{MEMBER}").status_code == 200

    removed = client.delete(f"{path}/{MEMBER}")
    assert removed.status_code == 200, removed.text
    assert [row["user_id"] for row in removed.json()["subscribers"]] == [OWNER]
    assert client.delete(f"{path}/{MEMBER}").status_code == 200

    assert subscriber_activity(repositories, people, issue["id"]) == [
        ("subscriber_added", OWNER, None, MEMBER),
        ("subscriber_removed", OWNER, MEMBER, None),
    ]
    history = client.get(f"/api/workspaces/{people}/issues/{issue['id']}/activity").json()["activity"]
    assert {"subscriber_added", "subscriber_removed"} <= {row["kind"] for row in history}


def test_subscribing_yourself_by_id_records_no_history_and_no_added_by(
    client: TestClient, people: str, repositories: Any
) -> None:
    """Your own id is the same as `me`, which is not news for anyone."""
    sign_in(client, OWNER)
    issue = create_issue(client, people)
    path = f"/api/workspaces/{people}/issues/{issue['id']}/subscribers"

    sign_in(client, ADMIN)
    assert client.put(f"{path}/{ADMIN}").json()["subscribed"] is True
    assert repositories.subscriptions.get(people, issue["id"], ADMIN).added_by is None
    assert client.delete(f"{path}/{ADMIN}").json()["subscribed"] is False
    assert subscriber_activity(repositories, people, issue["id"]) == []


def test_only_someone_who_can_see_the_issue_can_be_subscribed(
    client: TestClient, people: str, repositories: Any
) -> None:
    """A guest outside the team and a stranger to the workspace are refused with a 422."""
    sign_in(client, OWNER)
    issue = create_issue(client, people, team_id=OTHER_TEAM)
    path = f"/api/workspaces/{people}/issues/{issue['id']}/subscribers"

    refused = client.put(f"{path}/{GUEST}")
    assert refused.status_code == 422, refused.text
    assert client.put(f"{path}/01JB000000000000000NOBODY1").status_code == 422
    assert repositories.subscriptions.get(people, issue["id"], GUEST) is None
    assert subscriber_activity(repositories, people, issue["id"]) == []


def test_a_private_team_issue_takes_only_its_members(client: TestClient, people: str, repositories: Any) -> None:
    """A workspace member outside a private team cannot be subscribed to its issues."""
    repositories.memberships.set_team_private(WORKSPACE, OTHER_TEAM, True)
    add_team_member(repositories, WORKSPACE, OTHER_TEAM, OWNER, "admin")
    add_team_member(repositories, WORKSPACE, OTHER_TEAM, ADMIN, "member")
    sign_in(client, OWNER)
    issue = create_issue(client, people, team_id=OTHER_TEAM)
    path = f"/api/workspaces/{people}/issues/{issue['id']}/subscribers"

    assert client.put(f"{path}/{MEMBER}").status_code == 422
    assert client.put(f"{path}/{ADMIN}").status_code == 200


def test_a_guest_can_subscribe_a_teammate_on_an_issue_they_see(
    client: TestClient, people: str, repositories: Any
) -> None:
    """A guest acts within the issues they can read, and is refused the rest."""
    sign_in(client, OWNER)
    visible = create_issue(client, people)
    hidden = create_issue(client, people, team_id=OTHER_TEAM)

    sign_in(client, GUEST)
    added = client.put(f"/api/workspaces/{people}/issues/{visible['id']}/subscribers/{MEMBER}")
    assert added.status_code == 200, added.text
    assert repositories.subscriptions.get(people, visible["id"], MEMBER).added_by == GUEST
    assert client.put(f"/api/workspaces/{people}/issues/{hidden['id']}/subscribers/{MEMBER}").status_code == 404


def test_someone_removed_by_a_teammate_is_not_re_added_by_an_unrelated_edit(
    client: TestClient, people: str, repositories: Any
) -> None:
    """Only new events subscribe, so an edit that still names them leaves them out."""
    sign_in(client, OWNER)
    issue = create_issue(client, people, assignee_id=MEMBER, body="cc @member")
    client.delete(f"/api/workspaces/{people}/issues/{issue['id']}/subscribers/{MEMBER}")

    response = client.patch(f"/api/workspaces/{people}/issues/{issue['id']}", json={"title": "Renamed"})
    assert response.status_code == 200, response.text

    assert MEMBER not in reasons(repositories, people, issue["id"])
