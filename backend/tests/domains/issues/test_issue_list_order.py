"""The status, start date and estimate sorts, and the reversed direction.

Each sort is held to what the display options promise: status in the board's
order, start date and estimate with unset issues last, and a reversed sort that
turns the order around while still listing issues lacking the value last.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import OWNER, sign_in
from tests.domains.issues.conftest import TEAM, create_issue


def _ids(body: Any) -> "list[str]":
    """The ids of one list page, in the order it answered them."""
    return [row["id"] for row in body["issues"]]


def _list(client: TestClient, workspace: str, **params: Any) -> "list[str]":
    """The ids one team's list answers under `params`."""
    response = client.get(f"/api/workspaces/{workspace}/issues", params={"team_id": TEAM, "limit": 100, **params})
    assert response.status_code == 200, response.text
    return _ids(response.json())


def test_status_asc_follows_the_board_order(client: TestClient, workspace: str, statuses: Any) -> None:
    """Backlog leads, then unstarted, started and completed, ties broken by priority."""
    sign_in(client, OWNER)
    done = create_issue(client, workspace, title="Done", status_id=statuses["completed"].status_id)
    started = create_issue(client, workspace, title="Started", status_id=statuses["started"].status_id)
    backlog = create_issue(client, workspace, title="Backlog", status_id=statuses["backlog"].status_id)
    todo_low = create_issue(
        client, workspace, title="Todo low", status_id=statuses["unstarted"].status_id, priority="low"
    )
    todo_urgent = create_issue(
        client, workspace, title="Todo urgent", status_id=statuses["unstarted"].status_id, priority="urgent"
    )

    ordered = _list(client, workspace, sort="status_asc")

    assert ordered == [backlog["id"], todo_urgent["id"], todo_low["id"], started["id"], done["id"]]


def test_status_asc_reversed_puts_completed_first(client: TestClient, workspace: str, statuses: Any) -> None:
    """The reversed status sort reads from the end of the board."""
    sign_in(client, OWNER)
    backlog = create_issue(client, workspace, title="Backlog", status_id=statuses["backlog"].status_id)
    done = create_issue(client, workspace, title="Done", status_id=statuses["completed"].status_id)

    assert _list(client, workspace, sort="status_asc", reverse="true") == [done["id"], backlog["id"]]


def test_start_asc_puts_the_earliest_first_and_unscheduled_last(
    client: TestClient, workspace: str, statuses: Any
) -> None:
    """An issue with no start date sorts after every scheduled one, in both directions."""
    sign_in(client, OWNER)
    later = create_issue(client, workspace, title="Later", start_date="2026-12-01")
    unscheduled = create_issue(client, workspace, title="Unscheduled")
    sooner = create_issue(client, workspace, title="Sooner", start_date="2026-01-01")

    assert _list(client, workspace, sort="start_asc") == [sooner["id"], later["id"], unscheduled["id"]]
    assert _list(client, workspace, sort="start_asc", reverse="true") == [later["id"], sooner["id"], unscheduled["id"]]


def test_estimate_desc_puts_the_largest_first_and_unestimated_last(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A zero estimate is an estimate, so it sorts ahead of an issue nobody sized."""
    repositories.teams.update(workspace, TEAM, estimate_scale="fibonacci", estimate_allow_zero=True)
    sign_in(client, OWNER)
    small = create_issue(client, workspace, title="Small", estimate="1")
    unsized = create_issue(client, workspace, title="Unsized")
    large = create_issue(client, workspace, title="Large", estimate="8")

    assert _list(client, workspace, sort="estimate_desc") == [large["id"], small["id"], unsized["id"]]
    assert _list(client, workspace, sort="estimate_desc", reverse="true") == [small["id"], large["id"], unsized["id"]]


def test_due_asc_reversed_keeps_undated_issues_last(client: TestClient, workspace: str, statuses: Any) -> None:
    """Reversing a date sort turns the dated issues around and leaves the undated after them."""
    sign_in(client, OWNER)
    undated = create_issue(client, workspace, title="Undated")
    sooner = create_issue(client, workspace, title="Sooner", due_date="2026-01-01")
    later = create_issue(client, workspace, title="Later", due_date="2026-12-01")

    assert _list(client, workspace, sort="due_asc", reverse="true") == [later["id"], sooner["id"], undated["id"]]


def test_reversed_key_asc_reads_the_newest_number_first(client: TestClient, workspace: str, statuses: Any) -> None:
    """A sort over a value every issue has simply turns around."""
    sign_in(client, OWNER)
    created = [create_issue(client, workspace, title=f"Issue {n}") for n in range(1, 4)]

    assert _list(client, workspace, sort="key_asc", reverse="true") == [row["id"] for row in reversed(created)]


def test_a_cursor_does_not_carry_across_directions(client: TestClient, workspace: str, statuses: Any) -> None:
    """The direction is part of the cursor scope, so a forward cursor starts a reversed read over."""
    sign_in(client, OWNER)
    created = [create_issue(client, workspace, title=f"Issue {n}") for n in range(1, 4)]
    first = client.get(
        f"/api/workspaces/{workspace}/issues", params={"team_id": TEAM, "sort": "key_asc", "limit": 1}
    ).json()

    reversed_page = client.get(
        f"/api/workspaces/{workspace}/issues",
        params={"team_id": TEAM, "sort": "key_asc", "reverse": "true", "limit": 1, "cursor": first["next_cursor"]},
    ).json()

    assert _ids(reversed_page) == [created[-1]["id"]]
