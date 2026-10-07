"""Moving an issue to another team, through the issues route.

A move keeps the issue's id and gives it the target team's next key, so these
read the moved issue back by both keys, check what the target team could not hold
was dropped, and check that everything partitioned by the id came along.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import Cycle, Project, cycle_key, project_key
from app.common.db.dynamo.team_config import (
    WORKSPACE_SCOPE,
    Label,
    Override,
    Status,
    label_key,
    new_config_id,
    override_key,
    workspace_label_key,
    workspace_status_key,
)
from tests.domains.helpers import GUEST, OWNER, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, create_issue


def _move(client: TestClient, workspace: str, issue_id: str, team_id: str) -> Any:
    """One move through the route, answering the raw response."""
    return client.post(f"/api/workspaces/{workspace}/issues/{issue_id}/move", json={"team_id": team_id})


def _moved(client: TestClient, workspace: str, issue_id: str, team_id: str = OTHER_TEAM) -> "dict[str, Any]":
    """One move that must land, answering the moved issue."""
    response = _move(client, workspace, issue_id, team_id)
    assert response.status_code == 200, response.text
    return response.json()


def _history(repositories: Any, workspace: str, issue_id: str) -> "list[dict[str, Any]]":
    """The activity rows of one issue, newest first."""
    return [dict(item) for item in repositories.activity.list_for_issue(workspace, issue_id, limit=200).items]


def _workspace_label(repositories: Any, workspace: str, name: str) -> str:
    """Seed one workspace label every team inherits, answering its id."""
    label_id = new_config_id()
    repositories.team_config.create_label(
        Label(
            workspace_id=workspace,
            config_key=workspace_label_key(label_id),
            label_id=label_id,
            name=name,
            color="#00ff00",
            scope=WORKSPACE_SCOPE,
        )
    )
    return label_id


def _team_label(repositories: Any, workspace: str, team_id: str, name: str) -> str:
    """Seed one label only `team_id` holds, answering its id."""
    label_id = new_config_id()
    repositories.team_config.create_label(
        Label(
            workspace_id=workspace,
            config_key=label_key(team_id, label_id),
            team_id=team_id,
            label_id=label_id,
            name=name,
            color="#ff0000",
        )
    )
    return label_id


def _workspace_status(repositories: Any, workspace: str, category: str) -> str:
    """Seed one workspace status every team inherits, answering its id."""
    status_id = new_config_id()
    repositories.team_config.create_status(
        Status(
            workspace_id=workspace,
            config_key=workspace_status_key(status_id),
            status_id=status_id,
            name="Review",
            category=category,
            position=50,
            scope=WORKSPACE_SCOPE,
        )
    )
    return status_id


def _hide(repositories: Any, workspace: str, team_id: str, target: str, target_id: str) -> None:
    """Hide one inherited status or label from one team."""
    repositories.team_config.put_override(
        Override(
            workspace_id=workspace,
            config_key=override_key(team_id, target, target_id),
            team_id=team_id,
            target=target,
            target_id=target_id,
            hidden=True,
        )
    )


def test_a_moved_issue_takes_the_target_teams_next_key(client: TestClient, workspace: str, statuses: Any) -> None:
    """The issue keeps its id and becomes `XYZ-2` when the target already holds `XYZ-1`."""
    sign_in(client, OWNER)
    create_issue(client, workspace, team_id=OTHER_TEAM, title="Already there")
    issue = create_issue(client, workspace, title="Moving")

    moved = _moved(client, workspace, issue["id"])

    assert moved["id"] == issue["id"]
    assert moved["team_id"] == OTHER_TEAM
    assert moved["key"] == "XYZ-2"
    assert moved["number"] == 2


def test_the_old_key_keeps_resolving_after_a_move(client: TestClient, workspace: str, statuses: Any) -> None:
    """`ABC-1` and `XYZ-1` answer the same issue, and the source team's next issue is still `ABC-2`."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)
    _moved(client, workspace, issue["id"])

    for key in ("ABC-1", "abc-1", "XYZ-1"):
        response = client.get(f"/api/workspaces/{workspace}/issues/by-key/{key}")
        assert response.status_code == 200, key
        assert response.json()["id"] == issue["id"]
        assert response.json()["key"] == "XYZ-1"
    assert create_issue(client, workspace)["key"] == "ABC-2"


def test_a_key_chain_resolves_through_two_moves(client: TestClient, workspace: str, statuses: Any) -> None:
    """Moving back takes a fresh number, and every key the issue held still answers it."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)
    _moved(client, workspace, issue["id"])
    back = _moved(client, workspace, issue["id"], TEAM)

    assert back["key"] == "ABC-2"
    for key in ("ABC-1", "XYZ-1", "ABC-2"):
        assert client.get(f"/api/workspaces/{workspace}/issues/by-key/{key}").json()["id"] == issue["id"]


def test_a_status_the_target_shows_is_kept(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A workspace status both teams inherit is the same status on the target."""
    review = _workspace_status(repositories, workspace, "started")
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, status_id=review)

    assert _moved(client, workspace, issue["id"])["status_id"] == review


def test_a_status_the_target_lacks_maps_to_its_first_of_the_same_category(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A team status, or an inherited one the target hides, lands on the target's first started status."""
    review = _workspace_status(repositories, workspace, "started")
    _hide(repositories, workspace, OTHER_TEAM, "status", review)
    target_started = next(
        row
        for row in repositories.team_config.list_statuses(workspace, OTHER_TEAM, include_hidden=False)
        if row.category == "started"
    )
    sign_in(client, OWNER)
    own = create_issue(client, workspace, status_id=statuses["started"].status_id)
    inherited = create_issue(client, workspace, status_id=review)

    assert _moved(client, workspace, own["id"])["status_id"] == target_started.status_id
    assert _moved(client, workspace, inherited["id"])["status_id"] == target_started.status_id


def test_labels_the_target_can_see_are_kept_and_the_rest_dropped(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A workspace label stays, a source team label and a label the target hides go."""
    shared = _workspace_label(repositories, workspace, "Shared")
    hidden = _workspace_label(repositories, workspace, "Hidden there")
    _hide(repositories, workspace, OTHER_TEAM, "label", hidden)
    own = _team_label(repositories, workspace, TEAM, "Ours")
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, label_ids=[shared, hidden, own])

    assert _moved(client, workspace, issue["id"])["label_ids"] == [shared]


def test_a_move_clears_the_cycle_and_keeps_a_project_the_target_is_on(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Cycles are per team so the cycle goes, and a project shared with the target stays."""
    today = utc_now().date()
    cycle = repositories.planning.create_cycle(
        Cycle(
            workspace_id=workspace,
            planning_key=cycle_key(TEAM, "C1"),
            cycle_id="C1",
            team_id=TEAM,
            name="Cycle 1",
            start_date=today.isoformat(),
            end_date=(today + timedelta(days=13)).isoformat(),
            created_by=OWNER,
        )
    )
    shared = repositories.planning.create_project(
        Project(
            workspace_id=workspace,
            planning_key=project_key("P1"),
            project_id="P1",
            team_ids=[TEAM, OTHER_TEAM],
            name="Shared",
            created_by=OWNER,
        )
    )
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, cycle_id=cycle.cycle_id, project_id=shared.project_id)

    moved = _moved(client, workspace, issue["id"])

    assert moved["cycle_id"] is None
    assert moved["project_id"] == shared.project_id


def test_a_project_the_target_is_not_on_is_cleared(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The issue would otherwise sit in a project its team cannot plan in."""
    project = repositories.planning.create_project(
        Project(
            workspace_id=workspace,
            planning_key=project_key("P2"),
            project_id="P2",
            team_ids=[TEAM],
            name="Ours",
            created_by=OWNER,
        )
    )
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, project_id=project.project_id)

    assert _moved(client, workspace, issue["id"])["project_id"] is None


def test_a_move_records_itself_and_each_dropped_value_in_the_history(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """One row names the old and new keys, and the status change gets its own row."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, status_id=statuses["started"].status_id)
    _moved(client, workspace, issue["id"])

    history = _history(repositories, workspace, issue["id"])
    moves = [row for row in history if row.get("field") == "team_id"]
    fields = {row.get("field") for row in history if row["kind"] == "field_changed"}

    assert len(moves) == 1
    assert moves[0]["from_value"] == {"id": TEAM, "key": "ABC-1"}
    assert moves[0]["to_value"] == {"id": OTHER_TEAM, "key": "XYZ-1"}
    assert "status_id" in fields


def test_links_comments_and_subscribers_carry_over(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Everything partitioned by the issue id is untouched by the move."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)
    other = create_issue(client, workspace, title="Blocked")
    created = client.post(
        f"/api/workspaces/{workspace}/issues/{issue['id']}/links",
        json={"type": "blocks", "target_issue_id": other["id"]},
    )
    assert created.status_code == 201, created.text
    before = {row.user_id for row in repositories.subscriptions.list_for_issue(workspace, issue["id"])}

    _moved(client, workspace, issue["id"])

    links = client.get(f"/api/workspaces/{workspace}/issues/{issue['id']}/links").json()["links"]
    after = {row.user_id for row in repositories.subscriptions.list_for_issue(workspace, issue["id"])}
    assert [row["type"] for row in links] == ["blocks"]
    assert before <= after


def test_a_parent_takes_its_sub_issues_with_it(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Sub-issues share their parent's team, so each one moves too and gets its own new key."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent")
    child = create_issue(client, workspace, title="Child", parent_id=parent["id"])

    _moved(client, workspace, parent["id"])

    moved_child = client.get(f"/api/workspaces/{workspace}/issues/{child['id']}").json()
    assert moved_child["team_id"] == OTHER_TEAM
    assert moved_child["parent_id"] == parent["id"]
    assert moved_child["key"] == "XYZ-2"
    assert client.get(f"/api/workspaces/{workspace}/issues/by-key/ABC-2").json()["id"] == child["id"]


def test_a_sub_issue_moved_alone_leaves_its_parent(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The child becomes top level, and the parent's history records it leaving."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent")
    child = create_issue(client, workspace, title="Child", parent_id=parent["id"])

    moved = _moved(client, workspace, child["id"])

    assert moved["parent_id"] is None
    kinds = [row["kind"] for row in _history(repositories, workspace, parent["id"])]
    assert "child_removed" in kinds
    assert client.get(f"/api/workspaces/{workspace}/issues/{parent['id']}").json()["team_id"] == TEAM


def test_a_move_drops_the_issue_from_the_old_teams_delta(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A tombstone under the source team removes the issue from that team's synced list."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)
    cursor = utc_now() - timedelta(seconds=1)

    _moved(client, workspace, issue["id"])

    old = client.get(
        f"/api/workspaces/{workspace}/issues", params={"team_id": TEAM, "updated_since": cursor.isoformat()}
    ).json()
    new = client.get(
        f"/api/workspaces/{workspace}/issues", params={"team_id": OTHER_TEAM, "updated_since": cursor.isoformat()}
    ).json()
    assert issue["id"] in old["removed_ids"]
    assert issue["id"] in {row["id"] for row in new["issues"]}


def test_moving_to_the_same_team_changes_nothing(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The key, the counter and the history are all left alone."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)
    before = len(_history(repositories, workspace, issue["id"]))

    moved = _moved(client, workspace, issue["id"], TEAM)

    assert moved["key"] == "ABC-1"
    assert len(_history(repositories, workspace, issue["id"])) == before
    assert create_issue(client, workspace)["key"] == "ABC-2"


def test_a_guest_cannot_move_into_a_team_they_are_not_on(client: TestClient, workspace: str, statuses: Any) -> None:
    """The guest writes in `TEAM` alone, so the target refuses them and nothing moves."""
    sign_in(client, GUEST)
    issue = create_issue(client, workspace)

    response = _move(client, workspace, issue["id"], OTHER_TEAM)

    assert response.status_code in (403, 404)
    assert client.get(f"/api/workspaces/{workspace}/issues/{issue['id']}").json()["key"] == "ABC-1"


def test_an_unknown_target_team_is_refused(client: TestClient, workspace: str, statuses: Any) -> None:
    """A team id that names nothing moves nothing."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)

    assert _move(client, workspace, issue["id"], "01JB00000000000000000NOPE").status_code in (403, 404)


def test_an_old_key_from_a_team_the_caller_cannot_see_still_answers_by_the_new_team(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Visibility is held against the issue's current team, not the team the old key names."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace, team_id=OTHER_TEAM)
    _moved(client, workspace, issue["id"], TEAM)

    sign_in(client, GUEST)
    response = client.get(f"/api/workspaces/{workspace}/issues/by-key/XYZ-1")

    assert response.status_code == 200
    assert response.json()["key"] == "ABC-1"


def test_an_old_key_of_an_issue_moved_out_of_sight_is_a_404(client: TestClient, workspace: str, statuses: Any) -> None:
    """The guest knew `ABC-1`, but it now lives in a team they cannot see."""
    sign_in(client, OWNER)
    issue = create_issue(client, workspace)
    _moved(client, workspace, issue["id"])

    sign_in(client, GUEST)
    assert client.get(f"/api/workspaces/{workspace}/issues/by-key/ABC-1").status_code == 404
