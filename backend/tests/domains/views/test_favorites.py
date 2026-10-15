"""Favorites routes: a member's own starred issues, teams, views and the rest, in their order.

The properties held here are that a favorite is its member's alone, that a target
the caller cannot read is refused on add and dropped from the listing, that a
favorite answers its target's current title and key, and that reordering never
loses a favorite the order left out.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import GUEST, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM, seed_issue


def favorites(client: TestClient, workspace: str) -> "list[dict[str, Any]]":
    """The caller's favorites listing, failing loudly on a refusal."""
    response = client.get(f"/api/workspaces/{workspace}/favorites")
    assert response.status_code == 200, response.text
    return response.json()["favorites"]


def star(client: TestClient, workspace: str, **payload: Any) -> Any:
    """Star one target through the route."""
    return client.post(f"/api/workspaces/{workspace}/favorites", json=payload)


def test_an_issue_favorite_answers_its_key_title_and_status(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """The sidebar draws an issue from its current key and status, read at listing time."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace, title="Fix the login")
    sign_in(client, MEMBER)

    added = star(client, workspace, kind="issue", target_id=issue["issue_id"])

    assert added.status_code == 200, added.text
    listed = favorites(client, workspace)
    assert [(row["kind"], row["target_id"]) for row in listed] == [("issue", issue["issue_id"])]
    assert listed[0]["title"] == "Fix the login"
    assert listed[0]["issue_key"] == issue["key"]
    assert listed[0]["status"]["status_id"] == issue["status_id"]


def test_favorites_are_the_callers_own(client: TestClient, workspace: str) -> None:
    """One member's star never shows in another member's listing."""
    sign_in(client, MEMBER)
    star(client, workspace, kind="team", target_id=TEAM)

    sign_in(client, OWNER)

    assert favorites(client, workspace) == []


def test_starring_twice_keeps_one_favorite_in_place(client: TestClient, workspace: str) -> None:
    """A double press is never an error and never duplicates or moves the favorite."""
    sign_in(client, MEMBER)
    star(client, workspace, kind="team", target_id=TEAM)
    star(client, workspace, kind="team", target_id=OTHER_TEAM)

    again = star(client, workspace, kind="team", target_id=TEAM)

    assert again.status_code == 200
    assert [row["target_id"] for row in favorites(client, workspace)] == [TEAM, OTHER_TEAM]


def test_a_target_the_caller_cannot_read_is_refused(client: TestClient, workspace: str) -> None:
    """A guest cannot star a team they are outside, and the answer is the same as for nothing at all."""
    sign_in(client, GUEST)

    hidden = star(client, workspace, kind="team", target_id=OTHER_TEAM)
    missing = star(client, workspace, kind="project", target_id="01JB00000000000000000NOPE")

    assert hidden.status_code == 404
    assert missing.status_code == 404
    assert favorites(client, workspace) == []


def test_a_cycle_needs_its_team(client: TestClient, workspace: str) -> None:
    """A cycle is keyed under its team, so starring one without the team is refused."""
    sign_in(client, MEMBER)

    response = star(client, workspace, kind="cycle", target_id="01JB0000000000000000CYCLE")

    assert response.status_code == 422


def test_an_unknown_kind_is_refused(client: TestClient, workspace: str) -> None:
    """Only the kinds the sidebar can draw are stored."""
    sign_in(client, MEMBER)

    response = star(client, workspace, kind="comment", target_id="x")

    assert response.status_code == 422


def test_deleting_a_starred_view_drops_it_from_favorites(client: TestClient, workspace: str, repositories: Any) -> None:
    """A deleted view leaves no dangling favorite, and the other favorites stay in place."""
    sign_in(client, MEMBER)
    star(client, workspace, kind="team", target_id=OTHER_TEAM)
    view = client.post(f"/api/workspaces/{workspace}/views", json={"name": "Mine"}).json()
    star(client, workspace, kind="view", target_id=view["view_id"])

    client.delete(f"/api/workspaces/{workspace}/views/{view['view_id']}")

    assert [row["kind"] for row in favorites(client, workspace)] == ["team"]
    stored = repositories.views.favorite_items(workspace, MEMBER)
    assert [(row.kind, row.target_id) for row in stored] == [("team", OTHER_TEAM)]


def test_removing_a_favorite_never_reads_its_target(client: TestClient, workspace: str, repositories: Any) -> None:
    """A favorite on something gone can still be cleared, and removing twice is a no-op."""
    sign_in(client, MEMBER)
    star(client, workspace, kind="team", target_id=TEAM)
    path = f"/api/workspaces/{workspace}/favorites/team/{TEAM}"

    assert client.delete(path).status_code == 204
    assert client.delete(path).status_code == 204
    assert client.delete(f"/api/workspaces/{workspace}/favorites/issue/01JB0000000000000000000GONE").status_code == 204
    assert repositories.views.favorite_items(workspace, MEMBER) == []


def test_reordering_keeps_favorites_the_order_left_out(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """The named favorites come first, the rest follow in their old order, and strangers are ignored."""
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)
    sign_in(client, MEMBER)
    star(client, workspace, kind="team", target_id=TEAM)
    star(client, workspace, kind="team", target_id=OTHER_TEAM)
    star(client, workspace, kind="issue", target_id=issue["issue_id"])

    response = client.put(
        f"/api/workspaces/{workspace}/favorites/order",
        json={
            "items": [
                {"kind": "issue", "target_id": issue["issue_id"]},
                {"kind": "project", "target_id": "01JB0000000000000000000NOT"},
                {"kind": "team", "target_id": OTHER_TEAM},
            ]
        },
    )

    assert response.status_code == 200, response.text
    order = [row["target_id"] for row in response.json()["favorites"]]
    assert order == [issue["issue_id"], OTHER_TEAM, TEAM]
    assert [row["target_id"] for row in favorites(client, workspace)] == order


def test_a_starred_view_shows_in_both_favorites_and_the_view_listing(client: TestClient, workspace: str) -> None:
    """The view star route and the favorites routes share one row, so the two never disagree."""
    sign_in(client, MEMBER)
    view = client.post(f"/api/workspaces/{workspace}/views", json={"name": "Starred"}).json()

    client.put(f"/api/workspaces/{workspace}/views/{view['view_id']}/favorite")

    assert [(row["kind"], row["title"]) for row in favorites(client, workspace)] == [("view", "Starred")]
    read = client.get(f"/api/workspaces/{workspace}/views/{view['view_id']}").json()
    assert read["favorite"] is True

    client.delete(f"/api/workspaces/{workspace}/favorites/view/{view['view_id']}")

    read = client.get(f"/api/workspaces/{workspace}/views/{view['view_id']}").json()
    assert read["favorite"] is False


def test_a_row_written_before_favorites_held_kinds_reads_as_view_favorites(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """An existing star on a view keeps working after the row gained kinds."""
    from app.common.db.dynamo.base import as_item
    from app.common.db.dynamo.views import FavoriteViews

    sign_in(client, MEMBER)
    view = client.post(f"/api/workspaces/{workspace}/views", json={"name": "Old star"}).json()
    legacy = FavoriteViews(
        workspace_id=workspace,
        view_key=f"fav#{MEMBER}",
        user_id=MEMBER,
        view_ids=[view["view_id"]],
    )
    repositories.views._repository.put(as_item(legacy))

    assert [row["target_id"] for row in favorites(client, workspace)] == [view["view_id"]]


def test_a_favorite_on_a_team_the_guest_leaves_drops_out_but_is_kept(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Losing access hides the favorite rather than leaking its name, and the row keeps it for a return."""
    sign_in(client, GUEST)
    star(client, workspace, kind="team", target_id=TEAM)

    repositories.memberships.delete_team_membership(workspace, TEAM, GUEST)

    assert favorites(client, workspace) == []
    stored = repositories.views.favorite_items(workspace, GUEST)
    assert [(row.kind, row.target_id) for row in stored] == [("team", TEAM)]
