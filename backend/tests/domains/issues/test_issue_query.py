"""The list route's multi-value filters, sentinels, negations and manual order.

These drive the route with repeated query keys, which is how the frontend client
serializes an array, so the tests hold the wire form rather than only the filter
object behind it.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import GUEST, MEMBER, OWNER, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, create_issue


def _ids(body: Any) -> "set[str]":
    """The ids of a list response as a set, for filters where order is not the point."""
    return {row["id"] for row in body["issues"]}


def _label(repositories: Any, workspace: str, name: str) -> str:
    """Seed one label on `TEAM` and answer its id."""
    from app.common.db.dynamo.team_config import Label, label_key, new_config_id

    label_id = new_config_id()
    repositories.team_config.create_label(
        Label(
            workspace_id=workspace,
            config_key=label_key(TEAM, label_id),
            team_id=TEAM,
            label_id=label_id,
            name=name,
            color="#ff0000",
        )
    )
    return label_id


def test_repeated_status_ids_are_any_of(client: TestClient, workspace: str, statuses: Any) -> None:
    """`status_id=a&status_id=b` answers issues in either status."""
    sign_in(client, OWNER)
    started = create_issue(client, workspace, status_id=statuses["started"].status_id)
    done = create_issue(client, workspace, status_id=statuses["completed"].status_id)
    create_issue(client, workspace, status_id=statuses["backlog"].status_id)

    listed = client.get(
        f"/api/workspaces/{workspace}/issues",
        params=[("status_id", statuses["started"].status_id), ("status_id", statuses["completed"].status_id)],
    ).json()

    assert _ids(listed) == {started["id"], done["id"]}


def test_status_id_not_excludes(client: TestClient, workspace: str, statuses: Any) -> None:
    """The negation form drops the named statuses and keeps the rest."""
    sign_in(client, OWNER)
    create_issue(client, workspace, status_id=statuses["completed"].status_id)
    kept = create_issue(client, workspace, status_id=statuses["started"].status_id)

    listed = client.get(
        f"/api/workspaces/{workspace}/issues",
        params={"team_id": TEAM, "status_id_not": statuses["completed"].status_id},
    ).json()

    assert _ids(listed) == {kept["id"]}


def test_status_category_filters_across_teams(
    client: TestClient, workspace: str, statuses: Any, repositories: Any
) -> None:
    """A category spans teams, whose statuses have different ids for the same category."""
    other = {row.category: row for row in repositories.team_config.list_statuses(workspace, OTHER_TEAM)}
    sign_in(client, OWNER)
    here = create_issue(client, workspace, status_id=statuses["cancelled"].status_id)
    there = create_issue(client, workspace, team_id=OTHER_TEAM, status_id=other["completed"].status_id)
    create_issue(client, workspace, status_id=statuses["started"].status_id)

    base = f"/api/workspaces/{workspace}/issues"
    listed = client.get(base, params=[("status_category", "completed"), ("status_category", "canceled")]).json()
    excluded = client.get(base, params={"status_category_not": "started"}).json()

    assert _ids(listed) == {here["id"], there["id"]}
    assert _ids(excluded) == {here["id"], there["id"]}


def test_an_unknown_status_category_is_a_422(client: TestClient, workspace: str, statuses: Any) -> None:
    """A misspelt category is refused rather than answering an empty list."""
    sign_in(client, OWNER)

    response = client.get(f"/api/workspaces/{workspace}/issues", params={"status_category": "finished"})

    assert response.status_code == 422


def test_assignee_none_and_me_combine(client: TestClient, workspace: str, statuses: Any) -> None:
    """ "Mine or unassigned" is one request, and anyone else's issue stays out."""
    sign_in(client, OWNER)
    mine = create_issue(client, workspace, assignee_id=OWNER)
    unassigned = create_issue(client, workspace)
    create_issue(client, workspace, assignee_id=MEMBER)

    listed = client.get(f"/api/workspaces/{workspace}/issues", params=[("assignee_id", "me"), ("assignee_id", "none")])

    assert _ids(listed.json()) == {mine["id"], unassigned["id"]}


def test_labels_are_any_of_with_a_negation(
    client: TestClient, workspace: str, statuses: Any, repositories: Any
) -> None:
    """Any-of on `label_id`, none-of on `label_id_not`, and `none` for unlabelled."""
    bug = _label(repositories, workspace, "Bug")
    ui = _label(repositories, workspace, "UI")
    wontfix = _label(repositories, workspace, "Wontfix")
    sign_in(client, OWNER)
    bug_issue = create_issue(client, workspace, label_ids=[bug])
    ui_issue = create_issue(client, workspace, label_ids=[ui])
    dropped = create_issue(client, workspace, label_ids=[bug, wontfix])
    bare = create_issue(client, workspace)

    base = f"/api/workspaces/{workspace}/issues"
    any_of = client.get(base, params=[("label_id", bug), ("label_id", ui)]).json()
    without = client.get(base, params=[("label_id", bug), ("label_id_not", wontfix)]).json()
    unlabelled = client.get(base, params={"label_id": "none"}).json()

    assert _ids(any_of) == {bug_issue["id"], ui_issue["id"], dropped["id"]}
    assert _ids(without) == {bug_issue["id"]}
    assert _ids(unlabelled) == {bare["id"]}


def test_repeated_priorities_are_any_of(client: TestClient, workspace: str, statuses: Any) -> None:
    """Priority repeats like the id filters do."""
    sign_in(client, OWNER)
    urgent = create_issue(client, workspace, priority="urgent")
    high = create_issue(client, workspace, priority="high")
    create_issue(client, workspace, priority="low")

    listed = client.get(f"/api/workspaces/{workspace}/issues", params=[("priority", "urgent"), ("priority", "high")])

    assert _ids(listed.json()) == {urgent["id"], high["id"]}


def test_parent_none_lists_top_level_issues(client: TestClient, workspace: str, statuses: Any) -> None:
    """`parent_id=none` hides sub-issues, which is the default list most views want."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent")
    create_issue(client, workspace, title="Child", parent_id=parent["id"])

    listed = client.get(f"/api/workspaces/{workspace}/issues", params={"parent_id": "none"}).json()

    assert _ids(listed) == {parent["id"]}


def test_project_and_cycle_none_list_the_unattached(client: TestClient, workspace: str, statuses: Any) -> None:
    """With nothing attached, `none` matches every issue and an id matches none."""
    sign_in(client, OWNER)
    created = create_issue(client, workspace)

    base = f"/api/workspaces/{workspace}/issues"
    assert _ids(client.get(base, params={"project_id": "none", "cycle_id": "none"}).json()) == {created["id"]}
    assert _ids(client.get(base, params={"project_id": "01JB00000000000000000PROJ"}).json()) == set()
    assert _ids(client.get(base, params={"cycle_id_not": "none"}).json()) == set()


def test_a_guest_filtering_by_status_never_sees_the_other_team(
    client: TestClient, workspace: str, statuses: Any, repositories: Any
) -> None:
    """A filter narrows what the caller may see; it never widens it."""
    other = {row.category: row for row in repositories.team_config.list_statuses(workspace, OTHER_TEAM)}
    sign_in(client, OWNER)
    create_issue(client, workspace, team_id=OTHER_TEAM, status_id=other["backlog"].status_id)
    visible = create_issue(client, workspace, status_id=statuses["backlog"].status_id)

    sign_in(client, GUEST)
    listed = client.get(
        f"/api/workspaces/{workspace}/issues",
        params=[("status_category", "backlog"), ("status_id", other["backlog"].status_id)],
    ).json()
    unfiltered = client.get(f"/api/workspaces/{workspace}/issues", params={"status_category": "backlog"}).json()

    assert _ids(listed) == set()
    assert _ids(unfiltered) == {visible["id"]}


def test_manual_order_climbs_and_puts_unplaced_issues_last(client: TestClient, workspace: str, statuses: Any) -> None:
    """`sort=manual` orders by `sort_order`, with never-placed issues after the rest."""
    sign_in(client, OWNER)
    unplaced = create_issue(client, workspace, title="Unplaced")
    second = create_issue(client, workspace, title="Second", sort_order="b")
    first = create_issue(client, workspace, title="First", sort_order="a")
    between = create_issue(client, workspace, title="Between")

    moved = client.patch(f"/api/workspaces/{workspace}/issues/{between['id']}", json={"sort_order": "aV"})
    assert moved.status_code == 200
    assert moved.json()["sort_order"] == "aV"

    listed = client.get(f"/api/workspaces/{workspace}/issues", params={"team_id": TEAM, "sort": "manual"}).json()

    assert [row["id"] for row in listed["issues"]] == [first["id"], between["id"], second["id"], unplaced["id"]]


def test_a_reorder_records_no_activity(client: TestClient, workspace: str, statuses: Any, repositories: Any) -> None:
    """Moving a row is arrangement, so history stays free of it."""
    sign_in(client, OWNER)
    created = create_issue(client, workspace)

    client.patch(f"/api/workspaces/{workspace}/issues/{created['id']}", json={"sort_order": "m"})
    rows = repositories.activity.list_for_issue(workspace, created["id"]).items

    assert [row["kind"] for row in rows] == ["created"]


def test_a_malformed_sort_order_is_a_422(client: TestClient, workspace: str, statuses: Any) -> None:
    """Only the base 62 alphabet sorts the same everywhere, so nothing else is stored."""
    sign_in(client, OWNER)
    created = create_issue(client, workspace)

    response = client.patch(f"/api/workspaces/{workspace}/issues/{created['id']}", json={"sort_order": "a b"})

    assert response.status_code == 422


def test_a_cursor_is_bound_to_its_filter(client: TestClient, workspace: str, statuses: Any) -> None:
    """A cursor carried to a different filter starts over rather than skipping rows."""
    sign_in(client, OWNER)
    for n in range(3):
        create_issue(client, workspace, title=f"Issue {n}", priority="high")

    base = f"/api/workspaces/{workspace}/issues"
    first = client.get(base, params={"priority": "high", "limit": 2}).json()
    assert first["next_cursor"]

    carried = client.get(base, params={"priority": "high", "priority_not": "low", "cursor": first["next_cursor"]})
    resumed = client.get(base, params={"priority": "high", "cursor": first["next_cursor"]})

    assert len(carried.json()["issues"]) == 3
    assert len(resumed.json()["issues"]) == 1
