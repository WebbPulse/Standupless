"""A parent team's issue list rolled up over its sub-teams, and issues of a team leaving its parent.

`include_sub_teams` widens a list named by `team_id` to the sub-teams the caller
may see, on full and delta reads alike, and a team made top-level again carries
its issues off the parent's statuses.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi.testclient import TestClient

from app.common import team_writes
from app.common.db.dynamo.base import utc_now
from tests.domains.helpers import GUEST, OWNER, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, WORKSPACE, create_issue

BASE = f"/api/workspaces/{WORKSPACE}/issues"


def _ids(client: TestClient, **params: Any) -> set[str]:
    """The issue ids one read of the list answers."""
    response = client.get(BASE, params=params)
    assert response.status_code == 200, response.text
    return {row["id"] for row in response.json()["issues"]}


def _nest(repositories: Any) -> None:
    """Put `OTHER_TEAM` under `TEAM`."""
    team_writes.set_parent(repositories, WORKSPACE, OTHER_TEAM, TEAM)


def test_a_parent_list_rolls_up_its_sub_teams_on_request(client: TestClient, workspace: str, repositories: Any) -> None:
    """The team filter alone stays on the team; `include_sub_teams` adds the sub-team's issues."""
    _nest(repositories)
    sign_in(client, OWNER)
    own = create_issue(client, workspace, team_id=TEAM)["id"]
    sub = create_issue(client, workspace, team_id=OTHER_TEAM)["id"]

    assert _ids(client, team_id=TEAM) == {own}
    assert _ids(client, team_id=TEAM, include_sub_teams="true") == {own, sub}
    assert _ids(client, team_id=OTHER_TEAM, include_sub_teams="true") == {sub}


def test_the_roll_up_leaves_out_sub_teams_the_caller_cannot_see(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A guest of the parent alone reads none of the sub-team's issues through the roll-up."""
    _nest(repositories)
    sign_in(client, OWNER)
    own = create_issue(client, workspace, team_id=TEAM)["id"]
    create_issue(client, workspace, team_id=OTHER_TEAM)
    sign_in(client, GUEST)
    assert _ids(client, team_id=TEAM, include_sub_teams="true") == {own}


def test_a_delta_read_rolls_up_too(client: TestClient, workspace: str, repositories: Any) -> None:
    """A poll with `include_sub_teams` carries a sub-team issue changed since the cursor."""
    _nest(repositories)
    sign_in(client, OWNER)
    since = utc_now() - timedelta(seconds=1)
    sub = create_issue(client, workspace, team_id=OTHER_TEAM)["id"]

    assert sub in _ids(client, team_id=TEAM, include_sub_teams="true", updated_since=since.isoformat())
    assert sub not in _ids(client, team_id=TEAM, updated_since=since.isoformat())


def test_a_sub_team_issue_takes_a_parent_status(client: TestClient, workspace: str, repositories: Any) -> None:
    """The parent's statuses are the sub-team's to use, and leaving moves its issues to its own."""
    _nest(repositories)
    parent_started = next(
        row for row in repositories.team_config.list_statuses(WORKSPACE, TEAM) if row.category == "started"
    )
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, team_id=OTHER_TEAM, status_id=parent_started.status_id)
    assert issue["status_id"] == parent_started.status_id

    team_writes.set_parent(repositories, WORKSPACE, OTHER_TEAM, None, actor_id=OWNER)

    moved = client.get(f"{BASE}/{issue['id']}").json()
    own = {row.status_id: row for row in repositories.team_config.list_statuses(WORKSPACE, OTHER_TEAM)}
    assert moved["status_id"] in own
    assert own[moved["status_id"]].category == "started"
