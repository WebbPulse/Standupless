"""A parent team's settings refusals keep a private sub-team private.

A parent's statuses and labels reach every sub-team, a private one included, so
deleting or hiding a status and naming a label are still checked against it. A
parent admin outside the private sub-team is told only that a sub-team they cannot
see is in the way: never its name, its id, its label ids or how many issues it
holds. A parent admin who is also on the sub-team gets the full refusal.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common import team_writes
from app.common.api.schemas.teams import LabelCreate
from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.issues import Issue
from app.common.labels import create_label
from tests.domains.helpers import OWNER, add_member, add_team_member, make_team, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

PARENT = "01JB000000000000000000PRJ1"

VAULT = "01JB000000000000000000PRJ2"

VAULT_NAME = "Vaultkeepers"

PARENT_ADMIN = "01JB00000000000000000PADMN"

INSIDER = "01JB00000000000000000INSDR"

BASE = f"/api/workspaces/{WORKSPACE}"

UNSEEN = "a sub-team you cannot see"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["teams"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A parent team with a private sub-team, a parent admin outside it and an insider admin of both."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    repositories.workspaces.set_billing(WORKSPACE, plan="business")
    add_member(repositories, WORKSPACE, PARENT_ADMIN, "member")
    add_member(repositories, WORKSPACE, INSIDER, "member")
    make_team(repositories, WORKSPACE, PARENT, "APO")
    make_team(repositories, WORKSPACE, VAULT, "VLT")
    repositories.teams.update(WORKSPACE, VAULT, name=VAULT_NAME)
    team_writes.set_parent(repositories, WORKSPACE, VAULT, PARENT)
    add_team_member(repositories, WORKSPACE, PARENT, PARENT_ADMIN, "admin")
    add_team_member(repositories, WORKSPACE, PARENT, INSIDER, "admin")
    add_team_member(repositories, WORKSPACE, VAULT, INSIDER, "admin")
    repositories.memberships.set_team_private(WORKSPACE, VAULT, True)
    return WORKSPACE


def _vault_issue(repositories: Any, status_id: str) -> Issue:
    """Put one issue in the private sub-team, in `status_id`."""
    return repositories.issues.create(
        Issue(
            workspace_id=WORKSPACE,
            team_id=VAULT,
            key="VLT-1",
            number=1,
            title="Rotate the vault keys",
            status_id=status_id,
            created_by=INSIDER,
        )
    )


def _parent_status(client: TestClient, name: str) -> str:
    """Create one of the parent's own started statuses as the parent admin and return its id."""
    sign_in(client, PARENT_ADMIN)
    response = client.post(f"{BASE}/teams/{PARENT}/statuses", json={"name": name, "category": "started"})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _assert_anonymous(response: Any) -> None:
    """A 409 that says a hidden sub-team is in the way and gives away nothing else about it."""
    assert response.status_code == 409, response.text
    assert UNSEEN in response.text
    assert VAULT not in response.text
    assert VAULT_NAME not in response.text
    assert response.json()["details"]["hidden_teams"] is True


def test_deleting_a_parent_status_does_not_count_a_private_sub_teams_issues(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """The refusal neither names nor counts the sub-team, and a replacement still moves its issue."""
    review = _parent_status(client, "Review")
    keep = _parent_status(client, "Building")
    issue = _vault_issue(repositories, review)

    refused = client.delete(f"{BASE}/teams/{PARENT}/statuses/{review}")
    _assert_anonymous(refused)
    details = refused.json()["details"]
    assert details["issue_count"] == 0
    assert details["teams"] == []

    moved = client.delete(f"{BASE}/teams/{PARENT}/statuses/{review}", params={"replacement_status_id": keep})
    assert moved.status_code == 204, moved.text
    assert repositories.issues.get(WORKSPACE, issue.issue_id).status_id == keep


def test_an_insider_parent_admin_gets_the_full_refusal(client: TestClient, workspace: str, repositories: Any) -> None:
    """A parent admin on the private sub-team is told its name and count as before."""
    review = _parent_status(client, "Review")
    _vault_issue(repositories, review)

    sign_in(client, INSIDER)
    refused = client.delete(f"{BASE}/teams/{PARENT}/statuses/{review}")
    assert refused.status_code == 409
    details = refused.json()["details"]
    assert details["issue_count"] == 1
    assert details["teams"] == [{"team_id": VAULT, "team_name": VAULT_NAME, "issue_count": 1}]
    assert "hidden_teams" not in details


def test_hiding_a_status_does_not_count_a_private_sub_teams_issues(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Hiding an inherited workspace status the sub-team's issue sits in is refused anonymously."""
    sign_in(client, OWNER)
    created = client.post(f"{BASE}/statuses", json={"name": "Queued", "category": "started"})
    assert created.status_code == 201, created.text
    queued = created.json()["id"]
    _vault_issue(repositories, queued)

    sign_in(client, PARENT_ADMIN)
    refused = client.patch(f"{BASE}/teams/{PARENT}/statuses/{queued}/override", json={"hidden": True})
    _assert_anonymous(refused)


def test_a_label_name_clash_in_a_private_sub_team_stays_anonymous(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """A parent label named like a private sub-team's label is refused without the team or the label id."""
    secret = create_label(repositories, WORKSPACE, VAULT, LabelCreate(name="Payroll", color="#eb5757"))

    sign_in(client, PARENT_ADMIN)
    refused = client.post(f"{BASE}/teams/{PARENT}/labels", json={"name": "payroll", "color": "#5e6ad2"})
    _assert_anonymous(refused)
    assert secret.label_id not in refused.text

    sign_in(client, INSIDER)
    named = client.post(f"{BASE}/teams/{PARENT}/labels", json={"name": "payroll", "color": "#5e6ad2"})
    assert named.status_code == 409
    assert VAULT_NAME in named.text
