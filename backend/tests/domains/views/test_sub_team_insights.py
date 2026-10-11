"""Insights roll a parent team's sub-teams in the way its issue list does.

A parent's list with `include_sub_teams` shows its sub-teams' issues, so the
insights panel beside it counts them too, and a private sub-team the caller is
outside stays out of the count as it stays out of the list.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common import team_writes
from tests.domains.helpers import MEMBER, OWNER, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM, WORKSPACE, seed_issue


def _total(client: TestClient, **params: Any) -> int:
    """The issue count one breakdown answers."""
    response = client.get(f"/api/workspaces/{WORKSPACE}/views/insights", params=params)
    assert response.status_code == 200, response.text
    return response.json()["issue_count"]


@pytest.fixture
def nested(issues_client: TestClient, workspace: str, repositories: Any) -> None:
    """`OTHER_TEAM` under `TEAM`, with one issue in each."""
    team_writes.set_parent(repositories, WORKSPACE, OTHER_TEAM, TEAM)
    sign_in(issues_client, OWNER)
    seed_issue(issues_client, workspace, title="Parent work")
    seed_issue(issues_client, workspace, team_id=OTHER_TEAM, title="Sub-team work")


def test_insights_count_the_sub_teams_only_when_rolled_up(client: TestClient, nested: None) -> None:
    """The parent alone counts its own issue, and the roll-up adds the sub-team's."""
    sign_in(client, MEMBER)
    assert _total(client, team_id=TEAM) == 1
    assert _total(client, team_id=TEAM, include_sub_teams="true") == 2


@pytest.mark.parametrize("reader", [OWNER, MEMBER])
def test_a_private_sub_team_stays_out_of_the_rolled_up_count(
    client: TestClient, nested: None, repositories: Any, reader: str
) -> None:
    """Outside a private sub-team, the roll-up counts the parent's issues alone."""
    repositories.memberships.set_team_private(WORKSPACE, OTHER_TEAM, True)
    sign_in(client, reader)
    assert _total(client, team_id=TEAM, include_sub_teams="true") == 1
