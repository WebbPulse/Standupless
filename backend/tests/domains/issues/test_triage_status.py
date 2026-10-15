"""Triage as a status: the synthetic `triage` status id on the issue routes.

These pin that naming the triage status files or sends an issue into the inbox
while it keeps a hidden real status, that naming a real status accepts it, that the
status filter selects it, and that a team with triage off refuses it.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.team_config import default_triage_settings
from tests.domains.helpers import MEMBER, OWNER, add_team_member, sign_in
from tests.domains.issues.conftest import TEAM, WORKSPACE, create_issue

BASE = f"/api/workspaces/{WORKSPACE}/issues"


@pytest.fixture
def triage(repositories: Any, workspace: str) -> str:
    """`TEAM` with triage on and the owner as its one explicit member."""
    repositories.team_config.put_triage_settings(
        default_triage_settings(WORKSPACE, TEAM).model_copy(update={"enabled": True})
    )
    add_team_member(repositories, workspace, TEAM, OWNER, "admin")
    return TEAM


def _triage_rows(repositories: Any, issue_id: str) -> "list[tuple[Any, Any]]":
    """The triage history rows of one issue, as (from_value, to_value)."""
    rows = repositories.activity.list_for_issue(WORKSPACE, issue_id, limit=50).items
    return [
        (row.get("from_value"), row.get("to_value"))
        for row in rows
        if row.get("kind") == "field_changed" and row.get("field") == "triage"
    ]


def test_a_member_files_into_triage_by_naming_it(client: TestClient, triage: str, statuses: "dict[str, Any]") -> None:
    """`status_id: triage` lands the issue in the inbox under the team's default status."""
    sign_in(client, OWNER)

    issue = create_issue(client, WORKSPACE, status_id="triage")

    assert issue["in_triage"] is True
    assert issue["status_id"] in {row.status_id for row in statuses.values()}


def test_naming_triage_on_a_team_without_it_is_refused(client: TestClient, workspace: str) -> None:
    """A team with triage off has no triage status to file into."""
    sign_in(client, OWNER)

    response = client.post(BASE, json={"team_id": TEAM, "title": "An issue", "status_id": "triage"})

    assert response.status_code == 422
    assert "triage" in response.text


def test_picking_triage_sends_an_issue_back(
    client: TestClient, triage: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """The patch keeps the real status hidden, takes the issue off its column and records it."""
    sign_in(client, OWNER)
    issue = create_issue(client, WORKSPACE, status_id=statuses["started"].status_id)

    response = client.patch(f"{BASE}/{issue['id']}", json={"status_id": "triage"})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["in_triage"] is True
    assert body["status_id"] == statuses["started"].status_id
    assert (None, "pending") in _triage_rows(repositories, issue["id"])
    column = repositories.issues.list_for_status(WORKSPACE, TEAM, body["status_id"])
    assert issue["id"] not in {str(item["issue_id"]) for item in column.items}


def test_picking_triage_while_off_is_refused(client: TestClient, workspace: str) -> None:
    """With triage off the patch is a 422 and the issue stays put."""
    sign_in(client, OWNER)
    issue = create_issue(client, WORKSPACE)

    response = client.patch(f"{BASE}/{issue['id']}", json={"status_id": "triage"})

    assert response.status_code == 422
    assert client.get(f"{BASE}/{issue['id']}").json()["in_triage"] is False


def test_picking_a_real_status_accepts_it(client: TestClient, triage: str, repositories: Any) -> None:
    """A waiting issue moved to a status leaves triage as accepted, even to its hidden status."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)

    response = client.patch(f"{BASE}/{waiting['id']}", json={"status_id": waiting["status_id"]})

    assert response.status_code == 200, response.text
    assert response.json()["in_triage"] is False
    assert ("pending", "accepted") in _triage_rows(repositories, waiting["id"])


def test_the_status_filter_selects_triage(client: TestClient, triage: str) -> None:
    """`status_id=triage` lists the waiting issues, and excluding it leaves them out."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)
    kept = create_issue(client, WORKSPACE)

    either = [("team_id", TEAM), ("status_id", "triage"), ("status_id", kept["status_id"])]
    excluded = {"team_id": TEAM, "include_triage": "true", "status_id_not": "triage"}

    only = client.get(BASE, params={"team_id": TEAM, "status_id": "triage"}).json()["issues"]
    both = client.get(BASE, params=either).json()["issues"]
    without = client.get(BASE, params=excluded).json()["issues"]

    assert [row["id"] for row in only] == [waiting["id"]]
    assert {row["id"] for row in both} == {waiting["id"], kept["id"]}
    assert [row["id"] for row in without] == [kept["id"]]


def test_a_link_shows_a_waiting_issue_as_triage(client: TestClient, triage: str) -> None:
    """The far side of a link reports the triage status, not its hidden one."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)
    issue = create_issue(client, WORKSPACE)

    created = client.post(f"{BASE}/{issue['id']}/links", json={"type": "relates_to", "target_issue_id": waiting["id"]})
    links = client.get(f"{BASE}/{issue['id']}/links").json()["links"]

    assert created.status_code == 201, created.text
    assert created.json()["target_status"]["id"] == "triage"
    assert [row["target_status"]["name"] for row in links] == ["Triage"]
