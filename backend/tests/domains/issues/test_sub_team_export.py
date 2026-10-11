"""The CSV export rolls a parent team's sub-teams in the way its issue list does.

The export button sends the list's own query, `include_sub_teams` included, so a
rolled-up list exports its sub-teams' issues as well, and a private sub-team the
caller is outside is left out of the file as it is left out of the list.
"""

from __future__ import annotations

import csv
import io
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common import team_writes
from tests.domains.helpers import MEMBER, OWNER, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, WORKSPACE, create_issue


def _titles(client: TestClient, **params: Any) -> set[str]:
    """The titles one export page holds; the fixture's few issues fit on the first page."""
    response = client.get(f"/api/workspaces/{WORKSPACE}/issues/export", params=params)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["next_cursor"] is None
    return {row["Title"] for row in csv.DictReader(io.StringIO(body["csv"]))}


@pytest.fixture
def nested(client: TestClient, workspace: str, repositories: Any) -> None:
    """`OTHER_TEAM` under `TEAM`, with one issue in each."""
    team_writes.set_parent(repositories, WORKSPACE, OTHER_TEAM, TEAM)
    sign_in(client, OWNER)
    create_issue(client, workspace, team_id=TEAM, title="Parent work")
    create_issue(client, workspace, team_id=OTHER_TEAM, title="Sub-team work")


def test_the_export_carries_the_sub_teams_only_when_rolled_up(client: TestClient, nested: None) -> None:
    """The parent alone exports its own issue, and the roll-up adds the sub-team's."""
    sign_in(client, MEMBER)
    assert _titles(client, team_id=TEAM) == {"Parent work"}
    assert _titles(client, team_id=TEAM, include_sub_teams="true") == {"Parent work", "Sub-team work"}


@pytest.mark.parametrize("reader", [OWNER, MEMBER])
def test_a_private_sub_team_stays_out_of_the_rolled_up_export(
    client: TestClient, nested: None, repositories: Any, reader: str
) -> None:
    """Outside a private sub-team, the rolled-up export holds the parent's issues alone."""
    repositories.memberships.set_team_private(WORKSPACE, OTHER_TEAM, True)
    sign_in(client, reader)
    assert _titles(client, team_id=TEAM, include_sub_teams="true") == {"Parent work"}
