"""Writes to an area an admin turned off are refused, reads stay open, and nothing is lost.

Each area is checked through its own REST routes: the write answers 403 with
FEATURE_DISABLED while the area is off, the rows written before stay readable,
and turning the area back on restores writes over the same rows. A stranger
still gets the 404 rather than learning which areas are on.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.workspace_features import FEATURE_DISABLED
from tests.domains.helpers import ADMIN, OUTSIDER, sign_in
from tests.domains.planning.conftest import TEAM, seed_project


def _base(workspace: str) -> str:
    """The workspace's API root."""
    return f"/api/workspaces/{workspace}"


def _turn(repositories: Any, workspace: str, feature: str, on: bool) -> None:
    """Turn one area on or off the way the settings page does, keeping the others."""
    current = repositories.workspaces.get(workspace).features
    repositories.workspaces.set_features(workspace, {**current, feature: on})


def _assert_refused(response: Any, feature: str) -> None:
    """The write was refused for the area, not for the caller."""
    assert response.status_code == 403, response.text
    body = response.json()
    assert body["error_code"] == FEATURE_DISABLED
    assert body["details"] == {"feature": feature}


@pytest.fixture
def teams_client(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application, which serves releases."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["teams"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


def test_every_area_takes_writes_by_default(client: TestClient, workspace: str) -> None:
    """With no flag stored, initiatives, customers, documents and Pulse all write."""
    sign_in(client, ADMIN)
    base = _base(workspace)

    assert client.post(f"{base}/initiatives", json={"name": "Grow"}).status_code == 201
    assert client.post(f"{base}/customers", json={"name": "Acme"}).status_code == 201
    project_id = seed_project(client, workspace)["project_id"]
    assert (
        client.post(f"{base}/projects/{project_id}/documents", json={"title": "Plan", "body": "Ship"}).status_code
        == 201
    )
    assert client.post(f"{base}/pulse/read").status_code == 200


def test_customers_off_refuses_writes_and_keeps_reads(client: TestClient, workspace: str, repositories: Any) -> None:
    """A customer written before stays listed and readable, and comes back writable."""
    sign_in(client, ADMIN)
    base = _base(workspace)
    customer_id = client.post(f"{base}/customers", json={"name": "Acme"}).json()["customer_id"]
    project_id = seed_project(client, workspace)["project_id"]
    _turn(repositories, workspace, "customers", False)

    _assert_refused(client.post(f"{base}/customers", json={"name": "Globex"}), "customers")
    _assert_refused(client.patch(f"{base}/customers/{customer_id}", json={"name": "Acme Inc"}), "customers")
    _assert_refused(
        client.post(f"{base}/projects/{project_id}/customer-requests", json={"customer_id": customer_id, "body": ""}),
        "customers",
    )
    listed = client.get(f"{base}/customers")
    assert listed.status_code == 200
    assert [row["name"] for row in listed.json()["customers"]] == ["Acme"]
    assert client.get(f"{base}/customers/{customer_id}").status_code == 200

    _turn(repositories, workspace, "customers", True)
    renamed = client.patch(f"{base}/customers/{customer_id}", json={"name": "Acme Inc"})
    assert renamed.status_code == 200, renamed.text


def test_initiatives_off_refuses_writes_and_project_links(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Creating, editing and linking a project to an initiative are refused, and the initiative stays readable."""
    sign_in(client, ADMIN)
    base = _base(workspace)
    initiative_id = client.post(f"{base}/initiatives", json={"name": "Grow"}).json()["initiative_id"]
    project_id = seed_project(client, workspace)["project_id"]
    _turn(repositories, workspace, "initiatives", False)

    _assert_refused(client.post(f"{base}/initiatives", json={"name": "Shrink"}), "initiatives")
    _assert_refused(client.patch(f"{base}/initiatives/{initiative_id}", json={"name": "Grow more"}), "initiatives")
    _assert_refused(client.put(f"{base}/initiatives/{initiative_id}/projects/{project_id}"), "initiatives")
    _assert_refused(
        client.post(f"{base}/projects", json={"team_id": TEAM, "name": "Linked", "initiative_id": initiative_id}),
        "initiatives",
    )
    _assert_refused(client.patch(f"{base}/projects/{project_id}", json={"initiative_id": initiative_id}), "initiatives")
    assert client.patch(f"{base}/projects/{project_id}", json={"name": "Renamed"}).status_code == 200
    assert client.get(f"{base}/initiatives/{initiative_id}").json()["name"] == "Grow"

    _turn(repositories, workspace, "initiatives", True)
    assert client.put(f"{base}/initiatives/{initiative_id}/projects/{project_id}").status_code == 200


def test_documents_off_refuses_writes_and_keeps_reads(client: TestClient, workspace: str, repositories: Any) -> None:
    """A document written before reads as it was, and its edits are refused until documents are back."""
    sign_in(client, ADMIN)
    base = _base(workspace)
    project_id = seed_project(client, workspace)["project_id"]
    created = client.post(f"{base}/projects/{project_id}/documents", json={"title": "Plan", "body": "Ship"})
    document_id = created.json()["document_id"]
    _turn(repositories, workspace, "documents", False)

    _assert_refused(
        client.post(f"{base}/projects/{project_id}/documents", json={"title": "Two", "body": ""}), "documents"
    )
    _assert_refused(client.patch(f"{base}/documents/{document_id}", json={"title": "Plan B"}), "documents")
    _assert_refused(client.delete(f"{base}/documents/{document_id}"), "documents")
    read = client.get(f"{base}/documents/{document_id}")
    assert read.status_code == 200
    assert read.json()["title"] == "Plan"

    _turn(repositories, workspace, "documents", True)
    assert client.patch(f"{base}/documents/{document_id}", json={"title": "Plan B"}).status_code == 200


def test_pulse_off_refuses_marking_read_and_following(client: TestClient, workspace: str, repositories: Any) -> None:
    """Marking Pulse read and following are refused, and the feed itself still reads."""
    sign_in(client, ADMIN)
    base = _base(workspace)
    project_id = seed_project(client, workspace)["project_id"]
    _turn(repositories, workspace, "pulse", False)

    _assert_refused(client.post(f"{base}/pulse/read"), "pulse")
    _assert_refused(client.put(f"{base}/projects/{project_id}/follow"), "pulse")
    assert client.get(f"{base}/pulse").status_code == 200

    _turn(repositories, workspace, "pulse", True)
    assert client.put(f"{base}/projects/{project_id}/follow").status_code in (200, 204)


def test_releases_off_refuses_writes_and_keeps_reads(
    teams_client: TestClient, workspace: str, repositories: Any
) -> None:
    """A release recorded before stays listed, and recording another is refused until releases are back."""
    sign_in(teams_client, ADMIN)
    releases = f"{_base(workspace)}/teams/{TEAM}/releases"
    created = teams_client.post(releases, json={"name": "1.0"})
    assert created.status_code == 201, created.text
    _turn(repositories, workspace, "releases", False)

    _assert_refused(teams_client.post(releases, json={"name": "1.1"}), "releases")
    _assert_refused(
        teams_client.patch(f"{releases}/{created.json()['release_id']}", json={"name": "1.0.1"}), "releases"
    )
    listed = teams_client.get(releases)
    assert listed.status_code == 200
    assert [row["name"] for row in listed.json()["releases"]] == ["1.0"]

    _turn(repositories, workspace, "releases", True)
    assert teams_client.post(releases, json={"name": "1.1"}).status_code == 201


def test_a_stranger_still_gets_not_found(client: TestClient, workspace: str, repositories: Any) -> None:
    """The membership check runs first, so a turned off area tells an outsider nothing."""
    _turn(repositories, workspace, "customers", False)
    sign_in(client, OUTSIDER)

    assert client.post(f"{_base(workspace)}/customers", json={"name": "Acme"}).status_code == 404
