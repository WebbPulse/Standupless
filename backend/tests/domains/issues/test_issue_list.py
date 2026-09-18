"""The list route: filters, sorts, the fan-out across projects, and cursors.

The fan-out is the part with no index behind it, so these hold that a merged page
is ordered by the requested sort rather than by whichever project was read first,
and that a cursor walks the whole set without repeating or dropping a row.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import MEMBER, OWNER, sign_in
from tests.domains.issues.conftest import OTHER_PROJECT, PROJECT, create_issue


def _ids(body: Any) -> "list[str]":
    """Just the ids of a list response, which is what order assertions read."""
    return [row["id"] for row in body["issues"]]


def test_the_list_fans_out_across_every_visible_project(client: TestClient, workspace: str, statuses: Any) -> None:
    """With no `project_id`, the answer spans the workspace."""
    sign_in(client, OWNER)
    here = create_issue(client, workspace, title="Here")
    there = create_issue(client, workspace, project_id=OTHER_PROJECT, title="There")

    listed = client.get(f"/api/workspaces/{workspace}/issues").json()

    assert set(_ids(listed)) == {here["id"], there["id"]}


def test_a_project_filter_narrows_to_one_project(client: TestClient, workspace: str, statuses: Any) -> None:
    """The indexed path, where the read is one query rather than a merge."""
    sign_in(client, OWNER)
    here = create_issue(client, workspace, title="Here")
    create_issue(client, workspace, project_id=OTHER_PROJECT, title="There")

    listed = client.get(f"/api/workspaces/{workspace}/issues", params={"project_id": PROJECT}).json()

    assert _ids(listed) == [here["id"]]


def test_assignee_me_resolves_to_the_caller(client: TestClient, workspace: str, statuses: Any) -> None:
    """`me` is the contract's spelling for the signed in caller."""
    sign_in(client, OWNER)
    mine = create_issue(client, workspace, title="Mine", assignee_id=OWNER)
    create_issue(client, workspace, title="Theirs", assignee_id=MEMBER)

    listed = client.get(f"/api/workspaces/{workspace}/issues", params={"assignee_id": "me"}).json()

    assert _ids(listed) == [mine["id"]]


def test_filters_narrow_by_status_priority_label_and_parent(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Each filter the contract names, applied against a seeded set."""
    from app.common.db.dynamo.project_config import Label, label_key, new_config_id

    label_id = new_config_id()
    repositories.project_config.create_label(
        Label(
            workspace_id=workspace,
            config_key=label_key(PROJECT, label_id),
            project_id=PROJECT,
            label_id=label_id,
            name="Bug",
            color="#ff0000",
        )
    )

    sign_in(client, OWNER)
    urgent = create_issue(client, workspace, title="Urgent", priority="urgent")
    labelled = create_issue(client, workspace, title="Labelled", label_ids=[label_id])
    parent = create_issue(client, workspace, title="Parent")
    child = create_issue(client, workspace, title="Child", parent_id=parent["id"])
    started = create_issue(client, workspace, title="Started", status_id=statuses["started"].status_id)

    base = f"/api/workspaces/{workspace}/issues"
    assert _ids(client.get(base, params={"priority": "urgent"}).json()) == [urgent["id"]]
    assert _ids(client.get(base, params={"label_id": label_id}).json()) == [labelled["id"]]
    assert _ids(client.get(base, params={"parent_id": parent["id"]}).json()) == [child["id"]]
    assert _ids(client.get(base, params={"status_id": statuses["started"].status_id}).json()) == [started["id"]]


def test_the_query_matches_a_key_or_a_title_prefix(client: TestClient, workspace: str, statuses: Any) -> None:
    """`q` is a key or a title prefix, case insensitive, per the contract."""
    sign_in(client, OWNER)
    first = create_issue(client, workspace, title="Payments break on retry")
    create_issue(client, workspace, title="Unrelated")

    base = f"/api/workspaces/{workspace}/issues"
    assert _ids(client.get(base, params={"q": "payments"}).json()) == [first["id"]]
    assert _ids(client.get(base, params={"q": "abc-1"}).json()) == [first["id"]]
    assert _ids(client.get(base, params={"q": "break on"}).json()) == []


def test_key_asc_orders_by_number_within_a_project(client: TestClient, workspace: str, statuses: Any) -> None:
    """Numbers are numeric, so ten sorts after nine rather than before it."""
    sign_in(client, OWNER)
    created = [create_issue(client, workspace, title=f"Issue {n}") for n in range(1, 12)]

    listed = client.get(
        f"/api/workspaces/{workspace}/issues",
        params={"project_id": PROJECT, "sort": "key_asc", "limit": 100},
    ).json()

    assert _ids(listed) == [row["id"] for row in created]


def test_priority_desc_puts_urgent_first_and_none_last(client: TestClient, workspace: str, statuses: Any) -> None:
    """The contract's ordering, with `none` a rank rather than an omission."""
    sign_in(client, OWNER)
    low = create_issue(client, workspace, title="Low", priority="low")
    urgent = create_issue(client, workspace, title="Urgent", priority="urgent")
    plain = create_issue(client, workspace, title="Plain")

    listed = client.get(f"/api/workspaces/{workspace}/issues", params={"sort": "priority_desc", "limit": 100}).json()

    assert _ids(listed) == [urgent["id"], low["id"], plain["id"]]


def test_due_asc_puts_the_soonest_first_and_undated_last(client: TestClient, workspace: str, statuses: Any) -> None:
    """An issue with no due date sorts after every dated one rather than first."""
    sign_in(client, OWNER)
    later = create_issue(client, workspace, title="Later", due_date="2026-12-01")
    sooner = create_issue(client, workspace, title="Sooner", due_date="2026-01-01")
    undated = create_issue(client, workspace, title="Undated")

    listed = client.get(f"/api/workspaces/{workspace}/issues", params={"sort": "due_asc", "limit": 100}).json()

    assert _ids(listed) == [sooner["id"], later["id"], undated["id"]]


def test_a_cursor_walks_the_whole_set_without_repeating(client: TestClient, workspace: str, statuses: Any) -> None:
    """Paging through in twos visits every issue exactly once."""
    sign_in(client, OWNER)
    expected = {create_issue(client, workspace, title=f"Issue {n}")["id"] for n in range(6)}

    seen: "list[str]" = []
    cursor = None
    for _ in range(10):
        params: "dict[str, Any]" = {"limit": 2, "sort": "key_asc"}
        if cursor:
            params["cursor"] = cursor
        body = client.get(f"/api/workspaces/{workspace}/issues", params=params).json()
        seen.extend(_ids(body))
        cursor = body["next_cursor"]
        if not cursor:
            break

    assert cursor is None
    assert len(seen) == len(set(seen))
    assert set(seen) == expected


def test_a_cursor_from_another_query_is_ignored(client: TestClient, workspace: str, statuses: Any) -> None:
    """A cursor carries the scope it was minted under, so a foreign one restarts.

    Restarting is a correct answer where a 500 on a stale bookmark would not be.
    """
    sign_in(client, OWNER)
    for n in range(4):
        create_issue(client, workspace, title=f"Issue {n}")

    first = client.get(f"/api/workspaces/{workspace}/issues", params={"limit": 2, "sort": "key_asc"}).json()

    replayed = client.get(
        f"/api/workspaces/{workspace}/issues",
        params={"limit": 2, "sort": "created_desc", "cursor": first["next_cursor"]},
    ).json()

    assert len(replayed["issues"]) == 2


def test_a_malformed_cursor_starts_from_the_beginning(client: TestClient, workspace: str, statuses: Any) -> None:
    """A truncated bookmark is not a server error."""
    sign_in(client, OWNER)
    create_issue(client, workspace, title="Only one")

    body = client.get(f"/api/workspaces/{workspace}/issues", params={"cursor": "!!not-base64!!"}).json()

    assert len(body["issues"]) == 1


def test_the_limit_is_bounded(client: TestClient, workspace: str, statuses: Any) -> None:
    """The contract caps a page at a hundred, and the route enforces it."""
    sign_in(client, OWNER)

    assert client.get(f"/api/workspaces/{workspace}/issues", params={"limit": 101}).status_code == 422
    assert client.get(f"/api/workspaces/{workspace}/issues", params={"limit": 0}).status_code == 422
