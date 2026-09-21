"""Board routes: the whole board in one call, and one column paged on its own.

The properties worth holding are that a column is read by the status index rather
than by filtering a team, that the post-read filters narrow a column without
changing who may see it, and that a team the caller cannot read is a 404 rather
than an empty board.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import GUEST, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM, seed_issue


def columns_by_category(payload: "dict[str, Any]") -> "dict[str, Any]":
    """The board's columns keyed by status category, for readable assertions."""
    return {column["category"]: column for column in payload["columns"]}


def test_the_board_has_a_column_per_status_in_position_order(client: TestClient, workspace: str, statuses: Any) -> None:
    """Columns come from the team's statuses, so an empty one still appears."""
    sign_in(client, OWNER)

    response = client.get(f"/api/workspaces/{workspace}/board", params={"team_id": TEAM})

    assert response.status_code == 200
    payload = response.json()
    assert payload["team_id"] == TEAM
    positions = [column["position"] for column in payload["columns"]]
    assert positions == sorted(positions)
    assert {column["category"] for column in payload["columns"]} >= {"unstarted", "completed"}


def test_an_issue_lands_in_the_column_of_its_status(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """The board is read by status, so a card sits under exactly one column."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Needs doing")

    sign_in(client, OWNER)
    response = client.get(f"/api/workspaces/{workspace}/board", params={"team_id": TEAM})

    columns = columns_by_category(response.json())
    landed = [column for column in columns.values() if column["issues"]]
    assert len(landed) == 1
    assert [row["id"] for row in landed[0]["issues"]] == [issue["id"]]
    assert landed[0]["total"] == 1


def test_a_finished_issue_moves_column(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """Seeding straight into a status puts the card in that column."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Done", status_id=statuses["completed"].status_id)

    sign_in(client, OWNER)
    columns = columns_by_category(
        client.get(f"/api/workspaces/{workspace}/board", params={"team_id": TEAM}).json()
    )

    assert [row["id"] for row in columns["completed"]["issues"]] == [issue["id"]]


def test_the_assignee_filter_narrows_a_column(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """A post-read filter narrows what is returned without changing visibility."""
    sign_in(issues_client, OWNER)
    mine = seed_issue(issues_client, workspace, title="Mine", assignee_id=MEMBER)
    seed_issue(issues_client, workspace, title="Theirs", assignee_id=OWNER)

    sign_in(client, OWNER)
    response = client.get(
        f"/api/workspaces/{workspace}/board",
        params={"team_id": TEAM, "assignee_id": MEMBER},
    )

    returned = [row["id"] for column in response.json()["columns"] for row in column["issues"]]
    assert returned == [mine["id"]]


def test_me_resolves_to_the_caller(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """`me` is read from the context, so a saved filter is portable between members."""
    sign_in(issues_client, OWNER)
    seed_issue(issues_client, workspace, title="Owner's", assignee_id=OWNER)
    members = seed_issue(issues_client, workspace, title="Member's", assignee_id=MEMBER)

    sign_in(client, MEMBER)
    response = client.get(
        f"/api/workspaces/{workspace}/board",
        params={"team_id": TEAM, "assignee_id": "me"},
    )

    returned = [row["id"] for column in response.json()["columns"] for row in column["issues"]]
    assert returned == [members["id"]]


def test_the_priority_filter_narrows_a_column(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """Priority is a post-read filter for the same reason the assignee is."""
    sign_in(issues_client, OWNER)
    urgent = seed_issue(issues_client, workspace, title="Urgent", priority="urgent")
    seed_issue(issues_client, workspace, title="Ordinary", priority="medium")

    sign_in(client, OWNER)
    response = client.get(
        f"/api/workspaces/{workspace}/board",
        params={"team_id": TEAM, "priority": "urgent"},
    )

    returned = [row["id"] for column in response.json()["columns"] for row in column["issues"]]
    assert returned == [urgent["id"]]


def test_a_guest_cannot_read_the_board_of_a_team_they_are_outside(client: TestClient, workspace: str) -> None:
    """An invisible team is not found rather than an empty board."""
    sign_in(client, GUEST)

    response = client.get(f"/api/workspaces/{workspace}/board", params={"team_id": OTHER_TEAM})

    assert response.status_code == 404
    assert response.json()["error_code"] == "NOT_FOUND"


def test_a_guest_reads_the_board_of_their_own_team(client: TestClient, workspace: str, statuses: Any) -> None:
    """Team membership is what makes a board readable."""
    sign_in(client, GUEST)

    response = client.get(f"/api/workspaces/{workspace}/board", params={"team_id": TEAM})

    assert response.status_code == 200


def test_a_non_member_cannot_read_any_board(client: TestClient, workspace: str) -> None:
    """Fail closed: no workspace membership is a 404, not an empty answer."""
    sign_in(client, "01JB000000000000000000OUTS")

    response = client.get(f"/api/workspaces/{workspace}/board", params={"team_id": TEAM})

    assert response.status_code == 404


def test_a_board_of_a_team_that_does_not_exist_is_not_found(client: TestClient, workspace: str) -> None:
    """An absent team reads the same as an invisible one."""
    sign_in(client, OWNER)

    response = client.get(
        f"/api/workspaces/{workspace}/board",
        params={"team_id": "01JB00000000000000000GONE"},
    )

    assert response.status_code == 404


def test_a_column_pages_past_its_limit(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """A column deeper than one page hands back a cursor that reads the rest."""
    sign_in(issues_client, OWNER)
    for index in range(5):
        seed_issue(issues_client, workspace, title=f"Card {index}")

    status_id = statuses["backlog"].status_id
    sign_in(client, OWNER)

    first = client.get(
        f"/api/workspaces/{workspace}/board/columns/{status_id}",
        params={"team_id": TEAM, "limit": 2},
    )
    assert first.status_code == 200
    assert len(first.json()["issues"]) == 2
    cursor = first.json()["next_cursor"]
    assert cursor

    seen = [row["id"] for row in first.json()["issues"]]
    while cursor:
        page = client.get(
            f"/api/workspaces/{workspace}/board/columns/{status_id}",
            params={"team_id": TEAM, "limit": 2, "cursor": cursor},
        )
        assert page.status_code == 200
        seen.extend(row["id"] for row in page.json()["issues"])
        cursor = page.json()["next_cursor"]

    assert len(seen) == 5
    assert len(set(seen)) == 5


def test_a_cursor_from_another_column_does_not_carry_over(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """A cursor is stamped with the column it came from, so it cannot be replayed.

    Feeding one column's index position to another would otherwise be a start key
    DynamoDB has no reason to reject, and the page would silently be wrong. The
    shared codec drops a foreign-scoped cursor rather than raising, so the answer is
    the column read from its beginning, which is correct rather than merely safe.
    """
    sign_in(issues_client, OWNER)
    for index in range(3):
        seed_issue(issues_client, workspace, title=f"Card {index}")
    done = seed_issue(issues_client, workspace, title="Done", status_id=statuses["completed"].status_id)

    sign_in(client, OWNER)
    first = client.get(
        f"/api/workspaces/{workspace}/board/columns/{statuses['backlog'].status_id}",
        params={"team_id": TEAM, "limit": 1},
    )
    cursor = first.json()["next_cursor"]
    assert cursor

    replayed = client.get(
        f"/api/workspaces/{workspace}/board/columns/{statuses['completed'].status_id}",
        params={"team_id": TEAM, "limit": 1, "cursor": cursor},
    )

    assert replayed.status_code == 200
    assert [row["id"] for row in replayed.json()["issues"]] == [done["id"]]


def test_a_guest_cannot_page_a_column_of_a_team_they_are_outside(
    client: TestClient, workspace: str, statuses: Any
) -> None:
    """The column route makes the same decision the board does."""
    sign_in(client, GUEST)

    response = client.get(
        f"/api/workspaces/{workspace}/board/columns/{statuses['backlog'].status_id}",
        params={"team_id": OTHER_TEAM},
    )

    assert response.status_code == 404


def test_a_cycle_filter_is_accepted_and_narrows_nothing(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """The contract fixes the query signature before the planning domain exists.

    An issue carries no cycle until M4, so the parameter is accepted rather than
    rejected and the board answers as though it were absent.
    """
    sign_in(issues_client, OWNER)
    seed_issue(issues_client, workspace, title="Uncycled")

    sign_in(client, OWNER)
    response = client.get(
        f"/api/workspaces/{workspace}/board",
        params={"team_id": TEAM, "cycle_id": "01JB0000000000000000CYCLE"},
    )

    assert response.status_code == 200
    returned = [row for column in response.json()["columns"] for row in column["issues"]]
    assert len(returned) == 1
