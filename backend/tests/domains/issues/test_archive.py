"""Archiving and restoring issues by hand, through the issue routes.

An archived issue leaves the list and the board columns but stays readable by
id and by key, and a restore brings it back. Both actions are idempotent and
record one history row each.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.issues import IssueRepository
from tests.domains.helpers import GUEST, MEMBER, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, WORKSPACE, create_issue

BASE = f"/api/workspaces/{WORKSPACE}/issues"


def _kinds(repositories: Any, issue_id: str) -> "list[str]":
    """The activity kinds recorded on one issue, oldest first."""
    rows = repositories.activity.list_for_issue(WORKSPACE, issue_id, limit=50).items
    return sorted((str(row["kind"]) for row in rows if row["kind"] in ("archived", "unarchived")), key=str)


def _listed(client: TestClient, **params: Any) -> "set[str]":
    """The ids the issue list answers with."""
    response = client.get(BASE, params={"team_id": TEAM, **params})
    assert response.status_code == 200, response.text
    return {row["id"] for row in response.json()["issues"]}


def test_archiving_hides_the_issue_from_the_list(client: TestClient, workspace: str) -> None:
    """The default list leaves it out; include_archived brings it back."""
    sign_in(client, MEMBER)
    kept = create_issue(client, workspace, title="Kept")
    gone = create_issue(client, workspace, title="Gone")

    response = client.post(f"{BASE}/{gone['id']}/archive")

    assert response.status_code == 200
    assert response.json()["archived_at"] is not None
    assert _listed(client) == {kept["id"]}
    assert _listed(client, include_archived="true") == {kept["id"], gone["id"]}


def test_an_archived_issue_is_still_read_by_id_and_key(client: TestClient, workspace: str) -> None:
    """Opening an archived issue works, and says it is archived."""
    sign_in(client, MEMBER)
    issue = create_issue(client, workspace)
    client.post(f"{BASE}/{issue['id']}/archive")

    by_id = client.get(f"{BASE}/{issue['id']}")
    by_key = client.get(f"{BASE}/by-key/{issue['key']}")

    assert by_id.status_code == 200
    assert by_id.json()["archived_at"] is not None
    assert by_key.status_code == 200
    assert by_key.json()["id"] == issue["id"]


def test_an_archived_issue_leaves_its_board_column(client: TestClient, workspace: str, repositories: Any) -> None:
    """The status partition the board reads no longer holds it, and a restore puts it back."""
    sign_in(client, MEMBER)
    issue = create_issue(client, workspace)

    def column() -> "set[str]":
        page = repositories.issues.list_for_status(WORKSPACE, TEAM, issue["status_id"])
        return {str(item["issue_id"]) for item in page.items}

    assert issue["id"] in column()
    client.post(f"{BASE}/{issue['id']}/archive")
    assert issue["id"] not in column()
    stored = repositories.issues.get(WORKSPACE, issue["id"])
    assert stored is not None and stored.status_id == issue["status_id"]
    client.post(f"{BASE}/{issue['id']}/unarchive")
    assert issue["id"] in column()


def test_restoring_brings_it_back_and_restarts_the_clock(client: TestClient, workspace: str) -> None:
    """A restored issue is listed again and its updated_at moves forward."""
    sign_in(client, MEMBER)
    issue = create_issue(client, workspace)
    archived = client.post(f"{BASE}/{issue['id']}/archive").json()

    restored = client.post(f"{BASE}/{issue['id']}/unarchive")

    assert restored.status_code == 200
    assert restored.json()["archived_at"] is None
    assert restored.json()["updated_at"] > archived["updated_at"]
    assert _listed(client) == {issue["id"]}


def test_both_actions_are_idempotent_and_recorded_once(client: TestClient, workspace: str, repositories: Any) -> None:
    """A second archive or restore changes nothing and writes no second history row."""
    sign_in(client, MEMBER)
    issue = create_issue(client, workspace)

    first = client.post(f"{BASE}/{issue['id']}/archive").json()
    second = client.post(f"{BASE}/{issue['id']}/archive").json()
    assert first["archived_at"] == second["archived_at"]
    client.post(f"{BASE}/{issue['id']}/unarchive")
    client.post(f"{BASE}/{issue['id']}/unarchive")

    assert _kinds(repositories, issue["id"]) == ["archived", "unarchived"]
    rows = repositories.activity.list_for_issue(WORKSPACE, issue["id"], limit=50).items
    archived_row = next(row for row in rows if row["kind"] == "archived")
    assert archived_row["actor_id"] == MEMBER
    assert archived_row["actor_kind"] == "user"


def test_the_history_route_answers_the_new_kinds(client: TestClient, workspace: str) -> None:
    """The activity feed renders archive rows rather than refusing them."""
    sign_in(client, MEMBER)
    issue = create_issue(client, workspace)
    client.post(f"{BASE}/{issue['id']}/archive")

    response = client.get(f"{BASE}/{issue['id']}/activity")

    assert response.status_code == 200, response.text
    assert "archived" in {row["kind"] for row in response.json()["activity"]}


def test_a_guest_cannot_archive_outside_their_team(client: TestClient, workspace: str) -> None:
    """An issue the caller cannot see answers 404, as every issue route does."""
    sign_in(client, MEMBER)
    hidden = create_issue(client, workspace, team_id=OTHER_TEAM)
    sign_in(client, GUEST)

    assert client.post(f"{BASE}/{hidden['id']}/archive").status_code == 404
    assert client.post(f"{BASE}/{hidden['id']}/unarchive").status_code == 404


def test_an_edit_keeps_an_archived_issue_archived(client: TestClient, workspace: str) -> None:
    """Changing a field of an archived issue does not quietly restore it."""
    sign_in(client, MEMBER)
    issue = create_issue(client, workspace)
    client.post(f"{BASE}/{issue['id']}/archive")

    patched = client.patch(f"{BASE}/{issue['id']}", json={"title": "Renamed"})

    assert patched.status_code == 200
    assert patched.json()["archived_at"] is not None
    assert _listed(client) == set()


def test_archived_only_lists_just_the_archive(client: TestClient, workspace: str) -> None:
    """`archived_only` answers the archived issues and none of the live ones."""
    sign_in(client, MEMBER)
    kept = create_issue(client, workspace, title="Kept")
    gone = create_issue(client, workspace, title="Gone")
    also_gone = create_issue(client, workspace, title="Also gone")
    client.post(f"{BASE}/{gone['id']}/archive")
    client.post(f"{BASE}/{also_gone['id']}/archive")

    assert _listed(client, archived_only="true") == {gone["id"], also_gone["id"]}
    assert _listed(client, archived_only="true", include_archived="true") == {gone["id"], also_gone["id"]}
    assert kept["id"] in _listed(client)


def test_archived_only_reads_the_archived_partitions(
    client: TestClient, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The archive view never reads the team-wide index, only each status's archived partition."""
    sign_in(client, MEMBER)
    gone = create_issue(client, workspace)
    client.post(f"{BASE}/{gone['id']}/archive")

    def refuse(*args: Any, **kwargs: Any) -> Any:
        """Fail the test if the team-wide read is taken."""
        raise AssertionError("archived_only must not read the whole team")

    monkeypatch.setattr(IssueRepository, "list_for_team", refuse)

    assert _listed(client, archived_only="true") == {gone["id"]}


def test_archived_only_across_teams_keeps_other_filters(client: TestClient, workspace: str) -> None:
    """Without a team the archive spans every visible team, and the other filters still apply."""
    sign_in(client, MEMBER)
    urgent = create_issue(client, workspace, title="Urgent", priority="urgent")
    low = create_issue(client, workspace, title="Low", priority="low")
    client.post(f"{BASE}/{urgent['id']}/archive")
    client.post(f"{BASE}/{low['id']}/archive")

    response = client.get(BASE, params={"archived_only": "true", "priority": "urgent"})

    assert response.status_code == 200, response.text
    assert {row["id"] for row in response.json()["issues"]} == {urgent["id"]}


def test_a_bulk_patch_archives_and_restores_a_selection(client: TestClient, workspace: str, repositories: Any) -> None:
    """`archived` on the bulk patch archives every named issue in one request, and false restores them."""
    sign_in(client, MEMBER)
    first = create_issue(client, workspace, title="First")
    second = create_issue(client, workspace, title="Second")
    ids = [first["id"], second["id"]]

    archived = client.patch(BASE, json={"issue_ids": ids, "patch": {"archived": True}})

    assert archived.status_code == 200, archived.text
    assert all(row["archived_at"] is not None for row in archived.json()["issues"])
    assert _listed(client) == set()
    assert _listed(client, archived_only="true") == set(ids)
    assert _kinds(repositories, first["id"]) == ["archived"]

    restored = client.patch(BASE, json={"issue_ids": ids, "patch": {"archived": False}})

    assert restored.status_code == 200, restored.text
    assert all(row["archived_at"] is None for row in restored.json()["issues"])
    assert _listed(client) == set(ids)
    assert _kinds(repositories, second["id"]) == ["archived", "unarchived"]


def test_a_bulk_archive_refuses_an_invisible_issue_and_changes_nothing(client: TestClient, workspace: str) -> None:
    """One issue the caller cannot see fails the whole bulk archive with nothing archived."""
    sign_in(client, MEMBER)
    hidden = create_issue(client, workspace, team_id=OTHER_TEAM)
    sign_in(client, GUEST)
    visible = create_issue(client, workspace)

    response = client.patch(BASE, json={"issue_ids": [visible["id"], hidden["id"]], "patch": {"archived": True}})

    assert response.status_code == 404
    assert client.get(f"{BASE}/{visible['id']}").json()["archived_at"] is None


def test_a_bulk_archive_refuses_a_non_boolean(client: TestClient, workspace: str) -> None:
    """`archived` is strictly a boolean, so a string is a 422 rather than a guess."""
    sign_in(client, MEMBER)
    issue = create_issue(client, workspace)

    response = client.patch(BASE, json={"issue_ids": [issue["id"]], "patch": {"archived": "yes"}})

    assert response.status_code == 422
