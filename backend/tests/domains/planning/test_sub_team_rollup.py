"""Cycles and projects roll a parent team's sub-teams up, keeping private sub-teams private.

`include_sub_teams` on the cycle and project lists reads the named team and the
sub-teams the caller may see, the same scope the issue list uses. An owner, an
admin or a member outside a private sub-team gets none of its cycles or projects,
while a member of it reads them rolled up with the parent's.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common import team_writes
from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_member, add_team_member, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, TEAM, WORKSPACE, seed_cycle, seed_project

INSIDER = "01JB00000000000000000INSDR"

SECRET = "Vault rotation"


def _names(client: TestClient, path: str, key: str, **params: Any) -> list[str]:
    """The names one read of a planning list answers, in its order."""
    response = client.get(f"/api/workspaces/{WORKSPACE}/{path}", params=params)
    assert response.status_code == 200, response.text
    return [row["name"] for row in response.json()[key]]


@pytest.fixture
def seeded(client: TestClient, workspace: str, repositories: Any) -> None:
    """`OTHER_TEAM` under `TEAM` with a cycle and a project on each, then made private with one insider."""
    team_writes.set_parent(repositories, WORKSPACE, OTHER_TEAM, TEAM)
    sign_in(client, OWNER)
    seed_cycle(client, workspace, name="Parent cycle", start_date="2026-02-01", end_date="2026-02-14")
    seed_cycle(client, workspace, team_id=OTHER_TEAM, name=SECRET, start_date="2026-01-01", end_date="2026-01-14")
    seed_project(client, workspace, team_id=None, team_ids=[TEAM], name="Parent project")
    seed_project(client, workspace, team_id=None, team_ids=[OTHER_TEAM], name=SECRET)
    add_member(repositories, WORKSPACE, INSIDER, "member")
    add_team_member(repositories, WORKSPACE, OTHER_TEAM, INSIDER, "member")


def test_cycles_roll_up_a_public_sub_team_by_start_date(client: TestClient, seeded: None) -> None:
    """A public sub-team's cycles join the parent's, merged in start date order."""
    sign_in(client, MEMBER)

    assert _names(client, "cycles", "cycles", team_id=TEAM) == ["Parent cycle"]
    assert _names(client, "cycles", "cycles", team_id=TEAM, include_sub_teams="true") == [SECRET, "Parent cycle"]


def test_projects_roll_up_a_public_sub_team(client: TestClient, seeded: None) -> None:
    """A public sub-team's projects join the parent's only when the roll-up is asked for."""
    sign_in(client, MEMBER)

    assert _names(client, "projects", "projects", team_id=TEAM) == ["Parent project"]
    rolled = _names(client, "projects", "projects", team_id=TEAM, include_sub_teams="true")
    assert sorted(rolled) == ["Parent project", SECRET]


def test_the_cycle_roll_up_pages_over_the_merged_order(client: TestClient, workspace: str, seeded: None) -> None:
    """A page boundary inside the merged list resumes where it left off."""
    sign_in(client, OWNER)
    seed_cycle(client, workspace, name="Late", start_date="2026-03-01", end_date="2026-03-14")
    path = f"/api/workspaces/{WORKSPACE}/cycles"
    params = {"team_id": TEAM, "include_sub_teams": "true", "limit": 2}

    first = client.get(path, params=params).json()
    second = client.get(path, params={**params, "cursor": first["next_cursor"]}).json()

    assert [row["name"] for row in first["cycles"]] == [SECRET, "Parent cycle"]
    assert [row["name"] for row in second["cycles"]] == ["Late"]
    assert second["next_cursor"] is None


@pytest.mark.parametrize("reader", [OWNER, ADMIN, MEMBER])
def test_a_private_sub_team_stays_out_of_the_roll_up(
    client: TestClient, repositories: Any, seeded: None, reader: str
) -> None:
    """Whatever the reader's workspace role, a private sub-team they are outside adds nothing."""
    repositories.memberships.set_team_private(WORKSPACE, OTHER_TEAM, True)
    sign_in(client, reader)

    assert _names(client, "cycles", "cycles", team_id=TEAM, include_sub_teams="true") == ["Parent cycle"]
    assert _names(client, "projects", "projects", team_id=TEAM, include_sub_teams="true") == ["Parent project"]
    cycles = client.get(f"/api/workspaces/{WORKSPACE}/cycles", params={"team_id": TEAM, "include_sub_teams": "true"})
    assert OTHER_TEAM not in cycles.text
    assert SECRET not in cycles.text


def test_naming_the_private_sub_team_is_a_404(client: TestClient, repositories: Any, seeded: None) -> None:
    """Rolled up or not, an outsider naming the private sub-team gets the answer for a missing team."""
    repositories.memberships.set_team_private(WORKSPACE, OTHER_TEAM, True)
    sign_in(client, MEMBER)

    for path in ("cycles", "projects"):
        for rolled in ("false", "true"):
            response = client.get(
                f"/api/workspaces/{WORKSPACE}/{path}", params={"team_id": OTHER_TEAM, "include_sub_teams": rolled}
            )
            assert response.status_code == 404


def test_a_member_of_the_private_sub_team_reads_it_rolled_up(
    client: TestClient, repositories: Any, seeded: None
) -> None:
    """The insider sees the parent's cycles and projects with the sub-team's."""
    repositories.memberships.set_team_private(WORKSPACE, OTHER_TEAM, True)
    sign_in(client, INSIDER)

    assert _names(client, "cycles", "cycles", team_id=TEAM, include_sub_teams="true") == [SECRET, "Parent cycle"]
    rolled = _names(client, "projects", "projects", team_id=TEAM, include_sub_teams="true")
    assert sorted(rolled) == ["Parent project", SECRET]
