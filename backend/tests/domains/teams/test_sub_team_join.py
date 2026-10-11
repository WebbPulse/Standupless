"""A team joining a parent folds its duplicates into the parent's workflow, and a sub-team may show what its parent hides.

A team with its own copies of the parent's statuses would show each twice, so
they fold into the parent's and their issues move with them. A plain label
sharing a name with one of the parent's folds the same way, while a clash that
cannot fold refuses the join before anything changes. A workspace status the
parent hides can be shown again in one sub-team only.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.issues import Issue
from tests.domains.helpers import OWNER, make_team, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

PARENT = "01JB000000000000000000PRJ1"

LONER = "01JB000000000000000000PRJ2"

SIBLING = "01JB000000000000000000PRJ3"

BASE = f"/api/workspaces/{WORKSPACE}"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application signed in as the owner, with three top-level teams."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["teams"])
    bind_repositories(app, repositories)
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    make_team(repositories, WORKSPACE, PARENT, "APO")
    make_team(repositories, WORKSPACE, LONER, "GEM")
    make_team(repositories, WORKSPACE, SIBLING, "SIB")
    with TestClient(app) as test_client:
        sign_in(test_client, OWNER)
        yield test_client


def _statuses(client: TestClient, team_id: str, **params: Any) -> list[dict[str, Any]]:
    """A team's effective statuses."""
    response = client.get(f"{BASE}/teams/{team_id}/statuses", params=params)
    assert response.status_code == 200, response.text
    return response.json()["statuses"]


def _labels(client: TestClient, team_id: str) -> list[dict[str, Any]]:
    """A team's effective labels, hidden ones included."""
    response = client.get(f"{BASE}/teams/{team_id}/labels", params={"include_hidden": True})
    assert response.status_code == 200, response.text
    return response.json()["labels"]


def _status_id(client: TestClient, team_id: str, name: str) -> str:
    """The id of a team's own status by name."""
    return next(row["id"] for row in _statuses(client, team_id) if row["name"] == name and row["scope"] == "team")


def _label(client: TestClient, team_id: str, name: str, **extra: Any) -> dict[str, Any]:
    """Create a team label and return it."""
    response = client.post(f"{BASE}/teams/{team_id}/labels", json={"name": name, "color": "#eb5757", **extra})
    assert response.status_code == 201, response.text
    return response.json()


def _issue(repositories: Any, status_id: str, label_ids: list[str]) -> Issue:
    """Put one issue of the joining team in, as the issues domain would have stored it."""
    return repositories.issues.create(
        Issue(
            workspace_id=WORKSPACE,
            team_id=LONER,
            key="GEM-1",
            number=1,
            title="Issue 1",
            status_id=status_id,
            label_ids=label_ids,
            created_by=OWNER,
        )
    )


def _join(client: TestClient, team_id: str = LONER) -> Any:
    """Put a team under the parent."""
    return client.patch(f"{BASE}/teams/{team_id}", json={"parent_team_id": PARENT})


def test_joining_folds_duplicate_statuses_into_the_parents(client: TestClient, repositories: Any) -> None:
    """The team's own copies of the parent's statuses go, and its issues and auto-close status follow them."""
    own_todo = _status_id(client, LONER, "Todo")
    own_cancelled = _status_id(client, LONER, "Cancelled")
    review = client.post(f"{BASE}/teams/{LONER}/statuses", json={"name": "Review", "category": "started"})
    assert review.status_code == 201, review.text
    settings = client.patch(
        f"{BASE}/teams/{LONER}/auto-close-settings", json={"period_months": 3, "status_id": own_cancelled}
    )
    assert settings.status_code == 200, settings.text
    issue = _issue(repositories, own_todo, [])

    assert _join(client).status_code == 200

    rows = _statuses(client, LONER)
    assert [row["name"] for row in rows if row["scope"] == "team"] == ["Review"]
    parent_todo = _status_id(client, PARENT, "Todo")
    assert repositories.issues.get(WORKSPACE, issue.issue_id).status_id == parent_todo
    assert repositories.team_config.get_auto_close_settings(WORKSPACE, LONER).status_id == _status_id(
        client, PARENT, "Cancelled"
    )


def test_joining_folds_a_plain_label_into_the_parents(client: TestClient, repositories: Any) -> None:
    """A top-level label named like one of the parent's comes off its issues in favour of the parent's."""
    mine = _label(client, LONER, "Bug")
    keep = _label(client, LONER, "Infra")
    theirs = _label(client, PARENT, "bug")
    issue = _issue(repositories, _status_id(client, LONER, "Todo"), [mine["id"], keep["id"]])

    assert _join(client).status_code == 200

    names = {(row["name"], row["scope"]) for row in _labels(client, LONER)}
    assert names == {("bug", "parent"), ("Infra", "team")}
    assert repositories.issues.get(WORKSPACE, issue.issue_id).label_ids == [theirs["id"], keep["id"]]


def test_a_clashing_label_group_refuses_the_join(client: TestClient) -> None:
    """Two groups of one name cannot fold, so the join is a 409 naming the team's label and nothing moves."""
    _label(client, LONER, "Area", is_group=True)
    _label(client, PARENT, "Area", is_group=True)
    before = _statuses(client, LONER)

    response = _join(client)

    assert response.status_code == 409, response.text
    assert response.json()["details"]["names"] == ["Area"]
    assert client.get(f"{BASE}/teams/{LONER}").json()["parent_team_id"] is None
    assert _statuses(client, LONER) == before


def test_a_label_clash_with_a_sibling_sub_team_refuses_the_join(client: TestClient) -> None:
    """A label one of the parent's other sub-teams owns cannot fold, so the join is a 409."""
    assert _join(client, SIBLING).status_code == 200
    _label(client, SIBLING, "Infra")
    _label(client, LONER, "infra")

    response = _join(client)

    assert response.status_code == 409, response.text
    assert response.json()["details"]["names"] == ["infra"]


def test_a_sub_team_shows_a_workspace_status_its_parent_hides(client: TestClient) -> None:
    """Showing it in the sub-team overrules the parent's hide there only, and a reset brings the hide back."""
    created = client.post(f"{BASE}/statuses", json={"name": "Review", "category": "started", "color": "blue"})
    assert created.status_code == 201, created.text
    status_id = created.json()["id"]
    assert _join(client).status_code == 200
    hidden = client.patch(f"{BASE}/teams/{PARENT}/statuses/{status_id}/override", json={"hidden": True})
    assert hidden.status_code == 200, hidden.text
    assert status_id not in {row["id"] for row in _statuses(client, LONER)}

    shown = client.patch(f"{BASE}/teams/{LONER}/statuses/{status_id}/override", json={"hidden": False})

    assert shown.status_code == 200, shown.text
    assert shown.json()["hidden"] is False
    assert status_id in {row["id"] for row in _statuses(client, LONER)}
    assert status_id not in {row["id"] for row in _statuses(client, PARENT)}
    assert client.delete(f"{BASE}/teams/{LONER}/statuses/{status_id}/override").status_code == 200
    assert status_id not in {row["id"] for row in _statuses(client, LONER)}
