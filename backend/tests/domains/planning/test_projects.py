"""Project routes: workspace-level projects shared by one or more teams.

The properties worth holding are the Linear-shaped fields and statuses, that a
project is reached by its own id without naming a team, and the authorization rule:
a caller sees a project when they see any of its teams, a guest is shown only the
teams it was invited to, changing the team list needs write access to every team
added or removed, and deleting needs an administrator of every team.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, GUEST, MEMBER, OUTSIDER, OWNER, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, TEAM, WORKSPACE, seed_project

NOPE = "01JB0000000000000000NOPE01"


def _path(workspace: str, project_id: str = "") -> str:
    """The project collection, or one project when an id is given."""
    base = f"/api/workspaces/{workspace}/projects"
    return f"{base}/{project_id}" if project_id else base


def test_a_project_is_created_in_the_backlog_with_empty_counts(client: TestClient, workspace: str) -> None:
    """A new project sits in the backlog until somebody plans it."""
    sign_in(client, MEMBER)

    body = seed_project(client, workspace, name="Launch", description="The first release")

    assert body["name"] == "Launch"
    assert body["description"] == "The first release"
    assert body["status"] == "backlog"
    assert body["team_ids"] == [TEAM]
    assert body["team_id"] == TEAM
    assert body["lead_id"] is None
    assert body["start_date"] is None
    assert body["target_date"] is None
    assert body["counts"] == {"todo": 0, "in_progress": 0, "done": 0, "cancelled": 0, "total": 0}


def test_a_project_spans_several_teams(client: TestClient, workspace: str) -> None:
    """`team_ids` keeps the caller's order and folds a duplicate."""
    sign_in(client, MEMBER)

    body = seed_project(
        client,
        workspace,
        team_id=None,
        team_ids=[OTHER_TEAM, TEAM, OTHER_TEAM],
        lead_id=OWNER,
        start_date="2026-01-01",
        target_date="2026-03-01",
        status="planned",
    )

    assert body["team_ids"] == [OTHER_TEAM, TEAM]
    assert body["team_id"] == OTHER_TEAM
    assert body["lead_id"] == OWNER
    assert body["start_date"] == "2026-01-01"
    assert body["status"] == "planned"


def test_a_project_needs_at_least_one_team(client: TestClient, workspace: str) -> None:
    """A project on no team would be visible to nobody."""
    sign_in(client, MEMBER)

    empty = client.post(_path(workspace), json={"team_ids": [], "name": "Nowhere"})
    missing = client.post(_path(workspace), json={"name": "Nowhere"})

    assert empty.status_code == 422
    assert missing.status_code == 422


def test_a_legacy_team_id_must_be_among_the_team_ids(client: TestClient, workspace: str) -> None:
    """Both spellings together must agree."""
    sign_in(client, MEMBER)

    response = client.post(_path(workspace), json={"team_ids": [TEAM], "team_id": OTHER_TEAM, "name": "Mixed"})

    assert response.status_code == 422


def test_the_lead_must_be_a_workspace_member(client: TestClient, workspace: str) -> None:
    """A lead outside the workspace is refused rather than stored."""
    sign_in(client, MEMBER)

    response = client.post(_path(workspace), json={"team_ids": [TEAM], "name": "Led", "lead_id": OUTSIDER})

    assert response.status_code == 422


def test_the_target_date_may_not_precede_the_start(client: TestClient, workspace: str) -> None:
    """Both on create and once a patch is merged."""
    sign_in(client, MEMBER)

    created = client.post(
        _path(workspace),
        json={"team_ids": [TEAM], "name": "Backwards", "start_date": "2026-02-01", "target_date": "2026-01-01"},
    )
    assert created.status_code == 422

    project = seed_project(client, workspace, start_date="2026-01-01", target_date="2026-02-01")
    patched = client.patch(_path(workspace, project["project_id"]), json={"start_date": "2026-03-01"})
    assert patched.status_code == 422


def test_a_project_is_read_without_naming_a_team(client: TestClient, workspace: str) -> None:
    """The id alone reaches the row; a legacy `team_id` must be one of its teams."""
    sign_in(client, MEMBER)
    project = seed_project(client, workspace)

    plain = client.get(_path(workspace, project["project_id"]))
    legacy = client.get(_path(workspace, project["project_id"]), params={"team_id": TEAM})
    wrong = client.get(_path(workspace, project["project_id"]), params={"team_id": OTHER_TEAM})

    assert plain.status_code == 200
    assert legacy.status_code == 200
    assert wrong.status_code == 404


def test_the_status_is_stored_and_the_legacy_done_reads_as_completed(client: TestClient, workspace: str) -> None:
    """A deployed client still sending `done` lands on `completed`."""
    sign_in(client, MEMBER)
    project = seed_project(client, workspace, target_date="2999-01-01")

    moved = client.patch(_path(workspace, project["project_id"]), json={"status": "paused"})
    legacy = client.patch(_path(workspace, project["project_id"]), json={"team_id": TEAM, "status": "done"})

    assert moved.json()["status"] == "paused"
    assert legacy.status_code == 200
    assert legacy.json()["status"] == "completed"
    assert legacy.json()["target_date"] == "2999-01-01"


def test_a_status_outside_the_set_is_refused(client: TestClient, workspace: str) -> None:
    """The set is fixed by the contract."""
    sign_in(client, MEMBER)
    project = seed_project(client, workspace)

    response = client.patch(_path(workspace, project["project_id"]), json={"status": "someday"})

    assert response.status_code == 422


def test_a_required_field_cannot_be_cleared(client: TestClient, workspace: str) -> None:
    """Null clears an optional field and is refused on one every project has."""
    sign_in(client, MEMBER)
    project = seed_project(client, workspace, lead_id=OWNER)

    for field in ("name", "status", "team_ids"):
        response = client.patch(_path(workspace, project["project_id"]), json={field: None})
        assert response.status_code == 422, field

    cleared = client.patch(_path(workspace, project["project_id"]), json={"lead_id": None})
    assert cleared.status_code == 200
    assert cleared.json()["lead_id"] is None


def test_projects_list_at_workspace_level_by_target_date_with_undated_last(client: TestClient, workspace: str) -> None:
    """No team is needed, and an absent target does not lead the list."""
    sign_in(client, MEMBER)
    seed_project(client, workspace, name="Undated")
    seed_project(client, workspace, name="Later", target_date="2026-06-01", team_id=OTHER_TEAM)
    seed_project(client, workspace, name="Sooner", target_date="2026-02-01")

    response = client.get(_path(workspace))

    assert response.status_code == 200
    assert [row["name"] for row in response.json()["projects"]] == ["Sooner", "Later", "Undated"]


def test_the_team_filter_keeps_projects_that_team_is_on(client: TestClient, workspace: str) -> None:
    """A shared project appears under each of its teams."""
    sign_in(client, MEMBER)
    seed_project(client, workspace, name="Mine")
    seed_project(client, workspace, name="Theirs", team_id=OTHER_TEAM)
    seed_project(client, workspace, name="Shared", team_id=None, team_ids=[OTHER_TEAM, TEAM])

    mine = client.get(_path(workspace), params={"team_id": TEAM})
    theirs = client.get(_path(workspace), params={"team_id": OTHER_TEAM})

    assert sorted(row["name"] for row in mine.json()["projects"]) == ["Mine", "Shared"]
    assert sorted(row["name"] for row in theirs.json()["projects"]) == ["Shared", "Theirs"]


def test_the_status_filter_narrows_the_listing(client: TestClient, workspace: str) -> None:
    """Status is stored, so a filter is an equality on what the row holds."""
    sign_in(client, MEMBER)
    seed_project(client, workspace, name="Planned one", status="planned")
    seed_project(client, workspace, name="Finished", status="completed")

    response = client.get(_path(workspace), params={"status": "completed"})
    legacy = client.get(_path(workspace), params={"status": "done"})

    assert [row["name"] for row in response.json()["projects"]] == ["Finished"]
    assert [row["name"] for row in legacy.json()["projects"]] == ["Finished"]


def test_the_list_pages_over_the_visible_order(client: TestClient, workspace: str) -> None:
    """A cursor walks the whole list with no repeats and no gaps."""
    sign_in(client, MEMBER)
    for month in range(1, 6):
        seed_project(client, workspace, name=f"P{month}", target_date=f"2026-0{month}-01")

    names: list[str] = []
    cursor = None
    while True:
        params: dict[str, str | int] = {"limit": 2}
        if cursor:
            params["cursor"] = cursor
        page = client.get(_path(workspace), params=params).json()
        names.extend(row["name"] for row in page["projects"])
        cursor = page["next_cursor"]
        if not cursor:
            break

    assert names == ["P1", "P2", "P3", "P4", "P5"]


def test_clearing_the_target_date_removes_it(client: TestClient, workspace: str) -> None:
    """A null target removes the attribute, so the project reads as undated."""
    sign_in(client, MEMBER)
    project = seed_project(client, workspace, target_date="2026-02-01")

    response = client.patch(_path(workspace, project["project_id"]), json={"target_date": None})

    assert response.status_code == 200
    assert response.json()["target_date"] is None

    roadmap = client.get(f"/api/workspaces/{workspace}/roadmap")
    assert [entry["target_date"] for entry in roadmap.json()["entries"]] == [None]


def test_a_guest_sees_a_shared_project_but_only_its_own_teams(client: TestClient, workspace: str) -> None:
    """The team a guest was not invited to is not named to them."""
    sign_in(client, OWNER)
    shared = seed_project(client, workspace, name="Shared", team_id=None, team_ids=[OTHER_TEAM, TEAM])
    seed_project(client, workspace, name="Hidden", team_id=OTHER_TEAM)

    sign_in(client, GUEST)
    listed = client.get(_path(workspace))
    read = client.get(_path(workspace, shared["project_id"]))

    assert [row["name"] for row in listed.json()["projects"]] == ["Shared"]
    assert read.json()["team_ids"] == [TEAM]
    assert read.json()["team_id"] == TEAM


def test_a_guest_outside_every_team_gets_a_404_not_a_403(client: TestClient, workspace: str) -> None:
    """Invisible and absent look identical on every verb."""
    sign_in(client, OWNER)
    hidden = seed_project(client, workspace, team_id=OTHER_TEAM)

    sign_in(client, GUEST)
    listed = client.get(_path(workspace), params={"team_id": OTHER_TEAM})
    created = client.post(_path(workspace), json={"team_ids": [OTHER_TEAM], "name": "Sneaky"})
    spread = client.post(_path(workspace), json={"team_ids": [TEAM, OTHER_TEAM], "name": "Sneaky"})
    read = client.get(_path(workspace, hidden["project_id"]))
    patched = client.patch(_path(workspace, hidden["project_id"]), json={"name": "Mine now"})
    deleted = client.delete(_path(workspace, hidden["project_id"]))
    absent = client.get(_path(workspace, NOPE))

    assert listed.status_code == 404
    assert created.status_code == 404
    assert spread.status_code == 404
    assert read.status_code == 404
    assert patched.status_code == 404
    assert deleted.status_code == 404
    assert absent.status_code == 404


def test_a_guest_edit_keeps_the_teams_it_cannot_see(client: TestClient, workspace: str) -> None:
    """Replacing `team_ids` replaces only the caller's view of them."""
    sign_in(client, OWNER)
    shared = seed_project(client, workspace, team_id=None, team_ids=[TEAM, OTHER_TEAM])

    sign_in(client, GUEST)
    response = client.patch(_path(workspace, shared["project_id"]), json={"team_ids": [TEAM], "name": "Renamed"})
    assert response.status_code == 200
    assert response.json()["team_ids"] == [TEAM]

    sign_in(client, OWNER)
    read = client.get(_path(workspace, shared["project_id"]))
    assert read.json()["team_ids"] == [TEAM, OTHER_TEAM]
    assert read.json()["name"] == "Renamed"


def test_a_guest_may_not_leave_itself_without_a_visible_team(client: TestClient, workspace: str) -> None:
    """Dropping the last visible team would hand the project to teams the guest cannot see."""
    sign_in(client, OWNER)
    shared = seed_project(client, workspace, team_id=None, team_ids=[TEAM, OTHER_TEAM])

    sign_in(client, GUEST)
    response = client.patch(_path(workspace, shared["project_id"]), json={"team_ids": [OTHER_TEAM]})

    assert response.status_code == 422


def test_adding_a_team_needs_write_access_to_it(client: TestClient, workspace: str) -> None:
    """A guest cannot put a project onto a team it is outside."""
    sign_in(client, GUEST)
    project = seed_project(client, workspace)

    response = client.patch(_path(workspace, project["project_id"]), json={"team_ids": [TEAM, OTHER_TEAM]})

    assert response.status_code == 404


def test_a_member_moves_a_project_between_teams(client: TestClient, workspace: str) -> None:
    """A member writes in every team, so adding and removing both succeed."""
    sign_in(client, MEMBER)
    project = seed_project(client, workspace)

    response = client.patch(_path(workspace, project["project_id"]), json={"team_ids": [OTHER_TEAM]})

    assert response.status_code == 200
    assert response.json()["team_ids"] == [OTHER_TEAM]
    assert response.json()["team_id"] == OTHER_TEAM


def test_deleting_a_project_needs_an_admin_of_every_team(client: TestClient, workspace: str) -> None:
    """A delete detaches issues in each team, so one team's say is not enough."""
    sign_in(client, OWNER)
    shared = seed_project(client, workspace, team_id=None, team_ids=[TEAM, OTHER_TEAM])

    sign_in(client, MEMBER)
    assert client.delete(_path(workspace, shared["project_id"])).status_code == 403

    sign_in(client, GUEST)
    assert client.delete(_path(workspace, shared["project_id"])).status_code == 403

    sign_in(client, ADMIN)
    assert client.delete(_path(workspace, shared["project_id"])).status_code == 204
    assert client.get(_path(workspace, shared["project_id"])).status_code == 404


def test_a_legacy_team_id_on_delete_must_be_one_of_its_teams(client: TestClient, workspace: str) -> None:
    """The old query parameter still works, and a wrong one is a 404."""
    sign_in(client, OWNER)
    project = seed_project(client, workspace)

    wrong = client.delete(_path(workspace, project["project_id"]), params={"team_id": OTHER_TEAM})
    right = client.delete(_path(workspace, project["project_id"]), params={"team_id": TEAM})

    assert wrong.status_code == 404
    assert right.status_code == 204


def test_a_non_member_of_the_workspace_gets_a_404(client: TestClient, workspace: str) -> None:
    """The workspace itself is unenumerable to somebody outside it."""
    sign_in(client, OUTSIDER)

    response = client.get(_path(workspace))

    assert response.status_code == 404


def test_a_blank_name_is_refused(client: TestClient, workspace: str) -> None:
    """Whitespace is not a name, and the schema can say so without a table read."""
    sign_in(client, MEMBER)

    response = client.post(_path(workspace), json={"team_ids": [TEAM], "name": "   "})

    assert response.status_code == 422


def test_a_malformed_date_is_refused(client: TestClient, workspace: str) -> None:
    """The contract fixes the format, so anything else is a 422 naming the field."""
    sign_in(client, MEMBER)

    target = client.post(_path(workspace), json={"team_ids": [TEAM], "name": "Launch", "target_date": "next tuesday"})
    start = client.post(_path(workspace), json={"team_ids": [TEAM], "name": "Launch", "start_date": "soon"})

    assert target.status_code == 422
    assert start.status_code == 422


def test_an_admin_may_write_in_a_team_they_are_not_a_member_of(client: TestClient, workspace: str) -> None:
    """A workspace admin has an implied team role, so no explicit membership is needed."""
    sign_in(client, ADMIN)

    response = client.post(_path(workspace), json={"team_ids": [OTHER_TEAM], "name": "Admin project"})

    assert response.status_code == 201


def test_rows_stranded_under_the_project_prefix_are_skipped(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A renamed-away cycle row and a pre-team-list project row do not break the list."""
    sign_in(client, MEMBER)
    seed_project(client, workspace, name="Current")
    table = repositories.planning._repository
    table.put({"workspace_id": WORKSPACE, "planning_key": f"project#{WORKSPACE}#cycle#OLD", "kind": "cycle"})
    table.put({"workspace_id": WORKSPACE, "planning_key": "project#OLDSHAPE", "kind": "project", "name": "Old"})

    response = client.get(_path(workspace))

    assert response.status_code == 200
    assert [row["name"] for row in response.json()["projects"]] == ["Current"]
    assert client.get(_path(workspace, "OLDSHAPE")).status_code == 404
