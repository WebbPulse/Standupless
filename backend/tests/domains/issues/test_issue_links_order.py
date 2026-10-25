"""The link count sort: most links first, ties to the latest update, then the issue key."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.issues import Issue
from app.common.issue_writes import order_issues
from app.domains.views.share_service import shared_sort_descending, shared_sort_key
from tests.domains.helpers import OWNER, sign_in
from tests.domains.issues.conftest import TEAM, create_issue

EARLY = datetime(2026, 10, 1, tzinfo=UTC)
LATE = datetime(2026, 10, 2, tzinfo=UTC)


def _issue(number: int, links: int, updated_at: datetime) -> Issue:
    """One bare issue row holding `links` relations, last updated at `updated_at`."""
    return Issue(
        workspace_id="ws",
        team_id="team",
        key=f"STUP-{number}",
        number=number,
        title=f"Issue {number}",
        status_id="status",
        relation_count=links,
        created_at=EARLY,
        updated_at=updated_at,
    )


def _keys(rows: "list[Issue]") -> "list[str]":
    """The keys of rows, in order."""
    return [row.key for row in rows]


def test_links_desc_breaks_ties_by_update_then_key() -> None:
    """Equal counts read the latest update first, and equal updates the lower key first."""
    rows = [
        _issue(1, 0, LATE),
        _issue(2, 3, EARLY),
        _issue(3, 3, EARLY),
        _issue(4, 3, LATE),
        _issue(5, 1, EARLY),
    ]

    assert _keys(order_issues(rows, "links_desc")) == ["STUP-4", "STUP-2", "STUP-3", "STUP-5", "STUP-1"]
    assert _keys(order_issues(rows, "links_desc", reverse=True)) == ["STUP-1", "STUP-5", "STUP-3", "STUP-2", "STUP-4"]


def test_the_shared_listing_orders_links_the_same_way() -> None:
    """A shared view sorts by link count with the same tie-break as the member list."""
    rows = [_issue(1, 0, LATE), _issue(2, 2, EARLY), _issue(3, 2, EARLY), _issue(4, 2, LATE)]

    ordered = sorted(rows, key=shared_sort_key("links_desc"), reverse=shared_sort_descending("links_desc"))

    assert _keys(ordered) == ["STUP-4", "STUP-2", "STUP-3", "STUP-1"]


def test_the_list_route_orders_by_link_count(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The route accepts the sort and reads the most linked issue first, reversed on request."""
    sign_in(client, OWNER)
    none = create_issue(client, workspace, title="Unlinked")
    many = create_issue(client, workspace, title="Many links")
    one = create_issue(client, workspace, title="One link")
    repositories.issues.set_relation_count(workspace, many["id"], 4)
    repositories.issues.set_relation_count(workspace, one["id"], 1)

    def listed(**params: Any) -> "list[str]":
        """The ids the team's list answers under `params`."""
        response = client.get(
            f"/api/workspaces/{workspace}/issues", params={"team_id": TEAM, "sort": "links_desc", **params}
        )
        assert response.status_code == 200, response.text
        return [row["id"] for row in response.json()["issues"]]

    assert listed() == [many["id"], one["id"], none["id"]]
    assert listed(reverse="true") == [none["id"], one["id"], many["id"]]
