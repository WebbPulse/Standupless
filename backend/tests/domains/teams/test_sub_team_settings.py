"""A sub-team takes its parent's estimate and cycle settings, as in Linear.

The parent's settings are copied onto a sub-team when it is created under the
parent or joins it, and again whenever the parent changes them. A sub-team
changing either is a 409 pointing at the parent, while a patch repeating the
values it already has still goes through.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import OWNER, make_team, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

PARENT = "01JB000000000000000000PRJ1"

LONER = "01JB000000000000000000PRJ2"

BASE = f"/api/workspaces/{WORKSPACE}"

ESTIMATES = {
    "estimate_scale": "exponential",
    "estimate_extended": True,
    "estimate_allow_zero": True,
    "estimate_count_unestimated": True,
}

CYCLES = {"enabled": True, "duration_weeks": 1, "cooldown_weeks": 1, "start_weekday": 2, "upcoming_count": 3}


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application signed in as the owner, with two top-level teams."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["teams"])
    bind_repositories(app, repositories)
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    make_team(repositories, WORKSPACE, PARENT, "APO")
    make_team(repositories, WORKSPACE, LONER, "GEM")
    with TestClient(app) as test_client:
        sign_in(test_client, OWNER)
        yield test_client


def _team(client: TestClient, team_id: str) -> dict[str, Any]:
    """A team as the API answers it."""
    response = client.get(f"{BASE}/teams/{team_id}")
    assert response.status_code == 200, response.text
    return response.json()


def _cycles(client: TestClient, team_id: str) -> dict[str, Any]:
    """A team's cycle settings without the save time."""
    response = client.get(f"{BASE}/teams/{team_id}/cycle-settings")
    assert response.status_code == 200, response.text
    return {key: value for key, value in response.json().items() if key not in ("team_id", "updated_at")}


def _configure_parent(client: TestClient) -> None:
    """Give the parent estimates and cycles that differ from the defaults."""
    estimates = client.patch(f"{BASE}/teams/{PARENT}", json=ESTIMATES)
    assert estimates.status_code == 200, estimates.text
    cycles = client.patch(f"{BASE}/teams/{PARENT}/cycle-settings", json=CYCLES)
    assert cycles.status_code == 200, cycles.text


def _join(client: TestClient) -> None:
    """Put the loner under the parent."""
    response = client.patch(f"{BASE}/teams/{LONER}", json={"parent_team_id": PARENT})
    assert response.status_code == 200, response.text


def _assert_inherits(client: TestClient, team_id: str) -> None:
    """The team's estimate and cycle settings read as the parent's."""
    team = _team(client, team_id)
    assert {name: team[name] for name in ESTIMATES} == ESTIMATES
    assert _cycles(client, team_id) == _cycles(client, PARENT)


def test_a_team_created_under_a_parent_takes_its_settings(client: TestClient) -> None:
    """Create-with-parent copies the parent's estimates and cycle schedule."""
    _configure_parent(client)

    response = client.post(f"{BASE}/teams", json={"name": "Sub", "key_prefix": "SUB", "parent_team_id": PARENT})

    assert response.status_code == 201, response.text
    assert {name: response.json()[name] for name in ESTIMATES} == ESTIMATES
    _assert_inherits(client, response.json()["id"])


def test_a_joining_team_takes_its_parents_settings(client: TestClient) -> None:
    """Joining replaces the team's own estimates and cycle schedule with the parent's."""
    _configure_parent(client)
    client.patch(f"{BASE}/teams/{LONER}", json={"estimate_scale": "tshirt"})

    _join(client)

    _assert_inherits(client, LONER)


def test_a_parents_changes_reach_its_sub_teams(client: TestClient) -> None:
    """Changing the parent's estimates or cycles changes every sub-team's with them."""
    _join(client)

    _configure_parent(client)

    _assert_inherits(client, LONER)


def test_a_sub_team_cannot_change_its_estimates(client: TestClient) -> None:
    """A sub-team's estimate change is a 409, while a patch repeating its values goes through."""
    _configure_parent(client)
    _join(client)

    refused = client.patch(f"{BASE}/teams/{LONER}", json={"estimate_scale": "linear"})
    repeated = client.patch(f"{BASE}/teams/{LONER}", json={**ESTIMATES, "name": "Gemini"})

    assert refused.status_code == 409, refused.text
    assert "parent team" in refused.json()["message"]
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["name"] == "Gemini"
    assert _team(client, LONER)["estimate_scale"] == "exponential"


def test_a_sub_team_cannot_change_its_cycle_settings(client: TestClient) -> None:
    """A sub-team runs on its parent's cycle schedule, so changing its own is a 409."""
    _join(client)

    response = client.patch(f"{BASE}/teams/{LONER}/cycle-settings", json={"enabled": True})

    assert response.status_code == 409, response.text
    assert _cycles(client, LONER)["enabled"] is False


def test_a_team_leaving_its_parent_keeps_the_settings_and_may_change_them(client: TestClient) -> None:
    """A team made top level again keeps what it inherited and owns its settings from then on."""
    _configure_parent(client)
    _join(client)

    left = client.patch(f"{BASE}/teams/{LONER}", json={"parent_team_id": None})
    changed = client.patch(f"{BASE}/teams/{LONER}/cycle-settings", json={"enabled": False})

    assert left.status_code == 200, left.text
    assert left.json()["estimate_scale"] == "exponential"
    assert changed.status_code == 200, changed.text
    assert client.patch(f"{BASE}/teams/{LONER}", json={"estimate_scale": "linear"}).status_code == 200
