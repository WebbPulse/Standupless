"""Cycle routes: CRUD, the derived status, and who may reach each verb.

The properties worth holding are that status comes from the dates rather than from
anything stored, that a cycle is reached only with the project it is filed under,
and that a caller outside the project gets a 404 rather than an empty answer.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, GUEST, MEMBER, OUTSIDER, OWNER, sign_in
from tests.domains.planning.conftest import OTHER_PROJECT, PROJECT, seed_cycle


def test_a_cycle_is_created_with_its_counts_at_zero(client: TestClient, workspace: str) -> None:
    """Nothing but the rollup consumer writes counts, so a new cycle starts empty."""
    sign_in(client, MEMBER)

    body = seed_cycle(client, workspace, name="Sprint one", goal="Ship the board")

    assert body["name"] == "Sprint one"
    assert body["goal"] == "Ship the board"
    assert body["project_id"] == PROJECT
    assert body["cancelled"] is False
    assert body["counts"] == {"todo": 0, "in_progress": 0, "done": 0, "cancelled": 0, "total": 0}


def test_the_status_is_derived_from_the_dates(client: TestClient, workspace: str) -> None:
    """A cycle in the past reads completed and one in the future reads upcoming.

    Nothing wrote the status, which is the point: the row carries only the dates.
    """
    sign_in(client, MEMBER)

    past = seed_cycle(client, workspace, start_date="2020-01-01", end_date="2020-01-14")
    future = seed_cycle(client, workspace, start_date="2999-01-01", end_date="2999-01-14")

    assert past["status"] == "completed"
    assert future["status"] == "upcoming"


def test_cancelling_a_cycle_overrides_its_dates(client: TestClient, workspace: str) -> None:
    """The flag is the one thing a write can say about status, and it wins."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace, start_date="2020-01-01", end_date="2999-01-14")
    assert cycle["status"] == "active"

    response = client.patch(
        f"/api/workspaces/{workspace}/cycles/{cycle['cycle_id']}",
        json={"project_id": PROJECT, "cancelled": True},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "cancelled"


def test_cycles_list_by_start_date_ascending(client: TestClient, workspace: str) -> None:
    """The listing is chronological, not creation ordered."""
    sign_in(client, MEMBER)
    seed_cycle(client, workspace, name="Third", start_date="2026-03-01", end_date="2026-03-14")
    seed_cycle(client, workspace, name="First", start_date="2026-01-01", end_date="2026-01-14")
    seed_cycle(client, workspace, name="Second", start_date="2026-02-01", end_date="2026-02-14")

    response = client.get(f"/api/workspaces/{workspace}/cycles", params={"project_id": PROJECT})

    assert response.status_code == 200
    assert [row["name"] for row in response.json()["cycles"]] == ["First", "Second", "Third"]


def test_the_status_filter_narrows_the_listing(client: TestClient, workspace: str) -> None:
    """Status is derived, so the filter runs after the read rather than on an index."""
    sign_in(client, MEMBER)
    seed_cycle(client, workspace, name="Done", start_date="2020-01-01", end_date="2020-01-14")
    seed_cycle(client, workspace, name="Later", start_date="2999-01-01", end_date="2999-01-14")

    response = client.get(
        f"/api/workspaces/{workspace}/cycles",
        params={"project_id": PROJECT, "status": "upcoming"},
    )

    assert [row["name"] for row in response.json()["cycles"]] == ["Later"]


def test_a_cycle_is_read_back_by_its_id_and_project(client: TestClient, workspace: str) -> None:
    """The project is part of the key, so it travels on the read."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace)

    response = client.get(
        f"/api/workspaces/{workspace}/cycles/{cycle['cycle_id']}",
        params={"project_id": PROJECT},
    )

    assert response.status_code == 200
    assert response.json()["cycle_id"] == cycle["cycle_id"]


def test_a_cycle_of_another_project_is_not_found(client: TestClient, workspace: str) -> None:
    """A guessed project does not reach another project's row."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace)

    response = client.get(
        f"/api/workspaces/{workspace}/cycles/{cycle['cycle_id']}",
        params={"project_id": OTHER_PROJECT},
    )

    assert response.status_code == 404


def test_a_patch_moves_the_name_and_the_dates(client: TestClient, workspace: str) -> None:
    """A patch writes the row whole, so the counters ride along untouched."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace)

    response = client.patch(
        f"/api/workspaces/{workspace}/cycles/{cycle['cycle_id']}",
        json={"project_id": PROJECT, "name": "Renamed", "end_date": "2026-01-21"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "Renamed"
    assert body["end_date"] == "2026-01-21"
    assert body["start_date"] == "2026-01-01"
    assert body["counts"]["total"] == 0


def test_a_patch_refuses_an_end_date_before_the_start(client: TestClient, workspace: str) -> None:
    """Either date can move alone, so only the merged pair says whether it is coherent."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace)

    response = client.patch(
        f"/api/workspaces/{workspace}/cycles/{cycle['cycle_id']}",
        json={"project_id": PROJECT, "end_date": "2025-12-01"},
    )

    assert response.status_code == 422


def test_a_create_refuses_an_end_date_before_the_start(client: TestClient, workspace: str) -> None:
    """The create schema can judge the pair on its own, so it does."""
    sign_in(client, MEMBER)

    response = client.post(
        f"/api/workspaces/{workspace}/cycles",
        json={
            "project_id": PROJECT,
            "name": "Backwards",
            "start_date": "2026-02-01",
            "end_date": "2026-01-01",
        },
    )

    assert response.status_code == 422


def test_deleting_a_cycle_is_a_project_admin_call(client: TestClient, workspace: str) -> None:
    """A delete detaches every issue pointing at the cycle, so a member cannot make it."""
    sign_in(client, MEMBER)
    cycle = seed_cycle(client, workspace)

    refused = client.delete(
        f"/api/workspaces/{workspace}/cycles/{cycle['cycle_id']}",
        params={"project_id": PROJECT},
    )
    assert refused.status_code == 403

    sign_in(client, ADMIN)
    allowed = client.delete(
        f"/api/workspaces/{workspace}/cycles/{cycle['cycle_id']}",
        params={"project_id": PROJECT},
    )
    assert allowed.status_code == 204

    sign_in(client, OWNER)
    gone = client.get(
        f"/api/workspaces/{workspace}/cycles/{cycle['cycle_id']}",
        params={"project_id": PROJECT},
    )
    assert gone.status_code == 404


def test_a_guest_outside_the_project_gets_a_404_not_a_403(client: TestClient, workspace: str) -> None:
    """Invisible and absent look identical, so the project set stays unenumerable."""
    sign_in(client, GUEST)

    listed = client.get(f"/api/workspaces/{workspace}/cycles", params={"project_id": OTHER_PROJECT})
    created = client.post(
        f"/api/workspaces/{workspace}/cycles",
        json={
            "project_id": OTHER_PROJECT,
            "name": "Sneaky",
            "start_date": "2026-01-01",
            "end_date": "2026-01-14",
        },
    )

    assert listed.status_code == 404
    assert created.status_code == 404


def test_a_non_member_of_the_workspace_gets_a_404(client: TestClient, workspace: str) -> None:
    """The workspace itself is unenumerable to somebody who is outside it."""
    sign_in(client, OUTSIDER)

    response = client.get(f"/api/workspaces/{workspace}/cycles", params={"project_id": PROJECT})

    assert response.status_code == 404


def test_a_guest_inside_the_project_may_read_and_write(client: TestClient, workspace: str) -> None:
    """A guest holds an explicit membership on PROJECT, which is a project role."""
    sign_in(client, GUEST)

    created = client.post(
        f"/api/workspaces/{workspace}/cycles",
        json={
            "project_id": PROJECT,
            "name": "Guest cycle",
            "start_date": "2026-01-01",
            "end_date": "2026-01-14",
        },
    )

    assert created.status_code == 201
