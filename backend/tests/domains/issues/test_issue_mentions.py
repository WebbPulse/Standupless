"""Issue mentions in descriptions: the "mentioned in" backlink and who may read it.

A description that names another issue by key leaves a `mentioned` row on that
issue's history, as Linear does, and only for the keys a write adds. A backlink
from a team the reader cannot see is dropped from the history read.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.issue_mentions import added_keys, issue_keys
from tests.domains.helpers import GUEST, OWNER, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, create_issue


def history(client: TestClient, workspace: str, issue_id: str) -> list[Any]:
    """One issue's history as the route answers it, newest first."""
    response = client.get(f"/api/workspaces/{workspace}/issues/{issue_id}/activity")
    assert response.status_code == 200, response.text
    return response.json()["activity"]


def mentions_of(client: TestClient, workspace: str, issue_id: str) -> list[Any]:
    """Only the backlink rows of one issue's history."""
    return [row for row in history(client, workspace, issue_id) if row["kind"] == "mentioned"]


def test_keys_are_read_in_order_once_each_and_not_from_code() -> None:
    """A key in a URL path, a code span or a fence is not a reference."""
    body = "Fixes ABC-12, see abc-1 and ABC-12 again.\n`ABC-3` and\n```\nABC-4\n```\nhttps://x.dev/i/ABC-5 XYZ-007"

    assert issue_keys(body) == ["ABC-12", "XYZ-7"]
    assert added_keys("ABC-12", "ABC-12 ABC-13") == ["ABC-13"]


def test_a_description_naming_an_issue_leaves_a_backlink(client: TestClient, workspace: str, statuses: Any) -> None:
    """The named issue's history says which issue mentioned it and where."""
    sign_in(client, OWNER)
    target = create_issue(client, workspace, title="Target")
    source = create_issue(client, workspace, title="Source", body=f"Blocked on {target['key']}")

    rows = mentions_of(client, workspace, target["id"])
    assert len(rows) == 1
    assert rows[0]["field"] == "description"
    assert rows[0]["to"]["id"] == source["id"]
    assert rows[0]["to"]["key"] == source["key"]
    assert rows[0]["to"]["title"] == "Source"


def test_an_edit_backlinks_only_the_keys_it_adds(client: TestClient, workspace: str, statuses: Any) -> None:
    """Rewording a description that already names an issue does not mention it again."""
    sign_in(client, OWNER)
    first = create_issue(client, workspace, title="First")
    second = create_issue(client, workspace, title="Second")
    source = create_issue(client, workspace, body=f"See {first['key']}")

    response = client.patch(
        f"/api/workspaces/{workspace}/issues/{source['id']}",
        json={"body": f"See {first['key']} and {second['key']}"},
    )
    assert response.status_code == 200, response.text

    assert len(mentions_of(client, workspace, first["id"])) == 1
    assert len(mentions_of(client, workspace, second["id"])) == 1
    assert mentions_of(client, workspace, source["id"]) == []


def test_a_backlink_from_an_unseen_team_is_hidden(client: TestClient, workspace: str, statuses: Any) -> None:
    """A guest reading the mentioned issue does not learn a private team's title."""
    sign_in(client, OWNER)
    target = create_issue(client, workspace, title="Shared")
    create_issue(client, workspace, team_id=OTHER_TEAM, title="Private", body=f"Relates to {target['key']}")

    assert len(mentions_of(client, workspace, target["id"])) == 1

    sign_in(client, GUEST)
    assert mentions_of(client, workspace, target["id"]) == []
