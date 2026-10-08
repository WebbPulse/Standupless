"""The team auto-close settings routes, against real tables in moto.

These pin who may read and change the period, that it is held to Linear's own
choices, that a null period turns it off, that the status must be one of the
team's cancelled statuses, and that deleting the team removes the row.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.team_config import auto_close_settings_key
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_member, make_team, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

URL = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/auto-close-settings"


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


def _status(repositories: Any, category: str) -> str:
    """The id of the team's seeded status in one category."""
    rows = repositories.team_config.list_statuses(WORKSPACE, TEAM)
    return next(row.status_id for row in rows if row.category == category)


def test_unsaved_settings_read_as_off(client: TestClient, team: str) -> None:
    """Auto-close is off until a team admin picks a period."""
    sign_in(client, MEMBER)
    response = client.get(URL)

    assert response.status_code == 200
    assert response.json() == {
        "team_id": team,
        "enabled": False,
        "period_months": None,
        "status_id": None,
        "updated_at": None,
    }


def test_a_guest_outside_the_team_cannot_read_them(client: TestClient, team: str) -> None:
    """The setting is as hidden as the team itself."""
    sign_in(client, GUEST)
    assert client.get(URL).status_code == 404


def test_a_plain_member_cannot_change_them(client: TestClient, team: str) -> None:
    """Changing the period is a team admin decision."""
    sign_in(client, MEMBER)
    assert client.patch(URL, json={"period_months": 3}).status_code == 403


@pytest.mark.parametrize("period", [0, 2, 4, 13, 24, "six"])
def test_periods_outside_the_choices_are_refused(client: TestClient, team: str, period: Any) -> None:
    """Only 1, 3, 6, 9 and 12 months are accepted."""
    sign_in(client, ADMIN)
    assert client.patch(URL, json={"period_months": period}).status_code == 422


@pytest.mark.parametrize("period", [1, 3, 6, 9, 12])
def test_an_admin_sets_each_period(client: TestClient, team: str, period: int) -> None:
    """Every choice saves, turns auto-close on and reads back."""
    sign_in(client, ADMIN)
    response = client.patch(URL, json={"period_months": period})

    assert response.status_code == 200
    assert response.json()["enabled"] is True
    assert response.json()["updated_at"] is not None
    assert client.get(URL).json()["period_months"] == period


def test_a_null_period_turns_it_off(client: TestClient, team: str) -> None:
    """Sending null clears the period, and an empty patch keeps what was saved."""
    sign_in(client, ADMIN)
    client.patch(URL, json={"period_months": 9})
    assert client.patch(URL, json={}).json()["period_months"] == 9

    response = client.patch(URL, json={"period_months": None})

    assert response.status_code == 200
    assert (response.json()["enabled"], response.json()["period_months"]) == (False, None)


def test_the_status_must_be_cancelled(client: TestClient, team: str, repositories: Any) -> None:
    """A cancelled status of the team saves; an open one or an unknown id is refused."""
    sign_in(client, ADMIN)
    cancelled = _status(repositories, "cancelled")

    saved = client.patch(URL, json={"period_months": 3, "status_id": cancelled})
    backlog = client.patch(URL, json={"status_id": _status(repositories, "backlog")})
    unknown = client.patch(URL, json={"status_id": "01JB0000000000000000MISSNG"})

    assert saved.status_code == 200
    assert saved.json()["status_id"] == cancelled
    assert backlog.status_code == 422
    assert unknown.status_code == 422
    assert client.patch(URL, json={"status_id": None}).json()["status_id"] is None


def test_deleting_the_team_removes_the_settings(client: TestClient, team: str, repositories: Any) -> None:
    """The team purge takes the settings row with the rest of the team's config."""
    sign_in(client, OWNER)
    client.patch(URL, json={"period_months": 1})
    assert repositories.team_config.get_auto_close_settings(WORKSPACE, team) is not None

    assert client.delete(f"/api/workspaces/{WORKSPACE}/teams/{team}").status_code == 204

    assert repositories.team_config.get_auto_close_settings(WORKSPACE, team) is None
    assert auto_close_settings_key(team) == f"team#{team}#autoclose"
