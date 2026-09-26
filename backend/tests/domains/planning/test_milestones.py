"""Project milestones: ordered stages of one project, and the issues filed under them.

The properties worth holding are that milestones are reached only through a
project the caller can read, that they list in their manual order, that an issue's
milestone must belong to the issue's own project and falls away when the project
changes, that the change is recorded in the issue's activity, that the planning
rollup counts an issue into its milestone, and that deleting a milestone (or its
project) leaves its issues in place with no milestone.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.planning import milestone_key
from app.domains.issues.consumers.rollup import detach_milestone, removed_milestone
from app.domains.issues.consumers.rollup import handle_record as issues_handle_record
from app.domains.planning.consumers.rollup import handle_record as planning_handle_record
from app.domains.planning.endpoints.milestones import sort_order_after
from tests.domains.helpers import GUEST, MEMBER, OUTSIDER, OWNER, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, TEAM, WORKSPACE, seed_issue, seed_project


def _path(workspace: str, project_id: str, milestone_id: str = "") -> str:
    """A project's milestone collection, or one milestone when an id is given."""
    base = f"/api/workspaces/{workspace}/projects/{project_id}/milestones"
    return f"{base}/{milestone_id}" if milestone_id else base


def _seed_milestone(client: TestClient, workspace: str, project_id: str, **payload: Any) -> "dict[str, Any]":
    """Create one milestone through the route, failing loudly on a refusal."""
    body: "dict[str, Any]" = {"name": "Alpha"}
    body.update(payload)
    response = client.post(_path(workspace, project_id), json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _removal(project_id: str, milestone_id: str, workspace_id: str = WORKSPACE) -> "dict[str, Any]":
    """A planning stream `REMOVE` record for one milestone row, keys only."""
    return {
        "eventName": "REMOVE",
        "eventID": "1",
        "dynamodb": {
            "Keys": {
                "workspace_id": {"S": workspace_id},
                "planning_key": {"S": milestone_key(project_id, milestone_id)},
            }
        },
    }


@pytest.mark.parametrize(
    ("last", "expected"),
    [(None, "V"), ("", "V"), ("V", "W"), ("a", "b"), ("Vz", "VzV"), ("z", "zV")],
)
def test_sort_order_after_lands_past_the_last_key(last: "str | None", expected: str) -> None:
    """Bumping the last character keeps keys short; a maxed one grows a character."""
    assert sort_order_after(last) == expected
    if last:
        assert expected > last


def test_a_milestone_is_created_with_its_fields_and_empty_counts(client: TestClient, workspace: str) -> None:
    """Name, description and target date are stored; progress starts at zero."""
    sign_in(client, MEMBER)
    project = seed_project(client, workspace)

    body = _seed_milestone(
        client, workspace, project["project_id"], name="Beta", description="Invite only", target_date="2026-10-01"
    )

    assert body["name"] == "Beta"
    assert body["description"] == "Invite only"
    assert body["target_date"] == "2026-10-01"
    assert body["project_id"] == project["project_id"]
    assert body["sort_order"] == "V"
    assert body["counts"] == {"todo": 0, "in_progress": 0, "done": 0, "cancelled": 0, "total": 0}


def test_milestones_list_in_manual_order_and_reorder_by_patch(client: TestClient, workspace: str) -> None:
    """New milestones append; a patched `sort_order` moves one without touching the rest."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    first = _seed_milestone(client, workspace, project_id, name="One")
    second = _seed_milestone(client, workspace, project_id, name="Two")
    third = _seed_milestone(client, workspace, project_id, name="Three")

    listed = client.get(_path(workspace, project_id)).json()
    assert [row["name"] for row in listed["milestones"]] == ["One", "Two", "Three"]
    assert listed["next_cursor"] is None

    moved = client.patch(_path(workspace, project_id, third["milestone_id"]), json={"sort_order": "0"})
    assert moved.status_code == 200

    names = [row["name"] for row in client.get(_path(workspace, project_id)).json()["milestones"]]
    assert names == ["Three", "One", "Two"]
    assert first["sort_order"] < second["sort_order"]


def test_a_patch_edits_and_clears_optional_fields_but_not_required_ones(client: TestClient, workspace: str) -> None:
    """The target date and description clear with null; the name and order cannot."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    milestone = _seed_milestone(client, workspace, project_id, target_date="2026-10-01", description="Soon")
    path = _path(workspace, project_id, milestone["milestone_id"])

    renamed = client.patch(path, json={"name": "Renamed", "target_date": None, "description": None})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Renamed"
    assert renamed.json()["target_date"] is None
    assert renamed.json()["description"] is None

    assert client.patch(path, json={"name": None}).status_code == 422
    assert client.patch(path, json={"sort_order": None}).status_code == 422
    assert client.patch(path, json={"sort_order": "not-base62!"}).status_code == 422
    assert client.patch(path, json={"name": "  "}).status_code == 422


def test_an_unknown_milestone_or_project_is_a_404(client: TestClient, workspace: str) -> None:
    """Patch and delete read the row first; a missing project hides everything under it."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    nope = "01JB0000000000000000NOPE01"

    assert client.patch(_path(workspace, project_id, nope), json={"name": "X"}).status_code == 404
    assert client.delete(_path(workspace, project_id, nope)).status_code == 404
    assert client.get(_path(workspace, nope)).status_code == 404
    assert client.post(_path(workspace, nope), json={"name": "X"}).status_code == 404


def test_a_guest_outside_the_projects_teams_gets_a_404(client: TestClient, workspace: str) -> None:
    """Milestones follow the project's visibility, so a hidden project hides them too."""
    sign_in(client, OWNER)
    hidden = seed_project(client, workspace, team_id=OTHER_TEAM)
    milestone = _seed_milestone(client, workspace, hidden["project_id"])

    sign_in(client, GUEST)
    assert client.get(_path(workspace, hidden["project_id"])).status_code == 404
    assert client.post(_path(workspace, hidden["project_id"]), json={"name": "X"}).status_code == 404
    assert (
        client.patch(_path(workspace, hidden["project_id"], milestone["milestone_id"]), json={"name": "X"}).status_code
        == 404
    )
    assert client.delete(_path(workspace, hidden["project_id"], milestone["milestone_id"])).status_code == 404

    sign_in(client, OUTSIDER)
    assert client.get(_path(workspace, hidden["project_id"])).status_code == 404


def test_a_team_member_edits_the_milestones_of_a_project_it_can_see(client: TestClient, workspace: str) -> None:
    """A guest on one of the project's teams has the same edit right it has on the project."""
    sign_in(client, OWNER)
    project_id = seed_project(client, workspace)["project_id"]

    sign_in(client, GUEST)
    milestone = _seed_milestone(client, workspace, project_id)
    assert client.delete(_path(workspace, project_id, milestone["milestone_id"])).status_code == 204
    assert client.get(_path(workspace, project_id)).json()["milestones"] == []


def test_deleting_a_project_deletes_its_milestones(client: TestClient, repositories: Any, workspace: str) -> None:
    """No milestone row outlives its project."""
    sign_in(client, OWNER)
    project_id = seed_project(client, workspace)["project_id"]
    _seed_milestone(client, workspace, project_id)
    _seed_milestone(client, workspace, project_id, name="Beta")

    assert client.delete(f"/api/workspaces/{workspace}/projects/{project_id}").status_code == 204

    assert repositories.planning.list_milestones(WORKSPACE, project_id) == []


def test_the_project_listing_is_not_polluted_by_milestones(client: TestClient, workspace: str) -> None:
    """Milestone rows share the table but not the project prefix."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    _seed_milestone(client, workspace, project_id)

    projects = client.get(f"/api/workspaces/{workspace}/projects").json()["projects"]

    assert [row["project_id"] for row in projects] == [project_id]


def test_an_issue_takes_a_milestone_of_its_own_project_only(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """A milestone needs a project, and one from another project is refused."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    other_id = seed_project(client, workspace, name="Other")["project_id"]
    milestone = _seed_milestone(client, workspace, project_id)
    foreign = _seed_milestone(client, workspace, other_id)

    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace, project_id=project_id, project_milestone_id=milestone["milestone_id"])
    assert issue["project_milestone_id"] == milestone["milestone_id"]

    issues_path = f"/api/workspaces/{workspace}/issues"
    no_project = issues_client.post(
        issues_path, json={"team_id": TEAM, "title": "Loose", "project_milestone_id": milestone["milestone_id"]}
    )
    wrong = issues_client.post(
        issues_path,
        json={
            "team_id": TEAM,
            "title": "Wrong",
            "project_id": project_id,
            "project_milestone_id": foreign["milestone_id"],
        },
    )
    patched = issues_client.patch(
        f"{issues_path}/{issue['id']}", json={"project_milestone_id": foreign["milestone_id"]}
    )

    assert no_project.status_code == 422
    assert wrong.status_code == 422
    assert patched.status_code == 422


def test_changing_the_project_clears_the_milestone_and_records_it(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """A milestone belongs to one project, so moving the issue drops it, and the feed says so."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    other_id = seed_project(client, workspace, name="Other")["project_id"]
    milestone = _seed_milestone(client, workspace, project_id)

    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace, project_id=project_id)
    path = f"/api/workspaces/{workspace}/issues/{issue['id']}"

    attached = issues_client.patch(path, json={"project_milestone_id": milestone["milestone_id"]})
    assert attached.json()["project_milestone_id"] == milestone["milestone_id"]

    moved = issues_client.patch(path, json={"project_id": other_id})
    assert moved.status_code == 200
    assert moved.json()["project_milestone_id"] is None

    feed = issues_client.get(f"{path}/activity").json()["activity"]
    changes = [(row["from"], row["to"]) for row in feed if row.get("field") == "project_milestone_id"]
    assert (None, milestone["milestone_id"]) in changes
    assert (milestone["milestone_id"], None) in changes


def test_the_issue_list_filters_on_the_milestone(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """Both the match and the exclusion read the row's milestone."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    milestone = _seed_milestone(client, workspace, project_id)

    sign_in(issues_client, MEMBER)
    seed_issue(
        issues_client, workspace, title="In", project_id=project_id, project_milestone_id=milestone["milestone_id"]
    )
    seed_issue(issues_client, workspace, title="Out", project_id=project_id)

    issues_path = f"/api/workspaces/{workspace}/issues"
    matched = issues_client.get(
        issues_path, params={"team_id": TEAM, "project_milestone_id": milestone["milestone_id"]}
    ).json()["issues"]
    excluded = issues_client.get(
        issues_path, params={"team_id": TEAM, "project_milestone_id_not": milestone["milestone_id"]}
    ).json()["issues"]

    assert [row["title"] for row in matched] == ["In"]
    assert [row["title"] for row in excluded] == ["Out"]


def test_the_planning_rollup_counts_an_issue_into_its_milestone(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """The milestone is counted beside its project, and a move out of it decrements."""
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    milestone_id = _seed_milestone(client, workspace, project_id)["milestone_id"]
    backlog = next(
        row.status_id for row in repositories.team_config.list_statuses(WORKSPACE, TEAM) if row.category == "backlog"
    )
    image = {
        "workspace_id": {"S": WORKSPACE},
        "team_id": {"S": TEAM},
        "issue_id": {"S": "01JB0000000000000000ISSUE1"},
        "status_id": {"S": backlog},
        "project_id": {"S": project_id},
        "project_milestone_id": {"S": milestone_id},
    }

    planning_handle_record(repositories, {"eventName": "INSERT", "eventID": "1", "dynamodb": {"NewImage": image}})
    row = repositories.planning.get_milestone(WORKSPACE, project_id, milestone_id)
    assert row is not None
    assert row.counts.todo == 1
    assert row.counts.total == 1

    moved = {key: value for key, value in image.items() if key != "project_milestone_id"}
    planning_handle_record(
        repositories,
        {"eventName": "MODIFY", "eventID": "2", "dynamodb": {"NewImage": moved, "OldImage": image}},
    )
    row = repositories.planning.get_milestone(WORKSPACE, project_id, milestone_id)
    assert row is not None
    assert row.counts.total == 0
    project = repositories.planning.get_project(WORKSPACE, project_id)
    assert project is not None
    assert project.counts.total == 1


def test_a_removed_milestone_is_read_off_the_record_keys() -> None:
    """Only a milestone `REMOVE` is picked out; other planning records are ignored."""
    assert removed_milestone(_removal("P1", "M1")) == (WORKSPACE, "P1", "M1")

    modify = {**_removal("P1", "M1"), "eventName": "MODIFY"}
    project = _removal("P1", "M1")
    project["dynamodb"]["Keys"]["planning_key"] = {"S": "project#P1"}

    assert removed_milestone(modify) is None
    assert removed_milestone(project) is None
    assert removed_milestone({"eventName": "REMOVE", "dynamodb": {}}) is None


def test_deleting_a_milestone_detaches_its_issues_once(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """The issues consumer clears the milestone, keeps the project, and a redelivery is a no-op."""
    sign_in(client, OWNER)
    project_id = seed_project(client, workspace, team_id=None, team_ids=[TEAM, OTHER_TEAM])["project_id"]
    milestone_id = _seed_milestone(client, workspace, project_id)["milestone_id"]
    kept_id = _seed_milestone(client, workspace, project_id, name="Kept")["milestone_id"]

    sign_in(issues_client, OWNER)
    doomed = [
        seed_issue(issues_client, workspace, team_id=team, project_id=project_id, project_milestone_id=milestone_id)
        for team in (TEAM, OTHER_TEAM)
    ]
    kept = seed_issue(issues_client, workspace, project_id=project_id, project_milestone_id=kept_id)

    assert client.delete(_path(workspace, project_id, milestone_id)).status_code == 204
    issues_handle_record(repositories, _removal(project_id, milestone_id))

    for issue in doomed:
        row = repositories.issues.get(WORKSPACE, issue["id"])
        assert row.project_milestone_id is None
        assert row.project_id == project_id
    assert repositories.issues.get(WORKSPACE, kept["id"]).project_milestone_id == kept_id

    feed = issues_client.get(f"/api/workspaces/{workspace}/issues/{doomed[0]['id']}/activity").json()["activity"]
    system = [row for row in feed if row["actor_kind"] == "system" and row.get("field") == "project_milestone_id"]
    assert len(system) == 1
    assert system[0]["from"] == milestone_id
    assert system[0]["to"] is None

    assert detach_milestone(repositories, WORKSPACE, project_id, milestone_id) == 0
