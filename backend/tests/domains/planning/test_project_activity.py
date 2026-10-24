"""Project activity: the recorded property and milestone changes on one project.

The properties worth holding are that creating a project and each tracked
property a patch moves leave one row naming the actor and the old and new value,
that an untracked or unchanged property leaves none, that milestones added,
renamed and removed are recorded by name, that the feed reads newest first and
pages, that it follows the project's visibility and narrows team lists to the
caller's teams, and that it goes with the project.
"""

from __future__ import annotations

import itertools
from datetime import UTC, datetime, timedelta
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.dynamodb import new_ulid

from tests.domains.helpers import GUEST, MEMBER, OUTSIDER, OWNER, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, TEAM, WORKSPACE, seed_project


@pytest.fixture(autouse=True)
def ordered_ids(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Mint ids a millisecond apart, so rows written in one millisecond still sort in order."""
    start = datetime.now(UTC)
    counter = itertools.count()
    monkeypatch.setattr(
        "app.common.project_activity.new_planning_id",
        lambda: new_ulid(start + timedelta(milliseconds=next(counter))),
    )
    yield


def _path(workspace: str, project_id: str) -> str:
    """A project's activity feed."""
    return f"/api/workspaces/{workspace}/projects/{project_id}/activity"


def _activity(client: TestClient, workspace: str, project_id: str, **params: Any) -> "dict[str, Any]":
    """One page of the feed, failing loudly on a refusal."""
    response = client.get(_path(workspace, project_id), params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _patch(client: TestClient, workspace: str, project_id: str, **payload: Any) -> None:
    """Patch one project through the route, failing loudly on a refusal."""
    response = client.patch(f"/api/workspaces/{workspace}/projects/{project_id}", json=payload)
    assert response.status_code == 200, response.text


def test_creating_a_project_records_who_created_it(client: TestClient, workspace: str) -> None:
    """A new project's feed holds one created row by its creator."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]

    rows = _activity(client, workspace, project_id)["activity"]

    assert [(row["kind"], row["actor_id"], row["project_id"]) for row in rows] == [("created", MEMBER, project_id)]


def test_a_patch_records_each_tracked_property_it_moved(client: TestClient, workspace: str) -> None:
    """Status, priority and target date each get a row with their old and new value, newest first."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]

    _patch(client, workspace, project_id, status="in_progress", priority="high")
    _patch(client, workspace, project_id, target_date="2026-12-01", description="Not tracked")
    _patch(client, workspace, project_id, status="in_progress")

    rows = _activity(client, workspace, project_id)["activity"]

    changes = {row["field"]: (row["from"], row["to"]) for row in rows if row["kind"] == "field_changed"}
    assert changes == {
        "status": ("backlog", "in_progress"),
        "priority": ("none", "high"),
        "target_date": (None, "2026-12-01"),
    }
    assert rows[0]["field"] == "target_date"
    assert all(row["actor_id"] == MEMBER for row in rows)


def test_a_member_change_ignores_order(client: TestClient, workspace: str) -> None:
    """Adding a member records the lists, and the same members reordered record nothing."""
    sign_in(client, OWNER)
    project_id = seed_project(client, workspace)["project_id"]

    _patch(client, workspace, project_id, member_ids=[MEMBER, OWNER])
    _patch(client, workspace, project_id, member_ids=[OWNER, MEMBER])

    rows = [row for row in _activity(client, workspace, project_id)["activity"] if row["kind"] == "field_changed"]
    assert len(rows) == 1
    assert rows[0]["field"] == "member_ids"
    assert rows[0]["from"] == []
    assert sorted(rows[0]["to"]) == sorted([MEMBER, OWNER])


def test_milestones_added_renamed_and_removed_are_recorded(client: TestClient, workspace: str) -> None:
    """Each milestone event names the milestone, the removal by the name it had."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    base = f"/api/workspaces/{workspace}/projects/{project_id}/milestones"
    created = client.post(base, json={"name": "Beta"})
    assert created.status_code == 201, created.text
    milestone_id = created.json()["milestone_id"]

    renamed = client.patch(f"{base}/{milestone_id}", json={"name": "Public beta", "description": "Not tracked"})
    assert renamed.status_code == 200, renamed.text
    assert client.delete(f"{base}/{milestone_id}").status_code == 204

    rows = _activity(client, workspace, project_id)["activity"]

    assert [(row["kind"], row["field"], row["from"], row["to"]) for row in rows] == [
        ("milestone_removed", None, "Public beta", None),
        ("milestone_changed", "name", "Beta", "Public beta"),
        ("milestone_added", None, None, "Beta"),
        ("created", None, None, None),
    ]
    assert {row["milestone_id"] for row in rows[:3]} == {milestone_id}


def test_the_feed_pages_with_a_cursor(client: TestClient, workspace: str) -> None:
    """A cursor resumes the same feed, and a cursor from another project starts over."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    other_id = seed_project(client, workspace, name="Other")["project_id"]
    for name in ("One", "Two", "Three"):
        _patch(client, workspace, project_id, name=name)

    first = _activity(client, workspace, project_id, limit=2)
    second = _activity(client, workspace, project_id, limit=2, cursor=first["next_cursor"])
    restarted = _activity(client, workspace, other_id, limit=2, cursor=first["next_cursor"])

    assert [row["to"] for row in first["activity"]] == ["Three", "Two"]
    assert [row["to"] for row in second["activity"]] == ["One", None]
    assert [row["kind"] for row in restarted["activity"]] == ["created"]


def test_the_feed_follows_the_projects_visibility(client: TestClient, workspace: str) -> None:
    """A project on a team the caller cannot see has no feed for them."""
    sign_in(client, OWNER)
    hidden = seed_project(client, workspace, team_id=OTHER_TEAM)["project_id"]

    sign_in(client, GUEST)
    assert client.get(_path(workspace, hidden)).status_code == 404
    sign_in(client, OUTSIDER)
    assert client.get(_path(workspace, hidden)).status_code == 404


def test_a_team_change_is_narrowed_to_the_callers_teams(client: TestClient, workspace: str) -> None:
    """Adding a hidden team is invisible to a guest, while the owner sees it."""
    sign_in(client, OWNER)
    project_id = seed_project(client, workspace)["project_id"]
    _patch(client, workspace, project_id, team_ids=[TEAM, OTHER_TEAM])

    owner_rows = [row for row in _activity(client, workspace, project_id)["activity"] if row["field"] == "team_ids"]
    sign_in(client, GUEST)
    guest_rows = [row for row in _activity(client, workspace, project_id)["activity"] if row["field"] == "team_ids"]

    assert [(row["from"], sorted(row["to"])) for row in owner_rows] == [([TEAM], sorted([TEAM, OTHER_TEAM]))]
    assert guest_rows == []


def test_deleting_a_project_deletes_its_activity(client: TestClient, repositories: Any, workspace: str) -> None:
    """No activity row outlives its project."""
    sign_in(client, OWNER)
    project_id = seed_project(client, workspace)["project_id"]
    _patch(client, workspace, project_id, status="planned")

    assert client.delete(f"/api/workspaces/{workspace}/projects/{project_id}").status_code == 204

    rows, _ = repositories.planning.list_project_activity(WORKSPACE, project_id, limit=50)
    assert rows == []
