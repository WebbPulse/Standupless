"""The team cycle settings routes, against real tables in moto.

These pin who may read and change the settings, the ranges each field is held
to, that turning cycles on creates the team's cycles before the response, and
that turning them off or deleting the team never brings cycles back.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.team_config import cycle_settings_key
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_member, make_team, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

URL = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/cycle-settings"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["teams"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def team(repositories: Any) -> str:
    """A workspace with every role, holding one team."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    make_team(repositories, WORKSPACE, TEAM, "APO")
    return TEAM


def test_unsaved_settings_read_as_the_defaults(client: TestClient, team: str) -> None:
    """Cycles are off by default, two week cycles from Monday with two upcoming."""
    sign_in(client, MEMBER)
    response = client.get(URL)

    assert response.status_code == 200
    assert response.json() == {
        "team_id": team,
        "enabled": False,
        "duration_weeks": 2,
        "cooldown_weeks": 0,
        "start_weekday": 0,
        "upcoming_count": 2,
        "auto_add_started": True,
        "updated_at": None,
    }


def test_a_guest_outside_the_team_cannot_read_them(client: TestClient, team: str) -> None:
    """The settings are as hidden as the team itself."""
    sign_in(client, GUEST)
    assert client.get(URL).status_code == 404


def test_a_plain_member_cannot_change_them(client: TestClient, team: str) -> None:
    """Changing cycles is a team admin decision."""
    sign_in(client, MEMBER)
    assert client.patch(URL, json={"enabled": True}).status_code == 403


@pytest.mark.parametrize(
    "body",
    [
        {"duration_weeks": 0},
        {"duration_weeks": 9},
        {"cooldown_weeks": 3},
        {"cooldown_weeks": -1},
        {"start_weekday": 7},
        {"upcoming_count": 0},
        {"upcoming_count": 16},
    ],
)
def test_out_of_range_values_are_refused(client: TestClient, team: str, body: "dict[str, Any]") -> None:
    """Length 1 to 8 weeks, cooldown 0 to 2, weekday 0 to 6, upcoming 1 to 15."""
    sign_in(client, ADMIN)
    assert client.patch(URL, json=body).status_code == 422


def test_turning_cycles_on_creates_them_at_once(client: TestClient, team: str, repositories: Any) -> None:
    """The response comes back after the current and upcoming cycles exist."""
    sign_in(client, ADMIN)
    response = client.patch(URL, json={"enabled": True, "duration_weeks": 1, "upcoming_count": 3})

    assert response.status_code == 200
    body = response.json()
    assert body["enabled"] is True
    assert body["duration_weeks"] == 1
    assert body["upcoming_count"] == 3
    assert body["updated_at"] is not None
    cycles = repositories.planning.list_for_roadmap(WORKSPACE, team)
    assert [c.name for c in cycles] == ["Cycle 1", "Cycle 2", "Cycle 3", "Cycle 4"]
    assert client.get(URL).json()["enabled"] is True


def test_a_repeat_patch_creates_nothing_new(client: TestClient, team: str, repositories: Any) -> None:
    """Saving the same settings again leaves the cycles as they are."""
    sign_in(client, ADMIN)
    client.patch(URL, json={"enabled": True})
    client.patch(URL, json={"enabled": True})

    assert len(repositories.planning.list_for_roadmap(WORKSPACE, team)) == 3


def test_raising_the_upcoming_count_tops_the_chain_up(client: TestClient, team: str, repositories: Any) -> None:
    """More upcoming cycles are added after the ones already there."""
    sign_in(client, ADMIN)
    client.patch(URL, json={"enabled": True})
    client.patch(URL, json={"upcoming_count": 4})

    assert len(repositories.planning.list_for_roadmap(WORKSPACE, team)) == 5


def test_turning_cycles_off_keeps_the_cycles(client: TestClient, team: str, repositories: Any) -> None:
    """Off stops new cycles; nothing already created is removed."""
    sign_in(client, ADMIN)
    client.patch(URL, json={"enabled": True})
    response = client.patch(URL, json={"enabled": False})

    assert response.json()["enabled"] is False
    assert len(repositories.planning.list_for_roadmap(WORKSPACE, team)) == 3


def test_deleting_the_team_removes_the_settings(client: TestClient, team: str, repositories: Any) -> None:
    """The team purge takes the settings row with the rest of the team's config."""
    sign_in(client, OWNER)
    client.patch(URL, json={"enabled": True})
    assert repositories.team_config.get_cycle_settings(WORKSPACE, team) is not None

    assert client.delete(f"/api/workspaces/{WORKSPACE}/teams/{team}").status_code == 204

    assert repositories.team_config.get_cycle_settings(WORKSPACE, team) is None
    assert cycle_settings_key(team) == f"team#{team}#cycles"
