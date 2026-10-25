"""View subscription routes: following a saved view to hear when issues enter it.

The properties held here are that following is the caller's own and idempotent,
that the view answers whether the caller follows it and how many do, that a view
the caller cannot read refuses a follow as missing, that a projects view refuses
one outright, and that deleting a view drops everyone's subscription to it.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, MEMBER, OWNER, sign_in
from tests.domains.views.test_saved_views import create_view


def subscription(client: TestClient, workspace: str, view_id: str) -> str:
    """The route that follows or unfollows one view."""
    return f"/api/workspaces/{workspace}/views/{view_id}/subscription"


def read_view(client: TestClient, workspace: str, view_id: str) -> "dict[str, Any]":
    """One view as the caller reads it, failing loudly on a refusal."""
    response = client.get(f"/api/workspaces/{workspace}/views/{view_id}")
    assert response.status_code == 200, response.text
    return response.json()


def test_following_a_view_marks_it_and_counts_the_follower(client: TestClient, workspace: str) -> None:
    """The follow answers the view flagged as followed with one follower."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, name="Shared", shared=True)

    response = client.put(subscription(client, workspace, view["view_id"]))

    assert response.status_code == 200, response.text
    assert response.json()["subscribed"] is True
    assert response.json()["subscriber_count"] == 1
    assert read_view(client, workspace, view["view_id"])["subscribed"] is True


def test_following_twice_keeps_one_subscription(client: TestClient, workspace: str) -> None:
    """A double press is never an error and never counts the follower twice."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, name="Shared", shared=True)

    client.put(subscription(client, workspace, view["view_id"]))
    again = client.put(subscription(client, workspace, view["view_id"]))

    assert again.status_code == 200, again.text
    assert again.json()["subscriber_count"] == 1


def test_another_member_sees_the_count_but_not_the_flag(client: TestClient, workspace: str) -> None:
    """The follow is the follower's own, while the count is shared with every reader."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, name="Shared", shared=True)
    client.put(subscription(client, workspace, view["view_id"]))

    sign_in(client, ADMIN)
    read = read_view(client, workspace, view["view_id"])

    assert read["subscribed"] is False
    assert read["subscriber_count"] == 1


def test_the_listing_answers_the_flag_and_count(client: TestClient, workspace: str) -> None:
    """The views list draws the bell from the same fields a single read answers."""
    sign_in(client, MEMBER)
    followed = create_view(client, workspace, name="Followed", shared=True)
    create_view(client, workspace, name="Quiet", shared=True)
    client.put(subscription(client, workspace, followed["view_id"]))

    response = client.get(f"/api/workspaces/{workspace}/views", params={"scope": "all"})

    assert response.status_code == 200, response.text
    rows = {row["name"]: row for row in response.json()["views"]}
    assert (rows["Followed"]["subscribed"], rows["Followed"]["subscriber_count"]) == (True, 1)
    assert (rows["Quiet"]["subscribed"], rows["Quiet"]["subscriber_count"]) == (False, 0)


def test_unfollowing_clears_the_flag_and_the_count(client: TestClient, workspace: str) -> None:
    """Unfollowing drops the subscription, and unfollowing again is a no-op."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, name="Shared", shared=True)
    client.put(subscription(client, workspace, view["view_id"]))

    first = client.delete(subscription(client, workspace, view["view_id"]))
    second = client.delete(subscription(client, workspace, view["view_id"]))

    assert first.status_code == 200, first.text
    assert (first.json()["subscribed"], first.json()["subscriber_count"]) == (False, 0)
    assert second.status_code == 200, second.text


def test_a_view_the_caller_cannot_read_refuses_a_follow_as_missing(client: TestClient, workspace: str) -> None:
    """Another member's personal view is not there to follow, so its existence does not leak."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, name="Just mine")

    sign_in(client, OWNER)
    response = client.put(subscription(client, workspace, view["view_id"]))

    assert response.status_code == 404, response.text


def test_a_projects_view_refuses_a_follow(client: TestClient, workspace: str) -> None:
    """Projects never enter a view the way issues do, so there is nothing to follow."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, name="Projects", entity="projects")

    response = client.put(subscription(client, workspace, view["view_id"]))

    assert response.status_code == 422, response.text


def test_deleting_a_view_drops_its_subscriptions(client: TestClient, workspace: str, repositories: Any) -> None:
    """A deleted view leaves no subscription behind for the consumer to chase."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, name="Shared", shared=True)
    client.put(subscription(client, workspace, view["view_id"]))
    sign_in(client, ADMIN)
    client.put(subscription(client, workspace, view["view_id"]))

    sign_in(client, MEMBER)
    response = client.delete(f"/api/workspaces/{workspace}/views/{view['view_id']}")

    assert response.status_code in (200, 204), response.text
    assert repositories.views.subscriber_ids(workspace, view["view_id"]) == []
