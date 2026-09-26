"""Issue subscribers: who an issue write subscribes, and the routes to follow or leave.

Subscriptions are written by the domain that owns the write, so these tests drive
the issues routes and read the `subscriptions` table back. The fan-out that reads
them lives in the views notify consumer and is tested there.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, make_user, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, create_issue


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
