"""Sub-teams: a team under one parent team, inheriting its statuses and labels.

These pin the nesting rules, one level and no cycles, the live inheritance of
the parent's own statuses and labels tagged `parent`, the overrides a sub-team
keeps on them, and what a team leaving its parent is left with.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_member, make_team, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

PARENT = "01JB000000000000000000PRJ1"

LONER = "01JB000000000000000000PRJ2"

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
def workspace(repositories: Any) -> str:
    """A workspace with an admin and a member and two top-level teams with seeded statuses."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    make_team(repositories, WORKSPACE, PARENT, "APO")
    make_team(repositories, WORKSPACE, LONER, "GEM")
    return WORKSPACE


def _create_sub_team(client: TestClient, key: str = "SUB", parent: str = PARENT) -> dict[str, Any]:
    """Create a team under `parent` as the owner and return it."""
    sign_in(client, OWNER)
    response = client.post(f"{BASE}/teams", json={"name": key.title(), "key_prefix": key, "parent_team_id": parent})
    assert response.status_code == 201, response.text
    return response.json()


def _statuses(client: TestClient, team_id: str, **params: Any) -> list[dict[str, Any]]:
    """A team's effective statuses."""
    response = client.get(f"{BASE}/teams/{team_id}/statuses", params=params)
    assert response.status_code == 200, response.text
    return response.json()["statuses"]


def _labels(client: TestClient, team_id: str, **params: Any) -> list[dict[str, Any]]:
    """A team's effective labels."""
    response = client.get(f"{BASE}/teams/{team_id}/labels", params=params)
    assert response.status_code == 200, response.text
    return response.json()["labels"]


def _label(client: TestClient, team_id: str, name: str = "Bug") -> dict[str, Any]:
    """Create a team label as the owner and return it."""
    sign_in(client, OWNER)
    response = client.post(f"{BASE}/teams/{team_id}/labels", json={"name": name, "color": "#eb5757"})
    assert response.status_code == 201, response.text
    return response.json()


def test_a_sub_team_starts_on_its_parents_workflow(client: TestClient, workspace: str) -> None:
    """A team created under a parent copies no defaults and reads the parent's statuses tagged parent."""
    sub = _create_sub_team(client)
    assert sub["parent_team_id"] == PARENT
    assert client.get(f"{BASE}/teams/{sub['id']}").json()["parent_team_id"] == PARENT

    parent_ids = {row["id"] for row in _statuses(client, PARENT)}
    rows = _statuses(client, sub["id"])
    assert {row["id"] for row in rows} == parent_ids
    assert {row["scope"] for row in rows} == {"parent"}
    assert {row["scope"] for row in _statuses(client, PARENT)} == {"team"}


def test_the_team_list_carries_and_filters_by_parent(client: TestClient, workspace: str) -> None:
    """Every listed team names its parent, and `parent_team_id` narrows the list to the sub-teams."""
    sub = _create_sub_team(client)
    listed = {row["id"]: row["parent_team_id"] for row in client.get(f"{BASE}/teams").json()["teams"]}
    assert listed == {PARENT: None, LONER: None, sub["id"]: PARENT}

    narrowed = client.get(f"{BASE}/teams", params={"parent_team_id": PARENT}).json()["teams"]
    assert [row["id"] for row in narrowed] == [sub["id"]]


def test_teams_nest_one_level_without_cycles(client: TestClient, workspace: str) -> None:
    """Self, missing and sub-team parents are refused, and so is a parent for a team with sub-teams."""
    sub = _create_sub_team(client)

    assert client.patch(f"{BASE}/teams/{LONER}", json={"parent_team_id": LONER}).status_code == 422
    missing = "01JB000000000000000000NONE"
    assert client.patch(f"{BASE}/teams/{LONER}", json={"parent_team_id": missing}).status_code == 422
    assert client.patch(f"{BASE}/teams/{LONER}", json={"parent_team_id": sub["id"]}).status_code == 422
    assert client.patch(f"{BASE}/teams/{PARENT}", json={"parent_team_id": LONER}).status_code == 422
    nested = client.post(f"{BASE}/teams", json={"name": "Deep", "key_prefix": "DEEP", "parent_team_id": sub["id"]})
    assert nested.status_code == 422
    assert client.get(f"{BASE}/teams/{PARENT}").json()["parent_team_id"] is None


def test_a_parent_status_change_is_live_in_the_sub_team(client: TestClient, workspace: str) -> None:
    """A status the parent adds or renames shows in the sub-team without a copy."""
    sub = _create_sub_team(client)
    created = client.post(f"{BASE}/teams/{PARENT}/statuses", json={"name": "Review", "category": "started"})
    assert created.status_code == 201, created.text
    status_id = created.json()["id"]
    assert client.patch(f"{BASE}/teams/{PARENT}/statuses/{status_id}", json={"name": "QA"}).status_code == 200

    row = next(row for row in _statuses(client, sub["id"]) if row["id"] == status_id)
    assert (row["name"], row["scope"]) == ("QA", "parent")


def test_a_sub_team_overrides_but_cannot_edit_an_inherited_record(client: TestClient, workspace: str) -> None:
    """The sub-team routes refuse edits to the parent's rows, and overrides stay per team."""
    sub = _create_sub_team(client)
    label = _label(client, PARENT)
    created = client.post(f"{BASE}/teams/{PARENT}/statuses", json={"name": "Review", "category": "started"})
    assert created.status_code == 201, created.text
    status_id = created.json()["id"]

    assert client.patch(f"{BASE}/teams/{sub['id']}/labels/{label['id']}", json={"name": "X"}).status_code == 409
    assert client.delete(f"{BASE}/teams/{sub['id']}/statuses/{status_id}").status_code == 409

    renamed = client.patch(f"{BASE}/teams/{sub['id']}/labels/{label['id']}/override", json={"name": "Defect"})
    assert renamed.status_code == 200, renamed.text
    assert (renamed.json()["name"], renamed.json()["inherited_name"]) == ("Defect", "Bug")
    assert next(row for row in _labels(client, PARENT) if row["id"] == label["id"])["name"] == "Bug"

    hidden = client.patch(f"{BASE}/teams/{sub['id']}/statuses/{status_id}/override", json={"hidden": True})
    assert hidden.status_code == 200, hidden.text
    assert status_id not in {row["id"] for row in _statuses(client, sub["id"])}
    assert status_id in {row["id"] for row in _statuses(client, PARENT)}


def test_a_parent_label_name_must_be_free_in_its_sub_teams(client: TestClient, workspace: str) -> None:
    """A parent label cannot take a name one of its sub-teams already uses, nor the reverse."""
    sub = _create_sub_team(client)
    _label(client, sub["id"], "Infra")
    clash = client.post(f"{BASE}/teams/{PARENT}/labels", json={"name": "infra", "color": "#000000"})
    assert clash.status_code == 409

    _label(client, PARENT, "Bug")
    reverse = client.post(f"{BASE}/teams/{sub['id']}/labels", json={"name": "Bug", "color": "#000000"})
    assert reverse.status_code == 409


def test_a_parent_with_sub_teams_cannot_be_deleted(client: TestClient, workspace: str) -> None:
    """Deleting a parent while sub-teams point at it is a 409, and works once they leave."""
    sub = _create_sub_team(client)
    assert client.delete(f"{BASE}/teams/{PARENT}").status_code == 409
    assert client.patch(f"{BASE}/teams/{sub['id']}", json={"parent_team_id": None}).status_code == 200
    assert client.delete(f"{BASE}/teams/{PARENT}").status_code == 204


def test_leaving_a_parent_leaves_a_full_workflow_of_its_own(client: TestClient, workspace: str) -> None:
    """A team made top-level again gets its own statuses for every category and loses the parent's labels."""
    sub = _create_sub_team(client)
    _label(client, PARENT, "Bug")
    assert {row["name"] for row in _labels(client, sub["id"])} == {"Bug"}

    response = client.patch(f"{BASE}/teams/{sub['id']}", json={"parent_team_id": None})
    assert response.status_code == 200, response.text
    assert response.json()["parent_team_id"] is None

    rows = _statuses(client, sub["id"])
    assert {row["scope"] for row in rows} == {"team"}
    assert {row["category"] for row in rows} >= {"backlog", "unstarted", "started", "completed", "cancelled"}
    assert _labels(client, sub["id"]) == []


def test_an_existing_team_joins_a_parent(client: TestClient, workspace: str) -> None:
    """A top-level team put under a parent keeps its own statuses and gains the parent's."""
    sign_in(client, OWNER)
    own = {row["id"] for row in _statuses(client, LONER)}
    response = client.patch(f"{BASE}/teams/{LONER}", json={"parent_team_id": PARENT})
    assert response.status_code == 200, response.text
    assert response.json()["parent_team_id"] == PARENT

    rows = _statuses(client, LONER)
    assert {row["id"] for row in rows if row["scope"] == "team"} == own
    assert {row["id"] for row in rows if row["scope"] == "parent"} == {row["id"] for row in _statuses(client, PARENT)}


def test_a_change_of_parent_is_audited(client: TestClient, workspace: str, repositories: Any) -> None:
    """Joining and leaving a parent each record the parent before and after; other edits record nothing."""
    sign_in(client, OWNER)
    assert client.patch(f"{BASE}/teams/{LONER}", json={"parent_team_id": PARENT}).status_code == 200
    assert client.patch(f"{BASE}/teams/{LONER}", json={"parent_team_id": PARENT}).status_code == 200
    assert client.patch(f"{BASE}/teams/{LONER}", json={"description": "Gems"}).status_code == 200
    assert client.patch(f"{BASE}/teams/{LONER}", json={"parent_team_id": None}).status_code == 200

    rows = [row for row in repositories.audit.list_events(WORKSPACE).events if row.action == "team.parent_changed"]
    assert [(row.before, row.after) for row in reversed(rows)] == [
        ({"parent_team_id": None}, {"parent_team_id": PARENT}),
        ({"parent_team_id": PARENT}, {"parent_team_id": None}),
    ]
    assert {(row.target.id, row.actor.id) for row in rows} == {(LONER, OWNER)}


def test_a_member_cannot_move_a_team(client: TestClient, workspace: str) -> None:
    """Changing the parent is a team admin write like any other team setting."""
    sign_in(client, MEMBER)
    assert client.patch(f"{BASE}/teams/{LONER}", json={"parent_team_id": PARENT}).status_code == 403
