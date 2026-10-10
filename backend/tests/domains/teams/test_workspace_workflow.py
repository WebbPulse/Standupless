"""Workspace statuses and labels every team inherits, and the team overrides on them.

These pin the inheritance model: workspace records appear live in each team's
effective list tagged `workspace`, a team hides or renames them without copying,
a team cannot edit or delete them through its own routes, and the category
guards hold across every team a workspace delete reaches.
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


def _workspace_status(client: TestClient, name: str = "Review", category: str = "started") -> dict[str, Any]:
    """Create a workspace status as the owner and return it."""
    sign_in(client, OWNER)
    response = client.post(f"{BASE}/statuses", json={"name": name, "category": category, "color": "blue"})
    assert response.status_code == 201, response.text
    return response.json()


def _workspace_label(client: TestClient, name: str = "Bug") -> dict[str, Any]:
    """Create a workspace label as the owner and return it."""
    sign_in(client, OWNER)
    response = client.post(f"{BASE}/labels", json={"name": name, "color": "#eb5757"})
    assert response.status_code == 201, response.text
    return response.json()


def _team_statuses(client: TestClient, team_id: str, **params: Any) -> list[dict[str, Any]]:
    """A team's effective statuses."""
    return client.get(f"{BASE}/teams/{team_id}/statuses", params=params).json()["statuses"]


def _team_labels(client: TestClient, team_id: str, **params: Any) -> list[dict[str, Any]]:
    """A team's effective labels."""
    return client.get(f"{BASE}/teams/{team_id}/labels", params=params).json()["labels"]


def test_a_workspace_status_reaches_every_team(client: TestClient, teams: tuple[str, str]) -> None:
    """One workspace record appears in each team, tagged workspace, under one id."""
    created = _workspace_status(client)
    assert created["scope"] == "workspace"

    for team_id in teams:
        found = [row for row in _team_statuses(client, team_id) if row["id"] == created["id"]]
        assert len(found) == 1
        assert found[0]["scope"] == "workspace"
        assert found[0]["color"] == "blue"
    assert all(row["scope"] == "team" for row in _team_statuses(client, TEAM) if row["id"] != created["id"])


def test_a_workspace_status_edit_is_live_in_every_team(client: TestClient, teams: tuple[str, str]) -> None:
    """A patch on the workspace record shows in each team without a copy."""
    created = _workspace_status(client)
    patched = client.patch(f"{BASE}/statuses/{created['id']}", json={"name": "QA", "icon": "half"})
    assert patched.status_code == 200
    for team_id in teams:
        row = next(row for row in _team_statuses(client, team_id) if row["id"] == created["id"])
        assert (row["name"], row["icon"]) == ("QA", "half")


def test_only_a_workspace_admin_writes_the_workspace_set(client: TestClient, teams: tuple[str, str]) -> None:
    """Members read the workspace set; writes need workspace admin."""
    created = _workspace_status(client)
    label = _workspace_label(client)
    sign_in(client, MEMBER)
    assert client.get(f"{BASE}/statuses").status_code == 200
    assert client.get(f"{BASE}/labels").status_code == 200
    assert client.post(f"{BASE}/statuses", json={"name": "X", "category": "started"}).status_code == 403
    assert client.patch(f"{BASE}/statuses/{created['id']}", json={"name": "X"}).status_code == 403
    assert client.delete(f"{BASE}/labels/{label['id']}").status_code == 403
    sign_in(client, ADMIN)
    assert client.post(f"{BASE}/labels", json={"name": "Chore", "color": "#000000"}).status_code == 201


def test_a_team_cannot_edit_or_delete_an_inherited_record(client: TestClient, teams: tuple[str, str]) -> None:
    """The team routes answer 409 on workspace records and point at the override."""
    status_row = _workspace_status(client)
    label = _workspace_label(client)
    assert client.patch(f"{BASE}/teams/{TEAM}/statuses/{status_row['id']}", json={"name": "X"}).status_code == 409
    assert client.delete(f"{BASE}/teams/{TEAM}/statuses/{status_row['id']}").status_code == 409
    assert client.patch(f"{BASE}/teams/{TEAM}/labels/{label['id']}", json={"name": "X"}).status_code == 409
    assert client.delete(f"{BASE}/teams/{TEAM}/labels/{label['id']}").status_code == 409


def test_hiding_a_status_is_per_team(client: TestClient, teams: tuple[str, str]) -> None:
    """A hidden status leaves one team's list, stays in the other, and returns with include_hidden."""
    created = _workspace_status(client)
    hidden = client.patch(f"{BASE}/teams/{TEAM}/statuses/{created['id']}/override", json={"hidden": True})
    assert hidden.status_code == 200
    assert hidden.json()["hidden"] is True

    assert created["id"] not in {row["id"] for row in _team_statuses(client, TEAM)}
    assert created["id"] in {row["id"] for row in _team_statuses(client, OTHER)}
    with_hidden = _team_statuses(client, TEAM, include_hidden="true")
    assert next(row for row in with_hidden if row["id"] == created["id"])["hidden"] is True

    shown = client.patch(f"{BASE}/teams/{TEAM}/statuses/{created['id']}/override", json={"hidden": False})
    assert shown.json()["hidden"] is False
    assert created["id"] in {row["id"] for row in _team_statuses(client, TEAM)}


def test_a_rename_is_local_and_clears(client: TestClient, teams: tuple[str, str]) -> None:
    """A team rename keeps the workspace name beside it, and a null name or a delete clears it."""
    label = _workspace_label(client)
    path = f"{BASE}/teams/{TEAM}/labels/{label['id']}/override"
    renamed = client.patch(path, json={"name": "Defect"}).json()
    assert (renamed["name"], renamed["inherited_name"]) == ("Defect", "Bug")
    assert next(row for row in _team_labels(client, OTHER) if row["id"] == label["id"])["name"] == "Bug"

    cleared = client.patch(path, json={"name": None}).json()
    assert (cleared["name"], cleared["inherited_name"]) == ("Bug", None)

    client.patch(path, json={"name": "Defect", "hidden": True})
    reset = client.delete(path)
    assert reset.status_code == 200
    assert (reset.json()["name"], reset.json()["hidden"]) == ("Bug", False)


def test_a_team_record_takes_no_override(client: TestClient, teams: tuple[str, str]) -> None:
    """Only inherited records can be hidden or renamed."""
    sign_in(client, OWNER)
    own = _team_statuses(client, TEAM)[0]
    response = client.patch(f"{BASE}/teams/{TEAM}/statuses/{own['id']}/override", json={"hidden": True})
    assert response.status_code == 409


def test_a_team_cannot_hide_its_last_visible_status_of_a_category(client: TestClient, teams: tuple[str, str]) -> None:
    """With the team's own started status gone, the inherited one is the last and cannot be hidden."""
    created = _workspace_status(client)
    own_started = next(
        row for row in _team_statuses(client, TEAM) if row["category"] == "started" and row["scope"] == "team"
    )
    assert client.delete(f"{BASE}/teams/{TEAM}/statuses/{own_started['id']}").status_code == 204

    response = client.patch(f"{BASE}/teams/{TEAM}/statuses/{created['id']}/override", json={"hidden": True})
    assert response.status_code == 409
    assert "visible" in response.json()["message"]


def test_a_workspace_delete_holds_the_category_guard_in_every_team(client: TestClient, teams: tuple[str, str]) -> None:
    """A workspace status that is some team's last of its category cannot be deleted until that changes."""
    created = _workspace_status(client)
    own_started = next(
        row for row in _team_statuses(client, OTHER) if row["category"] == "started" and row["scope"] == "team"
    )
    client.delete(f"{BASE}/teams/{OTHER}/statuses/{own_started['id']}")

    assert client.delete(f"{BASE}/statuses/{created['id']}").status_code == 409
    client.post(f"{BASE}/teams/{OTHER}/statuses", json={"name": "Doing", "category": "started"})
    assert client.delete(f"{BASE}/statuses/{created['id']}").status_code == 204
    assert created["id"] not in {row["id"] for row in _team_statuses(client, TEAM)}


def test_a_workspace_delete_conflict_names_the_team(client: TestClient, teams: tuple[str, str]) -> None:
    """The 409 says which team would be left without a status of the category."""
    created = _workspace_status(client)
    own_started = next(
        row for row in _team_statuses(client, OTHER) if row["category"] == "started" and row["scope"] == "team"
    )
    client.delete(f"{BASE}/teams/{OTHER}/statuses/{own_started['id']}")

    response = client.delete(f"{BASE}/statuses/{created['id']}")
    assert response.status_code == 409
    body = response.json()
    assert "The Gem team" in body["message"]
    assert body["details"] == {"team_id": OTHER, "team_name": "Gem", "category": "started"}


def test_a_hide_conflict_names_the_team(client: TestClient, teams: tuple[str, str]) -> None:
    """Hiding the last visible status of a category names the team in the refusal."""
    created = _workspace_status(client)
    own_started = next(
        row for row in _team_statuses(client, TEAM) if row["category"] == "started" and row["scope"] == "team"
    )
    client.delete(f"{BASE}/teams/{TEAM}/statuses/{own_started['id']}")

    response = client.patch(f"{BASE}/teams/{TEAM}/statuses/{created['id']}/override", json={"hidden": True})
    assert response.status_code == 409
    assert "The Apo team" in response.json()["message"]
    assert response.json()["details"]["team_id"] == TEAM


def test_a_workspace_label_delete_drops_it_everywhere(client: TestClient, teams: tuple[str, str]) -> None:
    """Deleting a workspace label removes it from every team, overrides included."""
    label = _workspace_label(client)
    client.patch(f"{BASE}/teams/{TEAM}/labels/{label['id']}/override", json={"name": "Defect"})
    assert client.delete(f"{BASE}/labels/{label['id']}").status_code == 204
    for team_id in teams:
        assert label["id"] not in {row["id"] for row in _team_labels(client, team_id, include_hidden="true")}


def test_a_new_team_inherits_rather_than_copies(client: TestClient, repositories: Any) -> None:
    """The first team seeds workspace defaults, and a later team gets no copies of its own."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    sign_in(client, OWNER)
    first = client.post(f"{BASE}/teams", json={"name": "Apollo", "key_prefix": "APO"}).json()["id"]
    second = client.post(f"{BASE}/teams", json={"name": "Gemini", "key_prefix": "GEM"}).json()["id"]

    first_rows = _team_statuses(client, first)
    second_rows = _team_statuses(client, second)
    assert {row["scope"] for row in first_rows + second_rows} == {"workspace"}
    assert [row["id"] for row in first_rows] == [row["id"] for row in second_rows]
    assert len(client.get(f"{BASE}/statuses").json()["statuses"]) == 5


def test_a_new_team_copies_only_the_categories_the_workspace_lacks(client: TestClient, teams: tuple[str, str]) -> None:
    """In a workspace that predates workspace statuses, a new team gets copies only for uncovered categories."""
    _workspace_status(client, "Review", "started")
    created = client.post(f"{BASE}/teams", json={"name": "Mercury", "key_prefix": "MER"}).json()["id"]
    rows = _team_statuses(client, created)
    started = [row for row in rows if row["category"] == "started"]
    assert [(row["name"], row["scope"]) for row in started] == [("Review", "workspace")]
    assert {row["category"] for row in rows if row["scope"] == "team"} == {
        "backlog",
        "unstarted",
        "completed",
        "cancelled",
    }


def test_a_workspace_label_cannot_take_a_name_a_team_already_uses(client: TestClient, teams: tuple[str, str]) -> None:
    """Every team would see both, so the workspace label is refused and the team named."""
    sign_in(client, OWNER)
    assert client.post(f"{BASE}/teams/{OTHER}/labels", json={"name": "Bug", "color": "#eb5757"}).status_code == 201

    response = client.post(f"{BASE}/labels", json={"name": "BUG", "color": "#eb5757"})

    assert response.status_code == 409
    assert "in the Gem team" in response.json()["message"]


def test_a_team_label_cannot_take_an_inherited_name(client: TestClient, teams: tuple[str, str]) -> None:
    """A team's own label is refused when a workspace label it inherits has the name."""
    label = _workspace_label(client)

    response = client.post(f"{BASE}/teams/{TEAM}/labels", json={"name": "bug", "color": "#eb5757"})

    assert response.status_code == 409
    assert response.json()["details"]["label_id"] == label["id"]


def test_a_team_rename_of_an_inherited_label_is_held_to_the_rule(client: TestClient, teams: tuple[str, str]) -> None:
    """An override rename onto a name the team already has is refused, and one to a free name is not."""
    label = _workspace_label(client)
    client.post(f"{BASE}/teams/{TEAM}/labels", json={"name": "Defect", "color": "#eb5757"})
    path = f"{BASE}/teams/{TEAM}/labels/{label['id']}/override"

    assert client.patch(path, json={"name": "defect"}).status_code == 409
    assert client.patch(f"{BASE}/teams/{OTHER}/labels/{label['id']}/override", json={"name": "defect"}).status_code == 200
    assert client.patch(path, json={"name": "Fault"}).status_code == 200


def test_an_existing_duplicate_still_takes_other_edits(client: TestClient, teams: tuple[str, str], repositories: Any) -> None:
    """Duplicates stored before the rule keep working: a colour change on one is not refused."""
    from app.common.db.dynamo.team_config import WORKSPACE_SCOPE, Label, new_config_id, workspace_label_key

    label = _workspace_label(client)
    copy_id = new_config_id()
    repositories.team_config.create_label(
        Label(
            workspace_id=WORKSPACE,
            config_key=workspace_label_key(copy_id),
            label_id=copy_id,
            name="bug",
            color="#eb5757",
            scope=WORKSPACE_SCOPE,
        )
    )

    response = client.patch(f"{BASE}/labels/{label['id']}", json={"color": "#4ea7fc"})

    assert response.status_code == 200


def test_a_workspace_status_inserted_mid_list_moves_the_rest_up(client: TestClient, teams: tuple[str, str]) -> None:
    """Workspace statuses keep unique positions when one is added or moved onto a taken one."""
    first = _workspace_status(client, "Review")
    second = _workspace_status(client, "Staging")
    assert (first["position"], second["position"]) == (0, 1)

    inserted = client.post(f"{BASE}/statuses", json={"name": "QA", "category": "started", "position": 1})
    assert inserted.status_code == 201
    moved = client.patch(f"{BASE}/statuses/{second['id']}", json={"position": 0})
    assert moved.status_code == 200

    rows = client.get(f"{BASE}/statuses").json()["statuses"]
    assert [(row["name"], row["position"]) for row in rows] == [("Staging", 0), ("Review", 1), ("QA", 2)]
