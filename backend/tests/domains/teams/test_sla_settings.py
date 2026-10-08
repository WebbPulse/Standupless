"""The team SLA settings routes, against real tables in moto.

These pin who may read and change a team's SLA rules, that each priority's
hours are bounded and may be cleared on their own, and that deleting the team
removes the row with the rest of its config.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.team_config import MAX_SLA_HOURS, sla_settings_key
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_member, make_team, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

URL = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/sla-settings"


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
    """A Business workspace with every role, holding one team."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    repositories.workspaces.set_billing(WORKSPACE, plan="business")
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    make_team(repositories, WORKSPACE, TEAM, "APO")
    return TEAM


def test_unsaved_settings_read_as_off_with_the_defaults(client: TestClient, team: str) -> None:
    """SLAs are off until a team turns them on, ready with urgent in a day and high in three."""
    sign_in(client, MEMBER)
    response = client.get(URL)

    assert response.status_code == 200
    assert response.json() == {
        "team_id": team,
        "enabled": False,
        "urgent_hours": 24,
        "high_hours": 72,
        "medium_hours": None,
        "low_hours": None,
        "updated_at": None,
    }


def test_a_guest_outside_the_team_cannot_read_them(client: TestClient, team: str) -> None:
    """The rules are as hidden as the team itself."""
    sign_in(client, GUEST)
    assert client.get(URL).status_code == 404


def test_a_plain_member_cannot_change_them(client: TestClient, team: str) -> None:
    """Changing the rules is a team admin decision."""
    sign_in(client, MEMBER)
    assert client.patch(URL, json={"enabled": True}).status_code == 403


@pytest.mark.parametrize("hours", [0, -1, MAX_SLA_HOURS + 1, "a day"])
def test_hours_outside_the_bounds_are_refused(client: TestClient, team: str, hours: Any) -> None:
    """An SLA runs from one hour to ninety days."""
    sign_in(client, ADMIN)
    assert client.patch(URL, json={"medium_hours": hours}).status_code == 422


def test_enabled_must_be_a_boolean(client: TestClient, team: str) -> None:
    """A string is not read as a switch."""
    sign_in(client, ADMIN)
    assert client.patch(URL, json={"enabled": "yes"}).status_code == 422


def test_an_admin_turns_them_on_and_sets_each_priority(client: TestClient, team: str) -> None:
    """Each field saves on its own and reads back, the others kept."""
    sign_in(client, ADMIN)
    assert client.patch(URL, json={"enabled": True}).status_code == 200
    assert client.patch(URL, json={"medium_hours": 168}).status_code == 200
    response = client.patch(URL, json={"urgent_hours": 4})

    assert response.status_code == 200
    body = response.json()
    assert body["enabled"] is True
    assert (body["urgent_hours"], body["high_hours"], body["medium_hours"], body["low_hours"]) == (4, 72, 168, None)
    assert body["updated_at"] is not None
    assert client.get(URL).json() == body


def test_null_removes_one_priority_rule(client: TestClient, team: str) -> None:
    """Sending null clears that priority's hours and leaves the rest alone."""
    sign_in(client, ADMIN)
    response = client.patch(URL, json={"high_hours": None})

    assert response.status_code == 200
    assert response.json()["high_hours"] is None
    assert response.json()["urgent_hours"] == 24


def test_an_empty_patch_keeps_the_rules(client: TestClient, team: str) -> None:
    """A patch naming nothing leaves the saved rules alone."""
    sign_in(client, ADMIN)
    client.patch(URL, json={"enabled": True, "low_hours": 720})

    body = client.patch(URL, json={}).json()
    assert body["enabled"] is True
    assert body["low_hours"] == 720


def test_deleting_the_team_removes_the_settings(client: TestClient, team: str, repositories: Any) -> None:
    """The team purge takes the settings row with the rest of the team's config."""
    sign_in(client, OWNER)
    client.patch(URL, json={"enabled": True})
    assert repositories.team_config.get_sla_settings(WORKSPACE, team) is not None

    assert client.delete(f"/api/workspaces/{WORKSPACE}/teams/{team}").status_code == 204

    assert repositories.team_config.get_sla_settings(WORKSPACE, team) is None
    assert sla_settings_key(team) == f"team#{team}#sla"


@pytest.mark.parametrize("patch", [{"enabled": True}, {"medium_hours": 48}])
def test_turning_them_on_or_setting_a_rule_needs_business(
    client: TestClient, team: str, repositories: Any, patch: dict[str, Any]
) -> None:
    """Below Business the patch is refused with the plan error and nothing is saved."""
    repositories.workspaces.set_billing(WORKSPACE, plan="standard")
    sign_in(client, ADMIN)

    response = client.patch(URL, json=patch)

    assert response.status_code == 403
    detail = response.json()["detail"]
    assert detail["error_code"] == "PLAN_FEATURE_UNAVAILABLE"
    assert detail["details"] == {"feature": "issue_slas", "plan": "standard", "required_plan": "business"}
    assert repositories.team_config.get_sla_settings(WORKSPACE, team) is None


def test_turning_them_off_or_clearing_a_rule_after_a_downgrade_is_allowed(
    client: TestClient, team: str, repositories: Any
) -> None:
    """A team that lost the plan can still switch SLAs off and remove rules."""
    sign_in(client, ADMIN)
    assert client.patch(URL, json={"enabled": True}).status_code == 200
    repositories.workspaces.set_billing(WORKSPACE, plan="free")

    response = client.patch(URL, json={"enabled": False, "urgent_hours": None})

    assert response.status_code == 200, response.text
    assert (response.json()["enabled"], response.json()["urgent_hours"]) == (False, None)
