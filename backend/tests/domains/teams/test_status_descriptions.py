"""Workflow status descriptions: the line a status picker shows under a status name.

These pin that a team or workspace status takes an optional description on
create and update, that a null or blank one clears it, that teams inherit a
workspace status's description live, and that a team override describes an
inherited status in that team only, keeping the inherited description beside it.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_member, make_team, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

OTHER = "01JB000000000000000000PRJ2"

BASE = f"/api/workspaces/{WORKSPACE}"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["teams"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def teams(repositories: Any) -> tuple[str, str]:
    """A workspace with an admin and a member, holding two teams with their own seeded statuses."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    make_team(repositories, WORKSPACE, TEAM, "APO")
    make_team(repositories, WORKSPACE, OTHER, "GEM")
    return TEAM, OTHER


def _team_row(client: TestClient, team_id: str, status_id: str) -> dict[str, Any]:
    """One status as a team's effective list answers it."""
    rows = client.get(f"{BASE}/teams/{team_id}/statuses").json()["statuses"]
    return next(row for row in rows if row["id"] == status_id)


def test_a_team_status_takes_a_description(client: TestClient, teams: tuple[str, str]) -> None:
    """Create with one, reword it, and clear it with a null or a blank."""
    sign_in(client, OWNER)
    created = client.post(
        f"{BASE}/teams/{TEAM}/statuses",
        json={"name": "On Staging", "category": "started", "description": "  Merged into staging  "},
    )
    assert created.status_code == 201, created.text
    status_id = created.json()["id"]
    assert created.json()["description"] == "Merged into staging"
    assert _team_row(client, TEAM, status_id)["description"] == "Merged into staging"

    path = f"{BASE}/teams/{TEAM}/statuses/{status_id}"
    reworded = client.patch(path, json={"description": "Live on staging"})
    assert reworded.json()["description"] == "Live on staging"
    renamed = client.patch(path, json={"name": "Staging"})
    assert (renamed.json()["name"], renamed.json()["description"]) == ("Staging", "Live on staging")

    assert client.patch(path, json={"description": None}).json()["description"] is None
    client.patch(path, json={"description": "Back again"})
    assert client.patch(path, json={"description": "   "}).json()["description"] is None
    assert _team_row(client, TEAM, status_id)["description"] is None


def test_a_status_description_has_a_length_limit(client: TestClient, teams: tuple[str, str]) -> None:
    """A description longer than 255 characters is a 422."""
    sign_in(client, OWNER)
    response = client.post(
        f"{BASE}/teams/{TEAM}/statuses", json={"name": "Long", "category": "started", "description": "x" * 256}
    )
    assert response.status_code == 422


def test_a_status_without_a_description_reads_as_none(client: TestClient, teams: tuple[str, str]) -> None:
    """Seeded statuses and ones created without a description answer null."""
    sign_in(client, OWNER)
    rows = client.get(f"{BASE}/teams/{TEAM}/statuses").json()["statuses"]
    assert rows and all(row["description"] is None for row in rows)
    assert all(row["inherited_description"] is None for row in rows)


def test_a_workspace_description_reaches_every_team(client: TestClient, teams: tuple[str, str]) -> None:
    """A workspace status's description, and an edit of it, show live in each team."""
    sign_in(client, OWNER)
    created = client.post(
        f"{BASE}/statuses", json={"name": "Review", "category": "started", "description": "Waiting on a reviewer"}
    ).json()
    for team_id in teams:
        assert _team_row(client, team_id, created["id"])["description"] == "Waiting on a reviewer"

    client.patch(f"{BASE}/statuses/{created['id']}", json={"description": "Waiting on review"})
    for team_id in teams:
        row = _team_row(client, team_id, created["id"])
        assert (row["description"], row["inherited_description"]) == ("Waiting on review", None)


def test_a_team_describes_an_inherited_status_locally(client: TestClient, teams: tuple[str, str]) -> None:
    """The override describes it in one team, keeps the inherited one beside it, and clears."""
    sign_in(client, OWNER)
    created = client.post(
        f"{BASE}/statuses", json={"name": "Review", "category": "started", "description": "Waiting on review"}
    ).json()
    path = f"{BASE}/teams/{TEAM}/statuses/{created['id']}/override"

    local = client.patch(path, json={"description": "Two approvals needed"})
    assert local.status_code == 200, local.text
    assert (local.json()["description"], local.json()["inherited_description"]) == (
        "Two approvals needed",
        "Waiting on review",
    )
    assert local.json()["name"] == "Review"
    assert _team_row(client, OTHER, created["id"])["description"] == "Waiting on review"

    client.patch(f"{BASE}/statuses/{created['id']}", json={"description": "Needs a reviewer"})
    row = _team_row(client, TEAM, created["id"])
    assert (row["description"], row["inherited_description"]) == ("Two approvals needed", "Needs a reviewer")

    cleared = client.patch(path, json={"description": None}).json()
    assert (cleared["description"], cleared["inherited_description"]) == ("Needs a reviewer", None)

    client.patch(path, json={"description": "Two approvals needed", "name": "Code review"})
    reset = client.delete(path).json()
    assert (reset["name"], reset["description"], reset["inherited_description"]) == (
        "Review",
        "Needs a reviewer",
        None,
    )


def test_a_local_description_of_an_undescribed_status_marks_the_override(
    client: TestClient, teams: tuple[str, str]
) -> None:
    """When the inherited status has no description, the override answers an empty inherited one."""
    sign_in(client, OWNER)
    created = client.post(f"{BASE}/statuses", json={"name": "Review", "category": "started"}).json()
    local = client.patch(
        f"{BASE}/teams/{TEAM}/statuses/{created['id']}/override", json={"description": "Two approvals needed"}
    ).json()
    assert (local["description"], local["inherited_description"]) == ("Two approvals needed", "")


def test_a_hide_keeps_the_local_description(client: TestClient, teams: tuple[str, str]) -> None:
    """Hiding and showing an inherited status leaves its team description in place."""
    sign_in(client, OWNER)
    created = client.post(f"{BASE}/statuses", json={"name": "Review", "category": "started"}).json()
    path = f"{BASE}/teams/{TEAM}/statuses/{created['id']}/override"
    client.patch(path, json={"description": "Two approvals needed"})
    client.patch(path, json={"hidden": True})
    shown = client.patch(path, json={"hidden": False}).json()
    assert (shown["hidden"], shown["description"]) == (False, "Two approvals needed")


def test_a_member_cannot_describe_a_status(client: TestClient, teams: tuple[str, str]) -> None:
    """Describing a status is a status write, held to admin like the rest."""
    sign_in(client, OWNER)
    created = client.post(f"{BASE}/statuses", json={"name": "Review", "category": "started"}).json()
    sign_in(client, MEMBER)
    assert client.patch(f"{BASE}/statuses/{created['id']}", json={"description": "X"}).status_code == 403
