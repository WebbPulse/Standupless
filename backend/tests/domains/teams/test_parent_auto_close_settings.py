"""The team parent and sub-issue auto-close settings routes, against real tables in moto.

These pin that both switches read as off until saved, who may read and change
them, that a patch changes only the fields it names, and that deleting the team
removes the row.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.team_config import parent_auto_close_settings_key
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_member, make_team, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

URL = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/parent-auto-close-settings"


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


def test_unsaved_settings_read_as_off(client: TestClient, team: str) -> None:
    """Both switches are off until a team admin turns one on, as in Linear."""
    sign_in(client, MEMBER)
    response = client.get(URL)

    assert response.status_code == 200
    assert response.json() == {
        "team_id": team,
        "close_parent": False,
        "close_sub_issues": False,
        "updated_at": None,
    }


def test_a_guest_outside_the_team_cannot_read_them(client: TestClient, team: str) -> None:
    """The settings are as hidden as the team itself."""
    sign_in(client, GUEST)
    assert client.get(URL).status_code == 404


def test_a_plain_member_cannot_change_them(client: TestClient, team: str) -> None:
    """Changing the workflow is a team admin decision."""
    sign_in(client, MEMBER)
    assert client.patch(URL, json={"close_parent": True}).status_code == 403


def test_an_admin_round_trips_each_switch(client: TestClient, team: str) -> None:
    """Each switch saves on its own and a patch leaves the other one alone."""
    sign_in(client, ADMIN)
    first = client.patch(URL, json={"close_parent": True})
    assert first.status_code == 200
    assert (first.json()["close_parent"], first.json()["close_sub_issues"]) == (True, False)
    assert first.json()["updated_at"] is not None

    second = client.patch(URL, json={"close_sub_issues": True})
    assert (second.json()["close_parent"], second.json()["close_sub_issues"]) == (True, True)

    client.patch(URL, json={"close_parent": False})
    read = client.get(URL).json()
    assert (read["close_parent"], read["close_sub_issues"]) == (False, True)
    assert client.patch(URL, json={}).json()["close_sub_issues"] is True


def test_a_non_boolean_is_refused(client: TestClient, team: str) -> None:
    """The switches take booleans only."""
    sign_in(client, ADMIN)
    assert client.patch(URL, json={"close_parent": "sometimes"}).status_code == 422


def test_deleting_the_team_removes_the_settings(client: TestClient, team: str, repositories: Any) -> None:
    """The team purge takes the settings row with the rest of the team's config."""
    sign_in(client, OWNER)
    client.patch(URL, json={"close_parent": True})
    assert repositories.team_config.get_parent_auto_close_settings(WORKSPACE, team) is not None

    assert client.delete(f"/api/workspaces/{WORKSPACE}/teams/{team}").status_code == 204

    assert repositories.team_config.get_parent_auto_close_settings(WORKSPACE, team) is None
    assert parent_auto_close_settings_key(team) == f"team#{team}#parentclose"
