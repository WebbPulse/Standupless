"""A team's triage inbox, through the issue routes.

These pin who lands in triage, that a waiting issue stays off the list and the
board until it is worked, and that accept, decline, duplicate and snooze each move
it out the way the inbox promises.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.team_config import default_triage_settings
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_team_member, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, WORKSPACE, create_issue

BASE = f"/api/workspaces/{WORKSPACE}/issues"

TRIAGE = f"{BASE}/triage"


def _enable(repositories: Any, team_id: str = TEAM) -> None:
    """Turn the team's triage inbox on straight in the table."""
    repositories.team_config.put_triage_settings(
        default_triage_settings(WORKSPACE, team_id).model_copy(update={"enabled": True})
    )


@pytest.fixture
def triage(repositories: Any, workspace: str) -> str:
    """`TEAM` with triage on and the owner as its one explicit member."""
    _enable(repositories)
    add_team_member(repositories, workspace, TEAM, OWNER, "admin")
    return TEAM


def _waiting(client: TestClient, **params: Any) -> "list[str]":
    """The ids the team's triage inbox answers, in order."""
    response = client.get(TRIAGE, params={"team_id": TEAM, **params})
    assert response.status_code == 200, response.text
    return [row["id"] for row in response.json()["issues"]]


def _listed(client: TestClient, **params: Any) -> "set[str]":
    """The ids the ordinary issue list answers."""
    response = client.get(BASE, params={"team_id": TEAM, **params})
    assert response.status_code == 200, response.text
    return {row["id"] for row in response.json()["issues"]}


def _triage_rows(repositories: Any, issue_id: str) -> "list[tuple[str, Any]]":
    """The triage history rows of one issue, as (field, to_value)."""
    rows = repositories.activity.list_for_issue(WORKSPACE, issue_id, limit=50).items
    return [
        (str(row["field"]), row.get("to_value"))
        for row in rows
        if row.get("kind") == "field_changed" and str(row.get("field", "")).startswith("triage")
    ]


def test_nothing_lands_in_triage_while_it_is_off(client: TestClient, workspace: str) -> None:
    """Triage is off by default, so every issue goes straight to the team."""
    sign_in(client, GUEST)
    issue = create_issue(client, workspace)

    assert issue["in_triage"] is False


def test_guests_and_people_outside_the_team_land_in_triage(client: TestClient, triage: str) -> None:
    """A guest and a workspace member outside the team both file into the inbox."""
    sign_in(client, GUEST)
    from_guest = create_issue(client, WORKSPACE, title="From a guest")
    sign_in(client, MEMBER)
    from_member = create_issue(client, WORKSPACE, title="From outside")

    assert from_guest["in_triage"] is True
    assert from_member["in_triage"] is True
    sign_in(client, OWNER)
    assert _waiting(client) == [from_member["id"], from_guest["id"]]


def test_team_members_skip_triage_unless_they_ask(client: TestClient, triage: str) -> None:
    """An explicit member files straight in, and `triage: true` sends it to the inbox."""
    sign_in(client, OWNER)
    direct = create_issue(client, WORKSPACE, title="Direct")
    asked = create_issue(client, WORKSPACE, title="Asked", triage=True)

    assert direct["in_triage"] is False
    assert asked["in_triage"] is True


def test_a_waiting_issue_is_off_the_list_and_the_board(client: TestClient, triage: str, repositories: Any) -> None:
    """The list leaves it out unless asked, and no status column holds it."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)
    kept = create_issue(client, WORKSPACE)

    assert _listed(client) == {kept["id"]}
    assert _listed(client, include_triage="true") == {kept["id"], waiting["id"]}
    assert _listed(client, triage_only="true") == {waiting["id"]}
    column = repositories.issues.list_for_status(WORKSPACE, TEAM, waiting["status_id"])
    assert waiting["id"] not in {str(item["issue_id"]) for item in column.items}


def test_accept_moves_it_to_the_first_unstarted_status(
    client: TestClient, triage: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """Accepting with no status picks the team's first unstarted one and records the outcome."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)

    response = client.post(f"{BASE}/{waiting['id']}/triage/accept")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["in_triage"] is False
    assert body["status_id"] == statuses["unstarted"].status_id
    assert _waiting(client) == []
    assert waiting["id"] in _listed(client)
    assert ("triage", "accepted") in _triage_rows(repositories, waiting["id"])
    column = repositories.issues.list_for_status(WORKSPACE, TEAM, body["status_id"])
    assert waiting["id"] in {str(item["issue_id"]) for item in column.items}


def test_accept_takes_a_named_status(client: TestClient, triage: str, statuses: "dict[str, Any]") -> None:
    """A named status wins over the default."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)

    response = client.post(f"{BASE}/{waiting['id']}/triage/accept", json={"status_id": statuses["started"].status_id})

    assert response.json()["status_id"] == statuses["started"].status_id


def test_decline_cancels_and_keeps_the_reason(
    client: TestClient, triage: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """Declining moves it to the cancelled status with the reason in its history."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)

    response = client.post(f"{BASE}/{waiting['id']}/triage/decline", json={"reason": "Out of scope"})

    assert response.status_code == 200, response.text
    assert response.json()["status_id"] == statuses["cancelled"].status_id
    rows = _triage_rows(repositories, waiting["id"])
    assert ("triage", "declined") in rows
    assert ("triage_reason", "Out of scope") in rows


def test_duplicate_links_and_closes_it(
    client: TestClient, triage: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """Marking as duplicate links the two and closes the waiting one."""
    sign_in(client, OWNER)
    original = create_issue(client, WORKSPACE, title="Original")
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE, title="Again")
    sign_in(client, OWNER)

    response = client.post(f"{BASE}/{waiting['id']}/triage/duplicate", json={"duplicate_of_id": original["id"]})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["in_triage"] is False
    assert body["status_id"] == statuses["cancelled"].status_id
    links = client.get(f"{BASE}/{waiting['id']}/links").json()
    assert any(row["target_issue_id"] == original["id"] for row in links["links"])
    assert ("triage", "duplicate") in _triage_rows(repositories, waiting["id"])


def test_duplicate_refuses_itself_and_an_unknown_target(client: TestClient, triage: str) -> None:
    """A bad target leaves the issue waiting."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)

    itself = client.post(f"{BASE}/{waiting['id']}/triage/duplicate", json={"duplicate_of_id": waiting["id"]})
    unknown = client.post(f"{BASE}/{waiting['id']}/triage/duplicate", json={"duplicate_of_id": "01JB0000000000000NOPE"})

    assert itself.status_code == 422
    assert unknown.status_code == 404
    assert _waiting(client) == [waiting["id"]]


def test_snooze_hides_it_until_its_time(client: TestClient, triage: str, repositories: Any) -> None:
    """A snoozed issue leaves the inbox and the count, and returns once its time passes."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)
    until = (utc_now() + timedelta(days=1)).isoformat()

    response = client.post(f"{BASE}/{waiting['id']}/triage/snooze", json={"until": until})

    assert response.status_code == 200, response.text
    assert response.json()["snoozed_until"] is not None
    assert _waiting(client) == []
    assert _waiting(client, snoozed="true") == [waiting["id"]]
    summary = client.get(f"{TRIAGE}/summary").json()
    assert summary == {"teams": [{"team_id": TEAM, "count": 0}]}

    stored = repositories.issues.get(WORKSPACE, waiting["id"])
    repositories.issues.replace(stored.model_copy(update={"snoozed_until": utc_now() - timedelta(minutes=1)}))
    assert _waiting(client) == [waiting["id"]]


def test_snooze_holds_its_bounds_and_null_unsnoozes(client: TestClient, triage: str) -> None:
    """Past and far-off moments are refused, and null brings the issue back."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)
    url = f"{BASE}/{waiting['id']}/triage/snooze"

    assert client.post(url, json={"until": (utc_now() - timedelta(hours=1)).isoformat()}).status_code == 422
    assert client.post(url, json={"until": (utc_now() + timedelta(days=91)).isoformat()}).status_code == 422
    client.post(url, json={"until": (utc_now() + timedelta(hours=2)).isoformat()})
    back = client.post(url, json={"until": None})

    assert back.json()["snoozed_until"] is None
    assert _waiting(client) == [waiting["id"]]


def test_a_status_change_accepts_it(client: TestClient, triage: str, statuses: "dict[str, Any]") -> None:
    """Moving a waiting issue by an ordinary edit takes it out of triage too."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, OWNER)

    response = client.patch(f"{BASE}/{waiting['id']}", json={"status_id": statuses["started"].status_id})

    assert response.json()["in_triage"] is False
    assert _waiting(client) == []


def test_guests_cannot_work_triage(client: TestClient, triage: str, statuses: "dict[str, Any]") -> None:
    """A guest who filed an issue cannot accept it, by the action or by a status change."""
    sign_in(client, GUEST)
    waiting = create_issue(client, WORKSPACE)

    assert client.post(f"{BASE}/{waiting['id']}/triage/accept").status_code == 403
    moved = client.patch(f"{BASE}/{waiting['id']}", json={"status_id": statuses["started"].status_id})
    assert moved.json()["in_triage"] is True


def test_an_issue_not_in_triage_is_refused(client: TestClient, triage: str) -> None:
    """The actions only work issues still waiting."""
    sign_in(client, OWNER)
    issue = create_issue(client, WORKSPACE)

    assert client.post(f"{BASE}/{issue['id']}/triage/accept").status_code == 422


def test_the_summary_counts_only_teams_with_triage_on(client: TestClient, triage: str, repositories: Any) -> None:
    """A team without triage is left out, and each count is that team's waiting issues."""
    sign_in(client, MEMBER)
    create_issue(client, WORKSPACE)
    create_issue(client, WORKSPACE)
    create_issue(client, WORKSPACE, team_id=OTHER_TEAM)

    summary = client.get(f"{TRIAGE}/summary").json()

    assert summary == {"teams": [{"team_id": TEAM, "count": 2}]}


def test_a_guest_cannot_read_another_teams_inbox(client: TestClient, triage: str, repositories: Any) -> None:
    """The inbox is as hidden as its team, and so is its count."""
    _enable(repositories, OTHER_TEAM)
    sign_in(client, GUEST)

    assert client.get(TRIAGE, params={"team_id": OTHER_TEAM}).status_code == 404
    assert [row["team_id"] for row in client.get(f"{TRIAGE}/summary").json()["teams"]] == [TEAM]


def test_archiving_and_restoring_keeps_it_in_triage(client: TestClient, triage: str) -> None:
    """A restored waiting issue returns to the inbox, not the board."""
    sign_in(client, MEMBER)
    waiting = create_issue(client, WORKSPACE)
    sign_in(client, ADMIN)
    client.post(f"{BASE}/{waiting['id']}/archive")
    assert _waiting(client) == []

    client.post(f"{BASE}/{waiting['id']}/unarchive")

    assert _waiting(client) == [waiting["id"]]
