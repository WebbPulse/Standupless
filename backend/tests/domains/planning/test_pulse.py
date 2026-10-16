"""Pulse: the feed of followed project and initiative updates.

The properties worth holding are that "for me" holds what a person leads, is a
member of, owns or chose to follow, and "recent" everything they may read; that
an explicit follow or unfollow wins over a role; that following an initiative
follows its projects; that a guest never sees an initiative or a team outside
their own; that unread state is per person and their own entries never count;
that edits and deletes of an update carry onto its entry; and that health
changes and completed milestones are posted once.
"""

from __future__ import annotations

import itertools
from datetime import UTC, datetime, timedelta
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.dynamodb import new_ulid

from app.domains.planning.consumers.rollup import handle_record
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, TEAM, WORKSPACE, seed_issue, seed_project


@pytest.fixture(autouse=True)
def ordered_ids(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Mint every planning id a millisecond apart, so entries posted in one millisecond still sort in order."""
    start = datetime.now(UTC)
    counter = itertools.count()

    def mint() -> str:
        """The next id in order."""
        return new_ulid(start + timedelta(milliseconds=next(counter)))

    for module in ("app.common.project_updates", "app.common.initiative_writes", "app.common.pulse"):
        monkeypatch.setattr(f"{module}.new_planning_id", mint)
    yield


def _feed(client: TestClient, workspace: str, **params: Any) -> "dict[str, Any]":
    """One page of the caller's Pulse."""
    response = client.get(f"/api/workspaces/{workspace}/pulse", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _types(page: "dict[str, Any]") -> "list[str]":
    """The event types on one feed page, in order."""
    return [item["event_type"] for item in page["items"]]


def _post_update(client: TestClient, workspace: str, project_id: str, **payload: Any) -> "dict[str, Any]":
    """Post one project update, failing loudly on a refusal."""
    body: "dict[str, Any]" = {"body": "All good", "health": "on_track"}
    body.update(payload)
    response = client.post(f"/api/workspaces/{workspace}/projects/{project_id}/updates", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _initiative(client: TestClient, workspace: str, **payload: Any) -> "dict[str, Any]":
    """Create one initiative, failing loudly on a refusal."""
    body: "dict[str, Any]" = {"name": "Expand to Europe"}
    body.update(payload)
    response = client.post(f"/api/workspaces/{workspace}/initiatives", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _post_initiative_update(client: TestClient, workspace: str, initiative_id: str, body: str) -> "dict[str, Any]":
    """Post one initiative update, failing loudly on a refusal."""
    response = client.post(
        f"/api/workspaces/{workspace}/initiatives/{initiative_id}/updates",
        json={"body": body, "health": "on_track"},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _count(client: TestClient, workspace: str) -> int:
    """The caller's unread Pulse count."""
    response = client.get(f"/api/workspaces/{workspace}/pulse/count")
    assert response.status_code == 200, response.text
    return response.json()["unread"]


def test_for_me_holds_what_a_person_leads_and_recent_holds_everything(client: TestClient, workspace: str) -> None:
    """A lead sees their project's update unread in "for me", and another project only in "recent"."""
    sign_in(client, ADMIN)
    led = seed_project(client, workspace, name="Led", lead_id=MEMBER)["project_id"]
    other = seed_project(client, workspace, name="Other")["project_id"]
    _post_update(client, workspace, led, body="Led is fine")
    _post_update(client, workspace, other, body="Other is fine")

    sign_in(client, MEMBER)
    mine = _feed(client, workspace)
    assert [item["project_id"] for item in mine["items"]] == [led]
    entry = mine["items"][0]
    assert entry["event_type"] == "project_update"
    assert entry["project_name"] == "Led"
    assert entry["body"] == "Led is fine"
    assert entry["actor_id"] == ADMIN
    assert entry["actor_name"] == "Adam Admin"
    assert entry["unread"] is True
    assert mine["next_cursor"] is None

    recent = _feed(client, workspace, scope="recent")
    assert [item["project_id"] for item in recent["items"]] == [other, led]


def test_an_unknown_scope_is_refused(client: TestClient, workspace: str) -> None:
    """A scope the feed does not have is a 422 rather than an empty page."""
    sign_in(client, MEMBER)
    assert client.get(f"/api/workspaces/{workspace}/pulse", params={"scope": "all"}).status_code == 422


def test_an_explicit_follow_or_unfollow_wins_over_a_role(client: TestClient, workspace: str) -> None:
    """Following a project brings it into "for me", and a lead who unfollows their own project drops it."""
    sign_in(client, ADMIN)
    led = seed_project(client, workspace, name="Led", lead_id=MEMBER)["project_id"]
    other = seed_project(client, workspace, name="Other")["project_id"]
    _post_update(client, workspace, led)
    _post_update(client, workspace, other)

    sign_in(client, MEMBER)
    path = f"/api/workspaces/{workspace}/projects"
    assert client.get(f"{path}/{led}/follow").json() == {"following": True, "explicit": False}
    assert client.get(f"{path}/{other}/follow").json() == {"following": False, "explicit": False}

    followed = client.put(f"{path}/{other}/follow")
    assert followed.status_code == 200, followed.text
    assert followed.json() == {"following": True, "explicit": True}
    unfollowed = client.delete(f"{path}/{led}/follow")
    assert unfollowed.status_code == 200, unfollowed.text
    assert unfollowed.json() == {"following": False, "explicit": True}

    assert [item["project_id"] for item in _feed(client, workspace)["items"]] == [other]
    assert client.get(f"{path}/{led}/follow").json() == {"following": False, "explicit": True}


def test_following_an_initiative_follows_its_projects(client: TestClient, workspace: str) -> None:
    """An initiative's own updates and those of the projects in it reach a follower, until a project is unfollowed."""
    sign_in(client, ADMIN)
    initiative_id = _initiative(client, workspace)["initiative_id"]
    project_id = seed_project(client, workspace, name="Inside")["project_id"]
    added = client.put(f"/api/workspaces/{workspace}/initiatives/{initiative_id}/projects/{project_id}")
    assert added.status_code == 200, added.text

    sign_in(client, MEMBER)
    initiative_path = f"/api/workspaces/{workspace}/initiatives/{initiative_id}/follow"
    assert client.get(initiative_path).json() == {"following": False, "explicit": False}
    assert client.put(initiative_path).json() == {"following": True, "explicit": True}
    project_path = f"/api/workspaces/{workspace}/projects/{project_id}/follow"
    assert client.get(project_path).json() == {"following": True, "explicit": False}

    sign_in(client, ADMIN)
    _post_update(client, workspace, project_id, body="Project news")
    _post_initiative_update(client, workspace, initiative_id, "Initiative news")

    sign_in(client, MEMBER)
    page = _feed(client, workspace)
    assert _types(page) == ["initiative_update", "project_update"]
    assert page["items"][0]["initiative_name"] == "Expand to Europe"
    assert page["items"][1]["project_name"] == "Inside"
    assert page["items"][1]["initiative_id"] == initiative_id

    assert client.delete(project_path).status_code == 200
    assert _types(_feed(client, workspace)) == ["initiative_update"]


def test_an_initiative_owner_follows_it_without_choosing_to(client: TestClient, workspace: str) -> None:
    """Owning an initiative is a follow, which the owner may still turn off."""
    sign_in(client, ADMIN)
    initiative_id = _initiative(client, workspace, owner_id=MEMBER)["initiative_id"]
    _post_initiative_update(client, workspace, initiative_id, "News")

    sign_in(client, MEMBER)
    assert _types(_feed(client, workspace)) == ["initiative_update"]
    path = f"/api/workspaces/{workspace}/initiatives/{initiative_id}/follow"
    assert client.get(path).json() == {"following": True, "explicit": False}
    client.delete(path)
    assert _feed(client, workspace)["items"] == []


def test_a_guest_sees_neither_initiatives_nor_other_teams(client: TestClient, workspace: str) -> None:
    """A guest reads only the projects of their own team, and every initiative follow route refuses them."""
    sign_in(client, ADMIN)
    initiative_id = _initiative(client, workspace)["initiative_id"]
    _post_initiative_update(client, workspace, initiative_id, "News")
    visible = seed_project(client, workspace, name="Visible")["project_id"]
    hidden = seed_project(client, workspace, name="Hidden", team_id=OTHER_TEAM)["project_id"]
    _post_update(client, workspace, visible)
    _post_update(client, workspace, hidden)

    sign_in(client, GUEST)
    recent = _feed(client, workspace, scope="recent")
    assert [item["project_id"] for item in recent["items"]] == [visible]
    assert recent["items"][0]["initiative_id"] is None
    path = f"/api/workspaces/{workspace}"
    assert client.get(f"{path}/initiatives/{initiative_id}/follow").status_code == 403
    assert client.put(f"{path}/initiatives/{initiative_id}/follow").status_code == 403
    assert client.put(f"{path}/projects/{hidden}/follow").status_code == 404
    assert client.put(f"{path}/projects/{visible}/follow").status_code == 200
    assert [item["project_id"] for item in _feed(client, workspace)["items"]] == [visible]


def test_unread_counts_others_entries_until_the_feed_is_read(client: TestClient, workspace: str) -> None:
    """The badge counts what someone else posted since the marker, and reading the feed clears it."""
    sign_in(client, ADMIN)
    project_id = seed_project(client, workspace, lead_id=MEMBER, member_ids=[ADMIN])["project_id"]
    _post_update(client, workspace, project_id)
    _post_update(client, workspace, project_id)
    assert _count(client, workspace) == 0

    sign_in(client, MEMBER)
    assert _count(client, workspace) == 2
    _post_update(client, workspace, project_id, body="My own")
    assert _count(client, workspace) == 2
    own = _feed(client, workspace)["items"][0]
    assert own["actor_id"] == MEMBER
    assert own["unread"] is False

    read = client.post(f"/api/workspaces/{workspace}/pulse/read")
    assert read.status_code == 200, read.text
    assert read.json()["read_at"]
    assert _count(client, workspace) == 0
    assert all(not item["unread"] for item in _feed(client, workspace)["items"])

    sign_in(client, ADMIN)
    _post_update(client, workspace, project_id, body="After")
    sign_in(client, MEMBER)
    assert _count(client, workspace) == 1


def test_an_edit_carries_onto_the_entry_and_a_delete_removes_it(client: TestClient, workspace: str) -> None:
    """The entry shows the update's current body and health, and a deleted update leaves the feed."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace, lead_id=MEMBER)["project_id"]
    update = _post_update(client, workspace, project_id, body="First draft")
    path = f"/api/workspaces/{workspace}/projects/{project_id}/updates/{update['update_id']}"

    edited = client.patch(path, json={"body": "Second draft", "health": "at_risk"})
    assert edited.status_code == 200, edited.text
    entry = _feed(client, workspace)["items"][0]
    assert entry["update_id"] == update["update_id"]
    assert entry["body"] == "Second draft"
    assert entry["health"] == "at_risk"
    assert entry["edited_at"] is not None

    assert client.delete(path).status_code == 204
    assert _feed(client, workspace)["items"] == []


def test_a_health_set_by_hand_is_posted_once(client: TestClient, workspace: str) -> None:
    """A project patched to a new health posts a health change, and the same health again posts nothing."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace, lead_id=MEMBER)["project_id"]
    path = f"/api/workspaces/{workspace}/projects/{project_id}"
    assert client.patch(path, json={"health": "on_track"}).status_code == 200
    assert client.patch(path, json={"health": "off_track"}).status_code == 200
    assert client.patch(path, json={"health": "off_track"}).status_code == 200

    page = _feed(client, workspace)
    assert _types(page) == ["project_health", "project_health"]
    assert page["items"][0]["health"] == "off_track"
    assert page["items"][0]["previous_health"] == "on_track"


def test_an_initiative_health_change_is_posted(client: TestClient, workspace: str) -> None:
    """An initiative patched to a new health posts an initiative health change for its followers."""
    sign_in(client, MEMBER)
    initiative_id = _initiative(client, workspace, owner_id=MEMBER)["initiative_id"]
    patched = client.patch(f"/api/workspaces/{workspace}/initiatives/{initiative_id}", json={"health": "at_risk"})
    assert patched.status_code == 200, patched.text

    page = _feed(client, workspace)
    assert _types(page) == ["initiative_health"]
    assert page["items"][0]["health"] == "at_risk"


def test_the_feed_pages_with_a_cursor(client: TestClient, workspace: str) -> None:
    """A cursor resumes the same reader's feed, and the last page carries none."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace, lead_id=MEMBER)["project_id"]
    bodies = ["one", "two", "three"]
    for body in bodies:
        _post_update(client, workspace, project_id, body=body)

    first = _feed(client, workspace, limit=2)
    assert [item["body"] for item in first["items"]] == ["three", "two"]
    assert first["next_cursor"]
    second = _feed(client, workspace, limit=2, cursor=first["next_cursor"])
    assert [item["body"] for item in second["items"]] == ["one"]
    assert second["next_cursor"] is None


def _status_ids(repositories: Any) -> "dict[str, str]":
    """The seeded statuses of TEAM, keyed by category."""
    return {row.category: row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, TEAM)}


def _record(image: "dict[str, str]", event_id: str) -> "dict[str, Any]":
    """One stream record carrying an issue's new image."""
    return {
        "eventName": "INSERT",
        "eventID": event_id,
        "dynamodb": {"NewImage": {name: {"S": value} for name, value in image.items() if value}},
    }


def test_a_milestone_is_posted_once_when_its_last_issue_closes(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """Closing a milestone's last open issue posts it once, and reopening then closing it posts it again."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    project_id = seed_project(client, workspace, lead_id=OWNER)["project_id"]
    created = client.post(f"/api/workspaces/{workspace}/projects/{project_id}/milestones", json={"name": "Alpha"})
    assert created.status_code == 201, created.text
    milestone_id = created.json()["milestone_id"]
    statuses = _status_ids(repositories)
    issue = seed_issue(
        issues_client,
        workspace,
        project_id=project_id,
        project_milestone_id=milestone_id,
        status_id=statuses["started"],
    )
    image = {
        "workspace_id": WORKSPACE,
        "issue_id": issue["id"],
        "team_id": TEAM,
        "project_id": project_id,
        "project_milestone_id": milestone_id,
    }

    handle_record(repositories, _record({**image, "status_id": statuses["started"]}, "1"))
    handle_record(repositories, _record({**image, "status_id": statuses["completed"]}, "2"))
    handle_record(repositories, _record({**image, "status_id": statuses["completed"]}, "3"))

    sign_in(client, OWNER)
    page = _feed(client, workspace)
    assert _types(page) == ["milestone_completed"]
    assert page["items"][0]["milestone_name"] == "Alpha"
    assert page["items"][0]["actor_id"] is None
    assert page["items"][0]["actor_name"] == ""

    handle_record(repositories, _record({**image, "status_id": statuses["started"]}, "4"))
    handle_record(repositories, _record({**image, "status_id": statuses["completed"]}, "5"))
    assert _types(_feed(client, workspace)) == ["milestone_completed", "milestone_completed"]
