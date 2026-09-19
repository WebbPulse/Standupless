"""Milestone routes: CRUD, the stored status, and the undated ordering.

A milestone's status is stored rather than derived, because its one date is a
target and a target says nothing about whether work began. The ordering property
worth holding is that an undated milestone sorts last rather than first, since an
empty string would otherwise beat every real date.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, GUEST, MEMBER, OUTSIDER, OWNER, sign_in
from tests.domains.planning.conftest import OTHER_PROJECT, PROJECT, seed_milestone


def test_a_milestone_is_created_planned_with_empty_counts(client: TestClient, workspace: str) -> None:
    """A new milestone is planned until somebody says otherwise."""
    sign_in(client, MEMBER)

    body = seed_milestone(client, workspace, name="Launch", description="The first release")

    assert body["name"] == "Launch"
    assert body["description"] == "The first release"
    assert body["status"] == "planned"
    assert body["target_date"] is None
    assert body["counts"] == {"todo": 0, "in_progress": 0, "done": 0, "cancelled": 0, "total": 0}


def test_the_status_is_stored_rather_than_derived(client: TestClient, workspace: str) -> None:
    """A target date cannot say whether work began, so the status is written."""
    sign_in(client, MEMBER)
    milestone = seed_milestone(client, workspace, target_date="2999-01-01")

    response = client.patch(
        f"/api/workspaces/{workspace}/milestones/{milestone['milestone_id']}",
        json={"project_id": PROJECT, "status": "in_progress"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "in_progress"
    assert body["target_date"] == "2999-01-01"


def test_milestones_list_by_target_date_with_undated_last(client: TestClient, workspace: str) -> None:
    """An absent target is a thing nobody committed to, so it does not lead the list."""
    sign_in(client, MEMBER)
    seed_milestone(client, workspace, name="Undated")
    seed_milestone(client, workspace, name="Later", target_date="2026-06-01")
    seed_milestone(client, workspace, name="Sooner", target_date="2026-02-01")

    response = client.get(f"/api/workspaces/{workspace}/milestones", params={"project_id": PROJECT})

    assert response.status_code == 200
    assert [row["name"] for row in response.json()["milestones"]] == ["Sooner", "Later", "Undated"]


def test_the_status_filter_narrows_the_listing(client: TestClient, workspace: str) -> None:
    """Status is stored, so a filter is an equality on what the row holds."""
    sign_in(client, MEMBER)
    seed_milestone(client, workspace, name="Planned one")
    seed_milestone(client, workspace, name="Finished", status="done")

    response = client.get(
        f"/api/workspaces/{workspace}/milestones",
        params={"project_id": PROJECT, "status": "done"},
    )

    assert [row["name"] for row in response.json()["milestones"]] == ["Finished"]


def test_clearing_the_target_date_removes_it(client: TestClient, workspace: str) -> None:
    """A null target has to remove the attribute, so the row leaves the sparse index."""
    sign_in(client, MEMBER)
    milestone = seed_milestone(client, workspace, target_date="2026-02-01")

    response = client.patch(
        f"/api/workspaces/{workspace}/milestones/{milestone['milestone_id']}",
        json={"project_id": PROJECT, "target_date": None},
    )

    assert response.status_code == 200
    assert response.json()["target_date"] is None

    roadmap = client.get(f"/api/workspaces/{workspace}/roadmap")
    entries = roadmap.json()["entries"]
    assert [entry["target_date"] for entry in entries] == [None]


def test_a_milestone_of_another_project_is_not_found(client: TestClient, workspace: str) -> None:
    """A guessed project does not reach another project's row."""
    sign_in(client, MEMBER)
    milestone = seed_milestone(client, workspace)

    response = client.get(
        f"/api/workspaces/{workspace}/milestones/{milestone['milestone_id']}",
        params={"project_id": OTHER_PROJECT},
    )

    assert response.status_code == 404


def test_deleting_a_milestone_is_a_project_admin_call(client: TestClient, workspace: str) -> None:
    """A delete detaches every issue pointing at it, so a member cannot make it."""
    sign_in(client, MEMBER)
    milestone = seed_milestone(client, workspace)

    refused = client.delete(
        f"/api/workspaces/{workspace}/milestones/{milestone['milestone_id']}",
        params={"project_id": PROJECT},
    )
    assert refused.status_code == 403

    sign_in(client, OWNER)
    allowed = client.delete(
        f"/api/workspaces/{workspace}/milestones/{milestone['milestone_id']}",
        params={"project_id": PROJECT},
    )
    assert allowed.status_code == 204


def test_a_guest_outside_the_project_gets_a_404_not_a_403(client: TestClient, workspace: str) -> None:
    """Invisible and absent look identical on every verb."""
    sign_in(client, GUEST)

    listed = client.get(f"/api/workspaces/{workspace}/milestones", params={"project_id": OTHER_PROJECT})
    created = client.post(
        f"/api/workspaces/{workspace}/milestones",
        json={"project_id": OTHER_PROJECT, "name": "Sneaky"},
    )

    assert listed.status_code == 404
    assert created.status_code == 404


def test_a_non_member_of_the_workspace_gets_a_404(client: TestClient, workspace: str) -> None:
    """The workspace itself is unenumerable to somebody outside it."""
    sign_in(client, OUTSIDER)

    response = client.get(f"/api/workspaces/{workspace}/milestones", params={"project_id": PROJECT})

    assert response.status_code == 404


def test_a_blank_name_is_refused(client: TestClient, workspace: str) -> None:
    """Whitespace is not a name, and the schema can say so without a table read."""
    sign_in(client, MEMBER)

    response = client.post(
        f"/api/workspaces/{workspace}/milestones",
        json={"project_id": PROJECT, "name": "   "},
    )

    assert response.status_code == 422


def test_a_malformed_target_date_is_refused(client: TestClient, workspace: str) -> None:
    """The contract fixes the format, so anything else is a 422 naming the field."""
    sign_in(client, MEMBER)

    response = client.post(
        f"/api/workspaces/{workspace}/milestones",
        json={"project_id": PROJECT, "name": "Launch", "target_date": "next tuesday"},
    )

    assert response.status_code == 422


def test_an_admin_may_write_in_a_project_they_are_not_a_member_of(client: TestClient, workspace: str) -> None:
    """A workspace admin has an implied project role, so no explicit membership is needed."""
    sign_in(client, ADMIN)

    response = client.post(
        f"/api/workspaces/{workspace}/milestones",
        json={"project_id": OTHER_PROJECT, "name": "Admin milestone"},
    )

    assert response.status_code == 201
