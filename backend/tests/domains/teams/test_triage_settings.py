"""The team triage settings routes, against real tables in moto.

These pin that triage is off until a team admin turns it on, who may read and
change it, that triage duty takes only members who can see the team, that every
change lands in the audit log, and that deleting the team removes the row with
the rest of its config.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.audit import AuditQuery

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.team_config import triage_settings_key
from tests.domains.helpers import (
    ADMIN,
    GUEST,
    MEMBER,
    OWNER,
    add_member,
    add_team_member,
    make_team,
    make_workspace,
    sign_in,
)

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
    assert response.json() == {
        "team_id": team,
        "enabled": False,
        "responsible_user_ids": [],
        "responsibility_action": "notify",
        "require_priority": False,
        "updated_at": None,
    }


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
    detail = response.json()
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


def test_duty_and_the_priority_rule_are_saved_and_read_back(client: TestClient, team: str) -> None:
    """Responsible members are kept once each in the order given, with the action and the rule."""
    sign_in(client, ADMIN)

    response = client.patch(
        URL,
        json={
            "enabled": True,
            "responsible_user_ids": [MEMBER, " ", ADMIN, MEMBER],
            "responsibility_action": "assign",
            "require_priority": True,
        },
    )

    assert response.status_code == 200, response.text
    body = client.get(URL).json()
    assert body["responsible_user_ids"] == [MEMBER, ADMIN]
    assert body["responsibility_action"] == "assign"
    assert body["require_priority"] is True


def test_a_partial_patch_keeps_the_other_settings(client: TestClient, team: str) -> None:
    """Changing the action alone leaves the switch, the members and the rule as they were."""
    sign_in(client, ADMIN)
    client.patch(URL, json={"enabled": True, "responsible_user_ids": [MEMBER], "require_priority": True})

    response = client.patch(URL, json={"responsibility_action": "assign"})

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["enabled"], body["responsible_user_ids"], body["require_priority"]) == (True, [MEMBER], True)
    assert body["responsibility_action"] == "assign"


@pytest.mark.parametrize(
    "payload",
    [
        {"responsibility_action": "page"},
        {"require_priority": "yes"},
        {"responsible_user_ids": "someone"},
        {"responsible_user_ids": [f"01JB0000000000000000000{index:03d}" for index in range(26)]},
    ],
)
def test_bad_settings_are_refused(client: TestClient, team: str, payload: dict[str, Any]) -> None:
    """An unknown action, a non boolean rule, a non list and too many members are each a 422."""
    sign_in(client, ADMIN)
    assert client.patch(URL, json=payload).status_code == 422


@pytest.mark.parametrize("person", [GUEST, "01JB00000000000000000STRAY"])
def test_duty_takes_only_members_who_can_see_the_team(client: TestClient, team: str, person: str) -> None:
    """A guest or someone outside the workspace cannot be put on duty."""
    sign_in(client, ADMIN)

    response = client.patch(URL, json={"responsible_user_ids": [person]})

    assert response.status_code == 422
    assert "triage duty" in response.text


def test_a_guest_on_the_team_still_cannot_hold_duty(client: TestClient, team: str, repositories: Any) -> None:
    """A guest who sees the team through a team membership is still refused."""
    add_team_member(repositories, WORKSPACE, TEAM, GUEST, "member")
    sign_in(client, ADMIN)

    assert client.patch(URL, json={"responsible_user_ids": [GUEST]}).status_code == 422


def test_changes_land_in_the_audit_log(client: TestClient, team: str, repositories: Any) -> None:
    """Each change records the fields that moved, and restating the settings records nothing."""
    sign_in(client, ADMIN)
    client.patch(URL, json={"enabled": True})
    client.patch(URL, json={"responsible_user_ids": [MEMBER], "responsibility_action": "assign"})
    client.patch(URL, json={"responsible_user_ids": [MEMBER], "responsibility_action": "assign"})

    rows = repositories.audit.list_events(WORKSPACE, AuditQuery(action="team.triage_changed")).events

    assert len(rows) == 2
    changes = [(row.before, row.after) for row in rows]
    assert ({"enabled": False}, {"enabled": True}) in changes
    assert (
        {"responsible_user_ids": [], "responsibility_action": "notify"},
        {"responsible_user_ids": [MEMBER], "responsibility_action": "assign"},
    ) in changes
    assert all(row.target.id == TEAM and row.actor.id == ADMIN for row in rows)
