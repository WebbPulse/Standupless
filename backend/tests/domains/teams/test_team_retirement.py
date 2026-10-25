"""Retiring a team: the routes, the audit trail, and the writes a retired team refuses.

A retired team stays listed and readable, refuses every write into it with 409
`TEAM_RETIRED`, and still lets people leave, be removed, or bring it back.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.audit import AuditEvent, AuditQuery

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.issues import Issue
from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_member, add_team_member, make_team, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

OTHER_TEAM = "01JB000000000000000000PRJ2"

BASE = f"/api/workspaces/{WORKSPACE}"


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
    """A workspace with an admin, a member who belongs to `TEAM`, and two top-level teams."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    make_team(repositories, WORKSPACE, TEAM, "RET")
    make_team(repositories, WORKSPACE, OTHER_TEAM, "ACT")
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "member")
    return WORKSPACE


def seed_issue(repositories: Any, number: int, category: str, *, in_triage: bool = False) -> Issue:
    """Put one issue of `TEAM` in the first status of a category, or awaiting triage."""
    statuses = repositories.team_config.list_statuses(WORKSPACE, TEAM)
    status_id = next(row.status_id for row in statuses if row.category == category)
    return repositories.issues.create(
        Issue(
            workspace_id=WORKSPACE,
            team_id=TEAM,
            key=f"RET-{number}",
            number=number,
            title=f"Issue {number}",
            status_id=status_id,
            created_by=OWNER,
            in_triage=in_triage,
        )
    )


def logged(repositories: Any, action: str) -> list[AuditEvent]:
    """The workspace's audit entries of one kind, newest first."""
    return repositories.audit.list_events(WORKSPACE, AuditQuery(action=action)).events


def test_retire_and_unretire_round_trip_and_are_idempotent(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Retiring sets `retired_at` and `retired_by`, a repeat changes nothing, and un-retire clears both."""
    sign_in(client, ADMIN)

    retired = client.post(f"{BASE}/teams/{TEAM}/retire")
    again = client.post(f"{BASE}/teams/{TEAM}/retire")

    assert retired.status_code == 200, retired.text
    assert retired.json()["retired_at"] is not None
    assert retired.json()["retired_by"] == ADMIN
    assert again.json()["retired_at"] == retired.json()["retired_at"]
    assert len(logged(repositories, "team.retired")) == 1

    listed = {row["id"]: row for row in client.get(f"{BASE}/teams").json()["teams"]}
    assert listed[TEAM]["retired_at"] is not None
    assert listed[OTHER_TEAM]["retired_at"] is None

    restored = client.post(f"{BASE}/teams/{TEAM}/unretire")
    client.post(f"{BASE}/teams/{TEAM}/unretire")

    assert restored.status_code == 200, restored.text
    assert restored.json()["retired_at"] is None
    assert restored.json()["retired_by"] is None
    assert len(logged(repositories, "team.unretired")) == 1


def test_a_team_member_may_not_retire_it(client: TestClient, workspace: str, repositories: Any) -> None:
    """Retiring is team admin work, so a plain member is refused and the team stays active."""
    sign_in(client, MEMBER)

    assert client.post(f"{BASE}/teams/{TEAM}/retire").status_code == 403
    assert repositories.teams.get(WORKSPACE, TEAM).retired_at is None


def test_a_retired_team_refuses_writes_but_still_reads(client: TestClient, workspace: str) -> None:
    """Settings, statuses and labels answer 409 `TEAM_RETIRED` while reads keep working."""
    sign_in(client, ADMIN)
    client.post(f"{BASE}/teams/{TEAM}/retire")

    renamed = client.patch(f"{BASE}/teams/{TEAM}", json={"name": "Renamed"})
    label = client.post(f"{BASE}/teams/{TEAM}/labels", json={"name": "Bug", "color": "#eb5757"})
    status = client.post(f"{BASE}/teams/{TEAM}/statuses", json={"name": "Review", "category": "started"})

    for refused in (renamed, label, status):
        assert refused.status_code == 409, refused.text
        assert refused.json()["error_code"] == "TEAM_RETIRED"
    assert client.get(f"{BASE}/teams/{TEAM}").status_code == 200
    assert client.get(f"{BASE}/teams/{TEAM}/statuses").status_code == 200

    client.post(f"{BASE}/teams/{TEAM}/unretire")
    assert client.patch(f"{BASE}/teams/{TEAM}", json={"name": "Renamed"}).status_code == 200


def test_people_may_still_leave_a_retired_team(client: TestClient, workspace: str) -> None:
    """Leaving is not a write into the team's work, so retirement does not trap anyone in it."""
    sign_in(client, ADMIN)
    client.post(f"{BASE}/teams/{TEAM}/retire")
    sign_in(client, MEMBER)

    assert client.post(f"{BASE}/teams/{TEAM}/leave").status_code == 204


def test_a_parent_retires_only_after_its_sub_teams(client: TestClient, workspace: str) -> None:
    """An active sub-team blocks retiring its parent, and a retired parent blocks un-retiring the sub-team."""
    sign_in(client, ADMIN)
    created = client.post(f"{BASE}/teams", json={"name": "Sub", "key_prefix": "SUB", "parent_team_id": TEAM})
    assert created.status_code == 201, created.text
    sub = created.json()["id"]

    blocked = client.post(f"{BASE}/teams/{TEAM}/retire")
    assert blocked.status_code == 409
    assert blocked.json()["error_code"] == "TEAM_NOT_RETIRABLE"
    assert "SUB" in blocked.json()["message"]

    assert client.post(f"{BASE}/teams/{sub}/retire").status_code == 200
    assert client.post(f"{BASE}/teams/{TEAM}/retire").status_code == 200

    stuck = client.post(f"{BASE}/teams/{sub}/unretire")
    assert stuck.status_code == 409
    assert stuck.json()["error_code"] == "TEAM_NOT_RETIRABLE"

    assert client.post(f"{BASE}/teams/{TEAM}/unretire").status_code == 200
    assert client.post(f"{BASE}/teams/{sub}/unretire").status_code == 200


def test_no_team_nests_under_a_retired_parent(client: TestClient, workspace: str) -> None:
    """Creating or moving a team under a retired parent is the retired-team 409."""
    sign_in(client, ADMIN)
    client.post(f"{BASE}/teams/{TEAM}/retire")

    created = client.post(f"{BASE}/teams", json={"name": "Sub", "key_prefix": "SUB", "parent_team_id": TEAM})
    moved = client.patch(f"{BASE}/teams/{OTHER_TEAM}", json={"parent_team_id": TEAM})

    assert created.status_code == 409, created.text
    assert created.json()["error_code"] == "TEAM_RETIRED"
    assert moved.status_code == 409, moved.text
    assert moved.json()["error_code"] == "TEAM_RETIRED"


def test_a_team_with_open_issues_is_not_retired(client: TestClient, workspace: str, repositories: Any) -> None:
    """Open and triage issues block the retire with their count; completed and cancelled ones do not."""
    seed_issue(repositories, 1, "started")
    seed_issue(repositories, 2, "backlog")
    seed_issue(repositories, 3, "unstarted", in_triage=True)
    seed_issue(repositories, 4, "completed")
    seed_issue(repositories, 5, "cancelled")
    sign_in(client, ADMIN)

    blocked = client.post(f"{BASE}/teams/{TEAM}/retire")

    assert blocked.status_code == 409, blocked.text
    assert blocked.json()["error_code"] == "TEAM_HAS_OPEN_ISSUES"
    assert blocked.json()["details"] == {"open_issue_count": 3}
    assert "3 open issues" in blocked.json()["message"]
    assert repositories.teams.get(WORKSPACE, TEAM).retired_at is None
    assert logged(repositories, "team.retired") == []


def test_a_team_whose_issues_are_all_finished_retires(client: TestClient, workspace: str, repositories: Any) -> None:
    """Only completed and cancelled issues left, the team retires."""
    seed_issue(repositories, 1, "completed")
    seed_issue(repositories, 2, "cancelled")
    sign_in(client, ADMIN)

    assert client.post(f"{BASE}/teams/{TEAM}/retire").status_code == 200
