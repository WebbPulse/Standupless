"""The team triage switch routes, against real tables in moto.

These pin that triage is off until a team admin turns it on, who may read and
change it, and that deleting the team removes the row with the rest of its config.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.team_config import triage_settings_key
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_member, make_team, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

URL = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/triage-settings"


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
    """A Standard workspace with every role, holding one team."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    repositories.workspaces.set_billing(WORKSPACE, plan="standard")
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    make_team(repositories, WORKSPACE, TEAM, "APO")
    return TEAM


def test_unsaved_settings_read_as_off(client: TestClient, team: str) -> None:
    """A team never set up has no triage inbox."""
    sign_in(client, MEMBER)
    response = client.get(URL)

    assert response.status_code == 200
    assert response.json() == {"team_id": team, "enabled": False, "updated_at": None}


def test_an_admin_turns_it_on_and_it_reads_back(client: TestClient, team: str, repositories: Any) -> None:
    """The switch is saved, read back, and listed for the summary."""
    sign_in(client, ADMIN)

    response = client.patch(URL, json={"enabled": True})

    assert response.status_code == 200, response.text
    assert response.json()["enabled"] is True
    assert client.get(URL).json()["enabled"] is True
    assert repositories.team_config.triage_team_ids(WORKSPACE) == [TEAM]


def test_a_member_cannot_change_it(client: TestClient, team: str) -> None:
    """Changing the switch is a team admin's call."""
    sign_in(client, MEMBER)
    assert client.patch(URL, json={"enabled": True}).status_code == 403


def test_a_guest_outside_the_team_cannot_read_it(client: TestClient, team: str) -> None:
    """The setting is as hidden as the team itself."""
    sign_in(client, GUEST)
    assert client.get(URL).status_code == 404


def test_the_switch_takes_only_a_boolean(client: TestClient, team: str) -> None:
    """A string is refused rather than read as truthy."""
    sign_in(client, ADMIN)
    assert client.patch(URL, json={"enabled": "yes"}).status_code == 422


def test_deleting_the_team_removes_the_row(client: TestClient, team: str, repositories: Any) -> None:
    """The triage row goes with the rest of the team's config."""
    sign_in(client, ADMIN)
    client.patch(URL, json={"enabled": True})

    repositories.team_config.delete_for_team(WORKSPACE, TEAM)

    assert repositories.team_config.get_triage_settings(WORKSPACE, TEAM) is None
    assert triage_settings_key(TEAM).startswith("triage#")


def test_turning_it_on_needs_a_plan_with_triage(client: TestClient, team: str, repositories: Any) -> None:
    """A Free workspace is refused with the plan error and nothing is saved."""
    repositories.workspaces.set_billing(WORKSPACE, plan="free")
    sign_in(client, ADMIN)

    response = client.patch(URL, json={"enabled": True})

    assert response.status_code == 403
    detail = response.json()["detail"]
    assert detail["error_code"] == "PLAN_FEATURE_UNAVAILABLE"
    assert detail["details"] == {"feature": "triage", "plan": "free", "required_plan": "standard"}
    assert repositories.team_config.get_triage_settings(WORKSPACE, TEAM) is None


def test_turning_it_off_after_a_downgrade_is_allowed(client: TestClient, team: str, repositories: Any) -> None:
    """A team that lost the plan can still switch its inbox off."""
    sign_in(client, ADMIN)
    assert client.patch(URL, json={"enabled": True}).status_code == 200
    repositories.workspaces.set_billing(WORKSPACE, plan="free")

    response = client.patch(URL, json={"enabled": False})

    assert response.status_code == 200, response.text
    assert response.json()["enabled"] is False
