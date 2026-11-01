"""Initiatives: workspace-level groups of projects across teams.

The properties worth holding are that a guest is refused every initiative route,
that an initiative rolls up the progress and health of the projects in it, that a
project may sit in several initiatives and counts under each, that a row from
before the set still reads in its one initiative, that deleting an initiative
leaves its projects in place outside it and in their other initiatives, and that its
update feed mirrors health the way a project's does.
"""

from __future__ import annotations

import itertools
from datetime import UTC, datetime, timedelta
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.dynamodb import new_ulid

from app.common.db.dynamo.planning import PlanningRepository, Project
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_member, add_team_member, make_user, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, WORKSPACE, seed_project

PEER = "01JB000000000000000000PEER"


@pytest.fixture
def peer(repositories: Any, workspace: str) -> str:
    """A second plain member, who neither created nor owns the initiatives under test."""
    add_member(repositories, WORKSPACE, PEER, "member")
    make_user(repositories, PEER, "peer@example.com", "Pat Peer")
    return PEER


@pytest.fixture(autouse=True)
def ordered_ids(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Mint ids a millisecond apart, so updates posted in one millisecond still sort in order."""
    start = datetime.now(UTC)
    counter = itertools.count()
    monkeypatch.setattr(
        "app.common.initiative_writes.new_planning_id",
        lambda: new_ulid(start + timedelta(milliseconds=next(counter))),
    )
    yield


def _base(workspace: str) -> str:
    """The workspace's initiatives collection."""
    return f"/api/workspaces/{workspace}/initiatives"


def _create(client: TestClient, workspace: str, **payload: Any) -> "dict[str, Any]":
    """Create one initiative through the route, failing loudly on a refusal."""
    body: "dict[str, Any]" = {"name": "Expand to Europe"}
    body.update(payload)
    response = client.post(_base(workspace), json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _get(client: TestClient, workspace: str, initiative_id: str) -> "dict[str, Any]":
    """One initiative as the API reads it."""
    response = client.get(f"{_base(workspace)}/{initiative_id}")
    assert response.status_code == 200, response.text
    return response.json()


def _add(client: TestClient, workspace: str, initiative_id: str, project_id: str) -> "dict[str, Any]":
    """Put a project in an initiative, failing loudly on a refusal."""
    response = client.put(f"{_base(workspace)}/{initiative_id}/projects/{project_id}")
    assert response.status_code == 200, response.text
    return response.json()


def test_a_member_creates_reads_and_patches_an_initiative(client: TestClient, workspace: str) -> None:
    """The fields round trip, and null clears the optional ones."""
    sign_in(client, MEMBER)
    created = _create(
        client, workspace, description="EU launch", owner_id=ADMIN, status="active", target_date="2026-12-01"
    )

    assert created["status"] == "active"
    assert created["owner_id"] == ADMIN
    assert created["created_by"] == MEMBER
    assert created["project_ids"] == []
    assert created["project_count"] == 0

    patched = client.patch(
        f"{_base(workspace)}/{created['initiative_id']}",
        json={"name": "Expand to the EU", "owner_id": None, "status": "completed", "target_date": None},
    )

    assert patched.status_code == 200, patched.text
    body = patched.json()
    assert body["name"] == "Expand to the EU"
    assert body["owner_id"] is None
    assert body["status"] == "completed"
    assert body["target_date"] is None
    assert body["description"] == "EU launch"


def test_name_and_status_cannot_be_cleared_and_the_owner_must_be_a_member(client: TestClient, workspace: str) -> None:
    """A null name or status, an unknown status or an outside owner is refused."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)["initiative_id"]
    path = f"{_base(workspace)}/{initiative_id}"

    assert client.patch(path, json={"name": None}).status_code == 422
    assert client.patch(path, json={"status": None}).status_code == 422
    assert client.patch(path, json={"status": "shipped"}).status_code == 422
    unknown_owner = {"name": "X", "owner_id": "01JB000000000000000000NOPE"}
    assert client.post(_base(workspace), json=unknown_owner).status_code == 422


def test_a_guest_is_refused_every_initiative_route(client: TestClient, workspace: str) -> None:
    """An initiative spans the workspace, so a guest sees none of it."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)["initiative_id"]
    project_id = seed_project(client, workspace)["project_id"]
    sign_in(client, GUEST)

    assert client.get(_base(workspace)).status_code == 403
    assert client.post(_base(workspace), json={"name": "Mine"}).status_code == 403
    assert client.get(f"{_base(workspace)}/{initiative_id}").status_code == 403
    assert client.patch(f"{_base(workspace)}/{initiative_id}", json={"name": "Y"}).status_code == 403
    assert client.put(f"{_base(workspace)}/{initiative_id}/projects/{project_id}").status_code == 403
    assert client.get(f"{_base(workspace)}/{initiative_id}/updates").status_code == 403
    by_initiative = {"initiative_id": initiative_id}
    assert client.get(f"/api/workspaces/{workspace}/projects", params=by_initiative).status_code == 403


def test_the_list_sorts_by_target_date_filters_by_status_and_pages(client: TestClient, workspace: str) -> None:
    """Dated initiatives come first by date, undated last, and a cursor resumes the list."""
    sign_in(client, MEMBER)
    _create(client, workspace, name="Undated")
    _create(client, workspace, name="Late", target_date="2027-03-01", status="active")
    _create(client, workspace, name="Early", target_date="2026-11-01", status="active")

    listed = client.get(_base(workspace)).json()
    assert [row["name"] for row in listed["initiatives"]] == ["Early", "Late", "Undated"]

    active = client.get(_base(workspace), params={"status": "active"}).json()
    assert [row["name"] for row in active["initiatives"]] == ["Early", "Late"]
    assert client.get(_base(workspace), params={"status": "nope"}).status_code == 422

    first = client.get(_base(workspace), params={"limit": 2}).json()
    assert len(first["initiatives"]) == 2
    second = client.get(_base(workspace), params={"limit": 2, "cursor": first["next_cursor"]}).json()
    assert [row["name"] for row in second["initiatives"]] == ["Undated"]
    assert second["next_cursor"] is None


def test_an_initiative_rolls_up_the_health_of_its_projects(client: TestClient, workspace: str) -> None:
    """Projects on different teams count together, tallied by health."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)["initiative_id"]
    first = seed_project(client, workspace, name="Billing", health="at_risk")["project_id"]
    second = seed_project(client, workspace, team_id=OTHER_TEAM, name="Docs")["project_id"]
    seed_project(client, workspace, name="Outside")

    assert _add(client, workspace, initiative_id, first)["initiative_id"] == initiative_id
    _add(client, workspace, initiative_id, second)

    body = _get(client, workspace, initiative_id)
    assert sorted(body["project_ids"]) == sorted([first, second])
    assert body["project_count"] == 2
    assert body["project_health"] == {"on_track": 0, "at_risk": 1, "off_track": 0, "none": 1}

    filtered = client.get(f"/api/workspaces/{workspace}/projects", params={"initiative_id": initiative_id}).json()
    assert sorted(row["project_id"] for row in filtered["projects"]) == sorted([first, second])


def test_a_project_joins_another_initiative_and_stays_in_the_first(client: TestClient, workspace: str) -> None:
    """A project belongs to every initiative it is added to, the first one staying its primary one."""
    sign_in(client, MEMBER)
    one = _create(client, workspace, name="One")["initiative_id"]
    two = _create(client, workspace, name="Two")["initiative_id"]
    project_id = seed_project(client, workspace)["project_id"]

    _add(client, workspace, one, project_id)
    joined = _add(client, workspace, two, project_id)
    again = _add(client, workspace, two, project_id)

    assert joined["initiative_id"] == one
    assert joined["initiative_ids"] == [one, two]
    assert again["initiative_ids"] == [one, two]
    assert _get(client, workspace, one)["project_ids"] == [project_id]
    assert _get(client, workspace, two)["project_ids"] == [project_id]
    for initiative_id in (one, two):
        listed = client.get(f"/api/workspaces/{workspace}/projects", params={"initiative_id": initiative_id}).json()
        assert [row["project_id"] for row in listed["projects"]] == [project_id]

    left = client.delete(f"{_base(workspace)}/{one}/projects/{project_id}").json()
    assert (left["initiative_id"], left["initiative_ids"]) == (two, [two])
    assert _get(client, workspace, one)["project_ids"] == []


def test_a_project_in_a_parent_and_its_sub_initiative_counts_once(client: TestClient, workspace: str) -> None:
    """The parent's rollup takes the project in once although it sits on two levels of the tree."""
    sign_in(client, MEMBER)
    parent = _create(client, workspace, name="Parent")["initiative_id"]
    child = _create(client, workspace, name="Child", parent_initiative_id=parent)["initiative_id"]
    project_id = seed_project(client, workspace)["project_id"]
    _add(client, workspace, parent, project_id)
    _add(client, workspace, child, project_id)

    body = _get(client, workspace, parent)
    assert body["project_ids"] == [project_id]
    assert body["project_count"] == 1


def test_a_row_from_before_the_set_reads_in_its_one_initiative(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A stored project holding only `initiative_id` keeps its initiative, and joining another keeps both."""
    sign_in(client, MEMBER)
    one = _create(client, workspace, name="One")["initiative_id"]
    two = _create(client, workspace, name="Two")["initiative_id"]
    project_id = seed_project(client, workspace)["project_id"]
    repositories.planning._repository.update(
        {"workspace_id": WORKSPACE, "planning_key": f"project#{project_id}"},
        update_expression="SET initiative_id = :one",
        expression_values={":one": one},
    )

    read = client.get(f"/api/workspaces/{workspace}/projects/{project_id}").json()
    assert (read["initiative_id"], read["initiative_ids"]) == (one, [one])
    assert _get(client, workspace, one)["project_ids"] == [project_id]

    joined = _add(client, workspace, two, project_id)
    assert joined["initiative_ids"] == [one, two]


def test_a_row_last_written_by_a_single_value_writer_trusts_that_value(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """When `initiative_id` no longer leads `initiative_ids`, older code moved it, and that value wins."""
    sign_in(client, MEMBER)
    one = _create(client, workspace, name="One")["initiative_id"]
    two = _create(client, workspace, name="Two")["initiative_id"]
    project_id = seed_project(client, workspace)["project_id"]
    _add(client, workspace, one, project_id)
    repositories.planning._repository.update(
        {"workspace_id": WORKSPACE, "planning_key": f"project#{project_id}"},
        update_expression="SET initiative_id = :two",
        expression_values={":two": two},
    )

    read = client.get(f"/api/workspaces/{workspace}/projects/{project_id}").json()
    assert read["initiative_ids"] == [two]


def test_removing_a_project_needs_it_to_be_in_that_initiative(client: TestClient, workspace: str) -> None:
    """Removal from an initiative the project is not in is a 404 and changes nothing."""
    sign_in(client, MEMBER)
    one = _create(client, workspace, name="One")["initiative_id"]
    two = _create(client, workspace, name="Two")["initiative_id"]
    project_id = seed_project(client, workspace)["project_id"]
    _add(client, workspace, one, project_id)

    assert client.delete(f"{_base(workspace)}/{two}/projects/{project_id}").status_code == 404

    removed = client.delete(f"{_base(workspace)}/{one}/projects/{project_id}")
    assert removed.status_code == 200, removed.text
    assert removed.json()["initiative_id"] is None
    assert _get(client, workspace, one)["project_ids"] == []


def _serve_stale_project(monkeypatch: pytest.MonkeyPatch, repositories: Any, workspace: str, project_id: str) -> None:
    """Make every later read of one project return the row as it stands now, as a lagging read would."""
    stale = repositories.planning.get_project(workspace, project_id)
    original = PlanningRepository.get_project

    def lagging(self: PlanningRepository, workspace_id: str, wanted: str) -> Project | None:
        """The frozen row for the project under test, every other one read as usual."""
        return stale if wanted == project_id else original(self, workspace_id, wanted)

    monkeypatch.setattr(PlanningRepository, "get_project", lagging)


def test_membership_changes_answer_with_the_written_row_not_a_stale_read(
    client: TestClient, workspace: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Adding and removing return the initiative just written even when a read straight after lags behind it."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)["initiative_id"]
    project_id = seed_project(client, workspace)["project_id"]

    with monkeypatch.context() as patch:
        _serve_stale_project(patch, repositories, workspace, project_id)
        added = _add(client, workspace, initiative_id, project_id)
    assert added["initiative_id"] == initiative_id

    with monkeypatch.context() as patch:
        _serve_stale_project(patch, repositories, workspace, project_id)
        removed = client.delete(f"{_base(workspace)}/{initiative_id}/projects/{project_id}")
    assert removed.status_code == 200, removed.text
    assert removed.json()["initiative_id"] is None


def test_a_project_patch_sets_and_clears_its_initiative(client: TestClient, workspace: str) -> None:
    """The project form picks an initiative directly; an unknown one is refused."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)["initiative_id"]
    project_id = seed_project(client, workspace)["project_id"]
    path = f"/api/workspaces/{workspace}/projects/{project_id}"

    assert client.patch(path, json={"initiative_id": "01JB000000000000000000NOPE"}).status_code == 422
    assert client.patch(path, json={"initiative_id": initiative_id}).json()["initiative_id"] == initiative_id
    assert _get(client, workspace, initiative_id)["project_ids"] == [project_id]
    assert client.patch(path, json={"initiative_id": None}).json()["initiative_id"] is None

    created = seed_project(client, workspace, name="Born inside", initiative_id=initiative_id)
    assert created["initiative_id"] == initiative_id
    assert created["initiative_ids"] == [initiative_id]


def test_a_project_patch_replaces_its_set_of_initiatives(client: TestClient, workspace: str) -> None:
    """`initiative_ids` sets the whole set, wins over `initiative_id`, and an empty list clears it."""
    sign_in(client, MEMBER)
    one = _create(client, workspace, name="One")["initiative_id"]
    two = _create(client, workspace, name="Two")["initiative_id"]
    project_id = seed_project(client, workspace)["project_id"]
    path = f"/api/workspaces/{workspace}/projects/{project_id}"

    bad = client.patch(path, json={"initiative_ids": [one, "01JB000000000000000000NOPE"]})
    assert bad.status_code == 422
    both = client.patch(path, json={"initiative_ids": [two, one, two]}).json()
    assert (both["initiative_id"], both["initiative_ids"]) == (two, [two, one])
    assert _get(client, workspace, one)["project_ids"] == [project_id]
    assert _get(client, workspace, two)["project_ids"] == [project_id]

    single = client.patch(path, json={"initiative_id": one}).json()
    assert single["initiative_ids"] == [one]
    cleared = client.patch(path, json={"initiative_ids": []}).json()
    assert (cleared["initiative_id"], cleared["initiative_ids"]) == (None, [])

    created = seed_project(client, workspace, name="Born in two", initiative_ids=[one, two])
    assert created["initiative_ids"] == [one, two]


def test_deleting_an_initiative_leaves_its_projects_outside_it(client: TestClient, workspace: str, peer: str) -> None:
    """The projects survive with no initiative, and only the creator, owner or an admin may delete."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)["initiative_id"]
    project_id = seed_project(client, workspace)["project_id"]
    _add(client, workspace, initiative_id, project_id)
    client.post(f"{_base(workspace)}/{initiative_id}/updates", json={"body": "Fine", "health": "on_track"})

    sign_in(client, peer)
    assert client.delete(f"{_base(workspace)}/{initiative_id}").status_code == 403
    sign_in(client, ADMIN)
    response = client.delete(f"{_base(workspace)}/{initiative_id}")

    assert response.status_code == 204, response.text
    assert client.get(f"{_base(workspace)}/{initiative_id}").status_code == 404
    project = client.get(f"/api/workspaces/{workspace}/projects/{project_id}").json()
    assert project.get("initiative_id") is None


def test_deleting_an_initiative_keeps_its_projects_in_their_other_initiatives(
    client: TestClient, workspace: str
) -> None:
    """A project in two initiatives stays in the one that survives."""
    sign_in(client, MEMBER)
    one = _create(client, workspace, name="One")["initiative_id"]
    two = _create(client, workspace, name="Two")["initiative_id"]
    project_id = seed_project(client, workspace)["project_id"]
    _add(client, workspace, one, project_id)
    _add(client, workspace, two, project_id)

    assert client.delete(f"{_base(workspace)}/{one}").status_code == 204

    project = client.get(f"/api/workspaces/{workspace}/projects/{project_id}").json()
    assert (project["initiative_id"], project["initiative_ids"]) == (two, [two])


def test_the_update_feed_mirrors_health_and_falls_back_on_delete(client: TestClient, workspace: str) -> None:
    """The newest update sets the initiative's health; deleting it restores the one before."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)["initiative_id"]
    feed = f"{_base(workspace)}/{initiative_id}/updates"

    first = client.post(feed, json={"body": "Started", "health": "on_track"}).json()
    second = client.post(feed, json={"body": "Slipping", "health": "at_risk"}).json()

    assert first["can_edit"] is True
    assert _get(client, workspace, initiative_id)["health"] == "at_risk"
    listed = client.get(feed).json()
    assert [row["body"] for row in listed["updates"]] == ["Slipping", "Started"]

    edited = client.patch(f"{feed}/{second['update_id']}", json={"health": "off_track"})
    assert edited.status_code == 200, edited.text
    assert edited.json()["edited_at"] is not None
    assert _get(client, workspace, initiative_id)["health"] == "off_track"

    assert client.delete(f"{feed}/{second['update_id']}").status_code == 204
    body = _get(client, workspace, initiative_id)
    assert body["health"] == "on_track"
    assert body["last_update_at"] == first["created_at"]


def test_only_the_author_owner_or_an_admin_edits_an_update(client: TestClient, workspace: str, peer: str) -> None:
    """Another member reads the update without an edit right; the initiative's owner and an admin may edit."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace, owner_id=ADMIN)["initiative_id"]
    feed = f"{_base(workspace)}/{initiative_id}/updates"
    update = client.post(feed, json={"body": "Mine", "health": "on_track"}).json()

    sign_in(client, peer)
    assert client.get(feed).json()["updates"][0]["can_edit"] is False
    assert client.patch(f"{feed}/{update['update_id']}", json={"body": "Not mine"}).status_code == 403
    assert client.delete(f"{feed}/{update['update_id']}").status_code == 403

    sign_in(client, ADMIN)
    assert client.patch(f"{feed}/{update['update_id']}", json={"body": "Owner edit"}).status_code == 200
    sign_in(client, OWNER)
    assert client.get(feed).json()["updates"][0]["can_edit"] is True


def test_an_initiative_target_may_be_a_month_quarter_half_or_year(client: TestClient, workspace: str) -> None:
    """A coarse target closes its period, sorts by that end, widens on a resolution alone and clears with the date."""
    sign_in(client, MEMBER)
    half = _create(client, workspace, name="Half", target_date="2027-02-10", target_date_resolution="half")
    exact = _create(client, workspace, name="Exact", target_date="2027-05-01")
    path = f"{_base(workspace)}/{half['initiative_id']}"

    listed = client.get(_base(workspace)).json()["initiatives"]
    yearly = client.patch(path, json={"target_date_resolution": "year"}).json()
    refused = client.post(_base(workspace), json={"name": "None", "target_date_resolution": "quarter"})
    cleared = client.patch(path, json={"target_date": None}).json()

    assert (half["target_date"], half["target_date_resolution"]) == ("2027-06-30", "half")
    assert exact["target_date_resolution"] == "day"
    assert [row["name"] for row in listed] == ["Exact", "Half"]
    assert (yearly["target_date"], yearly["target_date_resolution"]) == ("2027-12-31", "year")
    assert refused.status_code == 422
    assert (cleared["target_date"], cleared["target_date_resolution"]) == (None, None)


def test_an_initiative_start_date_opens_its_period_and_never_follows_the_target(
    client: TestClient, workspace: str
) -> None:
    """A coarse start opens its period, a start after the target is refused either way round, and null clears it."""
    sign_in(client, MEMBER)
    created = _create(
        client,
        workspace,
        name="Span",
        start_date="2027-02-10",
        start_date_resolution="quarter",
        target_date="2027-09-15",
    )
    path = f"{_base(workspace)}/{created['initiative_id']}"

    backwards = client.post(
        _base(workspace), json={"name": "Backwards", "start_date": "2027-05-01", "target_date": "2027-04-01"}
    )
    late_start = client.patch(path, json={"start_date": "2027-10-01"})
    early_target = client.patch(path, json={"target_date": "2026-12-31"})
    moved = client.patch(path, json={"start_date": "2027-03-03", "start_date_resolution": "day"}).json()
    halved = client.patch(path, json={"start_date_resolution": "half"}).json()
    unanchored = client.post(_base(workspace), json={"name": "None", "start_date_resolution": "month"})
    cleared = client.patch(path, json={"start_date": None}).json()

    assert (created["start_date"], created["start_date_resolution"]) == ("2027-01-01", "quarter")
    assert backwards.status_code == 422
    assert late_start.status_code == 422
    assert early_target.status_code == 422
    assert (moved["start_date"], moved["start_date_resolution"]) == ("2027-03-03", "day")
    assert (halved["start_date"], halved["start_date_resolution"]) == ("2027-01-01", "half")
    assert unanchored.status_code == 422
    assert (cleared["start_date"], cleared["start_date_resolution"]) == (None, None)
    assert client.get(path).json()["target_date"] == "2027-09-15"


def test_a_new_initiative_is_placed_first_and_a_patch_moves_it_in_the_manual_order(
    client: TestClient, workspace: str, peer: str
) -> None:
    """Each new initiative takes a key ahead of the others, and a reorder is a patch every member reads back."""
    sign_in(client, MEMBER)
    older = _create(client, workspace, name="Older")
    newer = _create(client, workspace, name="Newer")

    assert older["sort_order"] is not None
    assert newer["sort_order"] is not None
    assert newer["sort_order"] < older["sort_order"]

    path = f"{_base(workspace)}/{newer['initiative_id']}"
    moved = client.patch(path, json={"sort_order": older["sort_order"] + "V"})
    assert moved.status_code == 200, moved.text
    assert moved.json()["sort_order"] == older["sort_order"] + "V"
    assert client.patch(path, json={"sort_order": "not a key"}).status_code == 422

    sign_in(client, PEER)
    seen = _get(client, workspace, newer["initiative_id"])
    assert seen["sort_order"] == older["sort_order"] + "V"
    assert seen["name"] == "Newer"


def test_an_update_snapshots_the_initiative_and_reports_what_changed_since_the_last(
    client: TestClient, workspace: str
) -> None:
    """The first update stores a snapshot with no report; the next diffs against it, as the feed reads it."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace, owner_id=MEMBER, target_date="2026-12-01")["initiative_id"]
    billing = seed_project(client, workspace, name="Billing", health="at_risk", status="planned")["project_id"]
    _add(client, workspace, initiative_id, billing)
    feed = f"{_base(workspace)}/{initiative_id}/updates"

    first = client.post(feed, json={"body": "Started", "health": "on_track"}).json()
    assert first["snapshot"]["owner_id"] == MEMBER
    assert first["snapshot"]["owner_name"] == "Mo Member"
    assert first["snapshot"]["status"] == "planned"
    assert first["snapshot"]["target_date"] == "2026-12-01"
    assert first["snapshot"]["health"] == "on_track"
    assert first["snapshot"]["project_count"] == 1
    assert first["snapshot"]["projects_by_status"] == {"planned": 1}
    assert first["snapshot"]["projects_by_health"] == {"at_risk": 1}
    assert first["previous_snapshot"] is None
    assert first["report"] == []

    docs = seed_project(client, workspace, team_id=OTHER_TEAM, name="Docs", status="planned")["project_id"]
    _add(client, workspace, initiative_id, docs)
    client.patch(f"/api/workspaces/{workspace}/projects/{billing}", json={"status": "in_progress"})
    client.patch(f"{_base(workspace)}/{initiative_id}", json={"status": "active", "owner_id": None})

    second = client.post(feed, json={"body": "Moving", "health": "at_risk"}).json()
    assert second["previous_snapshot"] == first["snapshot"]
    assert second["report"] == [
        "Status changed from Planned to Active",
        "Health changed from On track to At risk",
        "Owner removed",
        "Projects 1 to 2",
        "Projects in progress 0 to 1",
    ]

    listed = client.get(feed).json()["updates"]
    assert listed[0]["report"] == second["report"]
    assert listed[1]["report"] == []


def test_a_hidden_report_is_saved_and_toggles_without_marking_the_update_edited(
    client: TestClient, workspace: str
) -> None:
    """Hiding the report empties it for every reader and is a display choice, not an edit."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)["initiative_id"]
    feed = f"{_base(workspace)}/{initiative_id}/updates"
    client.post(feed, json={"body": "Started", "health": "on_track"})
    update = client.post(feed, json={"body": "Slipping", "health": "at_risk", "hide_details": True}).json()
    assert update["hide_details"] is True
    assert update["report"] == []

    response = client.patch(f"{feed}/{update['update_id']}", json={"hide_details": False})
    assert response.status_code == 200, response.text
    assert response.json()["hide_details"] is False
    assert response.json()["edited_at"] is None
    assert response.json()["report"] == ["Health changed from On track to At risk"]


def test_an_update_from_before_snapshots_reads_without_a_report(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A stored update with no snapshot reads back with none, and the next one has nothing to diff against."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)["initiative_id"]
    feed = f"{_base(workspace)}/{initiative_id}/updates"
    old = client.post(feed, json={"body": "Before", "health": "on_track"}).json()
    row = repositories.planning.get_initiative_update(WORKSPACE, initiative_id, old["update_id"])
    repositories.planning.replace_initiative_update(row.model_copy(update={"snapshot": None}))

    listed = client.get(feed).json()["updates"]
    assert listed[0]["snapshot"] is None
    assert listed[0]["report"] == []

    after = client.post(feed, json={"body": "After", "health": "at_risk"}).json()
    assert after["snapshot"] is not None
    assert after["previous_snapshot"] is None
    assert after["report"] == []


def test_the_snapshot_counts_only_projects_every_member_can_see(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A project on a private team stays out of the stored counts, so a reader outside it learns nothing."""
    add_team_member(repositories, WORKSPACE, OTHER_TEAM, MEMBER, "member")
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)["initiative_id"]
    _add(client, workspace, initiative_id, seed_project(client, workspace, name="Open")["project_id"])
    _add(
        client,
        workspace,
        initiative_id,
        seed_project(client, workspace, team_id=OTHER_TEAM, name="Secret", health="off_track")["project_id"],
    )
    repositories.memberships.set_team_private(WORKSPACE, OTHER_TEAM, True)

    sign_in(client, MEMBER)
    update = client.post(f"{_base(workspace)}/{initiative_id}/updates", json={"body": "Hi", "health": "on_track"})
    assert update.status_code == 201, update.text
    assert update.json()["snapshot"]["project_count"] == 1
    assert update.json()["snapshot"]["projects_by_health"] == {}


def test_editing_an_updates_health_refreshes_its_report(client: TestClient, workspace: str) -> None:
    """An update edited back to the health before it drops its health line; a new health reads in the line."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)["initiative_id"]
    feed = f"{_base(workspace)}/{initiative_id}/updates"
    client.post(feed, json={"body": "Slipping", "health": "at_risk"})
    second = client.post(feed, json={"body": "Stuck", "health": "off_track"}).json()
    assert second["report"] == ["Health changed from At risk to Off track"]

    back = client.patch(f"{feed}/{second['update_id']}", json={"health": "at_risk"}).json()
    assert back["snapshot"]["health"] == "at_risk"
    assert back["report"] == []

    onward = client.patch(f"{feed}/{second['update_id']}", json={"health": "on_track"}).json()
    assert onward["report"] == ["Health changed from At risk to On track"]
    assert client.get(feed).json()["updates"][0]["report"] == onward["report"]
    assert _get(client, workspace, initiative_id)["health"] == "on_track"


def test_editing_an_older_updates_health_refreshes_the_next_report(client: TestClient, workspace: str) -> None:
    """The next update diffs against the edited health, stays unedited, and the initiative keeps the newest health."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)["initiative_id"]
    feed = f"{_base(workspace)}/{initiative_id}/updates"
    first = client.post(feed, json={"body": "Fine", "health": "on_track"}).json()
    second = client.post(feed, json={"body": "Stuck", "health": "off_track"}).json()
    client.post(feed, json={"body": "Stuck still", "health": "off_track"})

    edited = client.patch(f"{feed}/{first['update_id']}", json={"health": "at_risk"})
    assert edited.status_code == 200, edited.text

    newest, middle, oldest = client.get(feed).json()["updates"]
    assert oldest["health"] == "at_risk"
    assert middle["update_id"] == second["update_id"]
    assert middle["report"] == ["Health changed from At risk to Off track"]
    assert middle["edited_at"] is None
    assert newest["report"] == []
    assert _get(client, workspace, initiative_id)["health"] == "off_track"


def test_a_post_names_the_other_updates_of_the_last_few_minutes(client: TestClient, workspace: str) -> None:
    """A create answers with the updates around it, and a read of the feed names none."""
    sign_in(client, MEMBER)
    initiative_id = _create(client, workspace)["initiative_id"]
    feed = f"{_base(workspace)}/{initiative_id}/updates"

    first = client.post(feed, json={"body": "Fine", "health": "on_track"}).json()
    assert first["recent_updates"] == []
    second = client.post(feed, json={"body": "Stuck", "health": "off_track"}).json()

    assert [other["update_id"] for other in second["recent_updates"]] == [first["update_id"]]
    assert second["recent_updates"][0]["author_name"] == "Mo Member"
    assert all(row["recent_updates"] == [] for row in client.get(feed).json()["updates"])
