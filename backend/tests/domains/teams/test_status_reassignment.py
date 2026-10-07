"""Statuses with issues in them and labels on issues, as Linear treats them.

A status delete names where its issues go, archived ones included, and each move
lands in the issue's history. A hide waits until the column has no live issues.
A label delete takes the label off every issue carrying it. These run against
the teams application alone, so they also prove its grants reach the issues and
activity tables.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from tests.domains.helpers import OWNER, make_team, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

OTHER = "01JB000000000000000000PRJ2"

BASE = f"/api/workspaces/{WORKSPACE}"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application signed in as the owner, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["teams"])
    bind_repositories(app, repositories)
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    make_team(repositories, WORKSPACE, TEAM, "APO")
    make_team(repositories, WORKSPACE, OTHER, "GEM")
    with TestClient(app) as test_client:
        sign_in(test_client, OWNER)
        yield test_client


def _status_id(client: TestClient, team_id: str, name: str) -> str:
    """The id of one of a team's statuses by name, hidden ones included."""
    rows = client.get(f"{BASE}/teams/{team_id}/statuses", params={"include_hidden": True}).json()["statuses"]
    return next(row["id"] for row in rows if row["name"] == name)


def _issue(
    repositories: Any,
    team_id: str,
    number: int,
    status_id: str,
    *,
    label_ids: list[str] | None = None,
    archived: bool = False,
) -> Issue:
    """Put one issue in, archived when asked, as the issues domain would have stored it."""
    created = repositories.issues.create(
        Issue(
            workspace_id=WORKSPACE,
            team_id=team_id,
            key=f"{team_id[-1]}-{number}",
            number=number,
            title=f"Issue {number}",
            status_id=status_id,
            label_ids=label_ids or [],
            created_by=OWNER,
        )
    )
    if archived:
        return repositories.issues.archive(created, utc_now())
    return created


def _reread(repositories: Any, issue: Issue) -> Issue:
    """The stored row of an issue."""
    return repositories.issues.get(WORKSPACE, issue.issue_id)


def _workspace_status(client: TestClient, name: str, category: str = "started") -> str:
    """Create a workspace status and return its id."""
    response = client.post(f"{BASE}/statuses", json={"name": name, "category": category})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def test_a_status_with_issues_needs_a_replacement(client: TestClient, repositories: Any) -> None:
    """The delete is a 409 counting every issue in it, archived ones too, and nothing is deleted."""
    review = client.post(f"{BASE}/teams/{TEAM}/statuses", json={"name": "Review", "category": "started"}).json()
    _issue(repositories, TEAM, 1, review["id"])
    _issue(repositories, TEAM, 2, review["id"], archived=True)

    response = client.delete(f"{BASE}/teams/{TEAM}/statuses/{review['id']}")

    assert response.status_code == 409
    body = response.json()
    assert body["message"] == "2 issues are in this status. Choose a status to move them to."
    assert body["details"]["issue_count"] == 2
    assert body["details"]["teams"] == [{"team_id": TEAM, "team_name": "Apo", "issue_count": 2}]
    assert _status_id(client, TEAM, "Review") == review["id"]


def test_a_status_delete_moves_its_issues_to_the_replacement(client: TestClient, repositories: Any) -> None:
    """Every issue moves, an archived one stays archived, and each move is in the issue's history."""
    review = client.post(f"{BASE}/teams/{TEAM}/statuses", json={"name": "Review", "category": "started"}).json()
    doing = _status_id(client, TEAM, "In Progress")
    live = _issue(repositories, TEAM, 1, review["id"])
    archived = _issue(repositories, TEAM, 2, review["id"], archived=True)

    response = client.delete(f"{BASE}/teams/{TEAM}/statuses/{review['id']}", params={"replacement_status_id": doing})

    assert response.status_code == 204, response.text
    assert _reread(repositories, live).status_id == doing
    moved = _reread(repositories, archived)
    assert moved.status_id == doing
    assert moved.archived_at is not None
    assert [row.issue_id for row in repositories.issues.iter_archived_for_status(WORKSPACE, TEAM, doing)] == [
        archived.issue_id
    ]
    history = repositories.activity.list_for_issue(WORKSPACE, live.issue_id).items
    assert any(
        row["field"] == "status_id" and row["from_value"] == review["id"] and row["to_value"] == doing
        for row in history
    )
    assert "Review" not in [row["name"] for row in client.get(f"{BASE}/teams/{TEAM}/statuses").json()["statuses"]]


def test_an_empty_status_deletes_without_a_replacement(client: TestClient) -> None:
    """Nothing to move, so nothing has to be named."""
    review = client.post(f"{BASE}/teams/{TEAM}/statuses", json={"name": "Review", "category": "started"}).json()
    assert client.delete(f"{BASE}/teams/{TEAM}/statuses/{review['id']}").status_code == 204


def test_a_replacement_must_be_another_visible_team_status(client: TestClient, repositories: Any) -> None:
    """The deleted status, an unknown id and a hidden status are each a 422, and nothing moves."""
    review = client.post(f"{BASE}/teams/{TEAM}/statuses", json={"name": "Review", "category": "started"}).json()
    issue = _issue(repositories, TEAM, 1, review["id"])
    hidden = _workspace_status(client, "Parked")
    client.patch(f"{BASE}/teams/{TEAM}/statuses/{hidden}/override", json={"hidden": True})
    path = f"{BASE}/teams/{TEAM}/statuses/{review['id']}"

    for replacement in (review["id"], "01JB0000000000000000NOPE00", hidden):
        assert client.delete(path, params={"replacement_status_id": replacement}).status_code == 422
    assert _reread(repositories, issue).status_id == review["id"]


def test_a_workspace_status_delete_counts_issues_in_every_team(client: TestClient, repositories: Any) -> None:
    """With no replacement it is a 409 counting each team's share, and nothing is deleted."""
    review = _workspace_status(client, "Review")
    _issue(repositories, TEAM, 1, review)
    _issue(repositories, OTHER, 1, review)
    _issue(repositories, OTHER, 2, review, archived=True)

    response = client.delete(f"{BASE}/statuses/{review}")

    assert response.status_code == 409
    details = response.json()["details"]
    assert details["issue_count"] == 3
    assert sorted((row["team_name"], row["issue_count"]) for row in details["teams"]) == [("Apo", 1), ("Gem", 2)]
    assert client.get(f"{BASE}/statuses").json()["statuses"][0]["id"] == review


def test_a_workspace_status_delete_moves_every_teams_issues(client: TestClient, repositories: Any) -> None:
    """Each team's issues land in the replacement workspace status."""
    review = _workspace_status(client, "Review")
    qa = _workspace_status(client, "QA")
    first = _issue(repositories, TEAM, 1, review)
    second = _issue(repositories, OTHER, 1, review, archived=True)

    response = client.delete(f"{BASE}/statuses/{review}", params={"replacement_status_id": qa})

    assert response.status_code == 204, response.text
    assert _reread(repositories, first).status_id == qa
    assert _reread(repositories, second).status_id == qa
    assert [row["id"] for row in client.get(f"{BASE}/statuses").json()["statuses"]] == [qa]


def test_a_workspace_replacement_must_be_a_workspace_status(client: TestClient, repositories: Any) -> None:
    """A team status exists in one team only, so it cannot take every team's issues; nor can the status itself."""
    review = _workspace_status(client, "Review")
    _issue(repositories, TEAM, 1, review)
    doing = _status_id(client, TEAM, "In Progress")
    for replacement in (doing, review):
        response = client.delete(f"{BASE}/statuses/{review}", params={"replacement_status_id": replacement})
        assert response.status_code == 422


def test_a_workspace_replacement_hidden_where_issues_are_is_refused(client: TestClient, repositories: Any) -> None:
    """A team with issues to move that hides the replacement is named in the 409, and nothing moves."""
    review = _workspace_status(client, "Review")
    qa = _workspace_status(client, "QA")
    client.patch(f"{BASE}/teams/{OTHER}/statuses/{qa}/override", json={"hidden": True})
    first = _issue(repositories, TEAM, 1, review)
    _issue(repositories, OTHER, 1, review)

    response = client.delete(f"{BASE}/statuses/{review}", params={"replacement_status_id": qa})

    assert response.status_code == 409
    assert response.json()["message"].startswith("The Gem team hides the replacement status")
    assert response.json()["details"]["team_id"] == OTHER
    assert _reread(repositories, first).status_id == review


def test_a_hidden_replacement_is_fine_where_no_issues_move(client: TestClient, repositories: Any) -> None:
    """Only the teams that have issues to move need to see the replacement."""
    review = _workspace_status(client, "Review")
    qa = _workspace_status(client, "QA")
    client.patch(f"{BASE}/teams/{OTHER}/statuses/{qa}/override", json={"hidden": True})
    issue = _issue(repositories, TEAM, 1, review)

    response = client.delete(f"{BASE}/statuses/{review}", params={"replacement_status_id": qa})

    assert response.status_code == 204, response.text
    assert _reread(repositories, issue).status_id == qa


def test_hiding_a_status_with_live_issues_is_refused(client: TestClient, repositories: Any) -> None:
    """The 409 counts the live issues and names the team, and the status stays visible."""
    review = _workspace_status(client, "Review")
    _issue(repositories, TEAM, 1, review)

    response = client.patch(f"{BASE}/teams/{TEAM}/statuses/{review}/override", json={"hidden": True})

    assert response.status_code == 409
    body = response.json()
    assert body["message"] == "1 issue is in this status in the Apo team. Move them to another status before hiding it."
    assert body["details"] == {"issue_count": 1, "team_id": TEAM, "team_name": "Apo"}
    visible = client.get(f"{BASE}/teams/{TEAM}/statuses").json()["statuses"]
    assert review in [row["id"] for row in visible]


def test_archived_issues_do_not_block_a_hide(client: TestClient, repositories: Any) -> None:
    """An archived issue sits in no column, so it does not keep the status shown."""
    review = _workspace_status(client, "Review")
    _issue(repositories, TEAM, 1, review, archived=True)

    response = client.patch(f"{BASE}/teams/{TEAM}/statuses/{review}/override", json={"hidden": True})

    assert response.status_code == 200, response.text
    assert response.json()["hidden"] is True


def test_a_team_label_delete_takes_it_off_the_teams_issues(client: TestClient, repositories: Any) -> None:
    """Every issue carrying the label loses it, archived ones too, and other labels stay."""
    bug = client.post(f"{BASE}/teams/{TEAM}/labels", json={"name": "Bug", "color": "#eb5757"}).json()["id"]
    infra = client.post(f"{BASE}/teams/{TEAM}/labels", json={"name": "Infra", "color": "#111111"}).json()["id"]
    todo = _status_id(client, TEAM, "Todo")
    both = _issue(repositories, TEAM, 1, todo, label_ids=[bug, infra])
    archived = _issue(repositories, TEAM, 2, todo, label_ids=[bug], archived=True)
    untouched = _issue(repositories, TEAM, 3, todo, label_ids=[infra])

    assert client.delete(f"{BASE}/teams/{TEAM}/labels/{bug}").status_code == 204

    assert _reread(repositories, both).label_ids == [infra]
    stripped = _reread(repositories, archived)
    assert stripped.label_ids == []
    assert stripped.archived_at is not None
    assert _reread(repositories, untouched).label_ids == [infra]


def test_a_workspace_label_delete_takes_it_off_every_teams_issues(client: TestClient, repositories: Any) -> None:
    """The label goes from issues in each team that inherited it."""
    bug = client.post(f"{BASE}/labels", json={"name": "Bug", "color": "#eb5757"}).json()["id"]
    first = _issue(repositories, TEAM, 1, _status_id(client, TEAM, "Todo"), label_ids=[bug])
    second = _issue(repositories, OTHER, 1, _status_id(client, OTHER, "Todo"), label_ids=[bug])

    assert client.delete(f"{BASE}/labels/{bug}").status_code == 204

    assert _reread(repositories, first).label_ids == []
    assert _reread(repositories, second).label_ids == []


def test_deleting_a_missing_label_is_still_a_no_op(client: TestClient) -> None:
    """A repeated delete answers 204 as before."""
    assert client.delete(f"{BASE}/teams/{TEAM}/labels/01JB0000000000000000NOPE00").status_code == 204
    assert client.delete(f"{BASE}/labels/01JB0000000000000000NOPE00").status_code == 204
