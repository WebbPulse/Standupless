"""Triage responsibility and the require-priority rule, through the issue routes.

These pin that a team assigning its triage duty hands each unassigned issue
entering the inbox to the member on duty holding the fewest waiting issues, the
lowest id on a tie, and that a team requiring a priority refuses an accept, or
any status change out of triage short of cancelling, until the issue has one.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.team_config import default_triage_settings
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_team_member, sign_in
from tests.domains.issues.conftest import TEAM, WORKSPACE, create_issue

BASE = f"/api/workspaces/{WORKSPACE}/issues"


def _settings(repositories: Any, **changes: Any) -> None:
    """Save `TEAM`'s triage settings straight in the table, triage on."""
    repositories.team_config.put_triage_settings(
        default_triage_settings(WORKSPACE, TEAM).model_copy(update={"enabled": True, **changes})
    )


@pytest.fixture
def team(repositories: Any, workspace: str) -> str:
    """`TEAM` with the owner as an explicit admin, so the owner's own issues land in triage."""
    add_team_member(repositories, workspace, TEAM, OWNER, "admin")
    return TEAM


def test_assign_takes_turns_by_fewest_waiting_issues(client: TestClient, team: str, repositories: Any) -> None:
    """Ties go to the lowest id, and each new issue goes to whoever holds fewer."""
    _settings(repositories, responsible_user_ids=[MEMBER, ADMIN], responsibility_action="assign")
    sign_in(client, OWNER)

    assignees = [create_issue(client, WORKSPACE, title=f"Issue {index}")["assignee_id"] for index in range(4)]

    assert assignees == [ADMIN, MEMBER, ADMIN, MEMBER]


def test_assign_never_overrides_a_chosen_assignee(client: TestClient, team: str, repositories: Any) -> None:
    """An issue filed with an assignee keeps it."""
    _settings(repositories, responsible_user_ids=[ADMIN], responsibility_action="assign")
    sign_in(client, OWNER)

    filed = create_issue(client, WORKSPACE, assignee_id=OWNER)

    assert filed["in_triage"] is True
    assert filed["assignee_id"] == OWNER


def test_notify_assigns_nobody(client: TestClient, team: str, repositories: Any) -> None:
    """The notify action leaves the waiting issue unassigned."""
    _settings(repositories, responsible_user_ids=[ADMIN], responsibility_action="notify")
    sign_in(client, OWNER)

    assert create_issue(client, WORKSPACE)["assignee_id"] is None


def test_an_issue_sent_back_to_triage_is_assigned(
    client: TestClient, team: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """Moving an unassigned issue back into the inbox hands it to duty too."""
    _settings(repositories, responsible_user_ids=[MEMBER], responsibility_action="assign")
    sign_in(client, OWNER)
    issue = create_issue(client, WORKSPACE, status_id=statuses["backlog"].status_id)
    assert issue["assignee_id"] is None

    response = client.patch(f"{BASE}/{issue['id']}", json={"status_id": "triage"})

    assert response.status_code == 200, response.text
    assert response.json()["in_triage"] is True
    assert response.json()["assignee_id"] == MEMBER


def test_someone_who_lost_access_is_skipped(client: TestClient, team: str, repositories: Any) -> None:
    """A guest saved on duty before the rule, or since demoted, is never assigned."""
    _settings(repositories, responsible_user_ids=[GUEST, MEMBER], responsibility_action="assign")
    sign_in(client, OWNER)

    assert {create_issue(client, WORKSPACE)["assignee_id"] for _ in range(2)} == {MEMBER}


def test_accept_needs_a_priority_when_the_team_requires_one(client: TestClient, team: str, repositories: Any) -> None:
    """A bare accept is refused and the issue keeps waiting; one carrying a priority goes through."""
    _settings(repositories, require_priority=True)
    sign_in(client, OWNER)
    waiting = create_issue(client, WORKSPACE)

    refused = client.post(f"{BASE}/{waiting['id']}/triage/accept")
    accepted = client.post(f"{BASE}/{waiting['id']}/triage/accept", json={"priority": "high"})

    assert refused.status_code == 422
    assert "requires a priority" in refused.text
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["in_triage"] is False
    assert accepted.json()["priority"] == "high"


def test_accept_with_a_priority_already_set_goes_through(client: TestClient, team: str, repositories: Any) -> None:
    """An issue filed with a priority needs nothing more."""
    _settings(repositories, require_priority=True)
    sign_in(client, OWNER)
    waiting = create_issue(client, WORKSPACE, priority="low")

    response = client.post(f"{BASE}/{waiting['id']}/triage/accept")

    assert response.status_code == 200, response.text
    assert response.json()["priority"] == "low"


def test_accept_takes_a_priority_without_the_rule(client: TestClient, team: str, repositories: Any) -> None:
    """The priority rides along on any accept, rule or not."""
    _settings(repositories)
    sign_in(client, OWNER)
    waiting = create_issue(client, WORKSPACE)

    response = client.post(f"{BASE}/{waiting['id']}/triage/accept", json={"priority": "urgent"})

    assert response.status_code == 200, response.text
    assert response.json()["priority"] == "urgent"


def test_decline_and_duplicate_need_no_priority(client: TestClient, team: str, repositories: Any) -> None:
    """Closing an issue out of triage is not accepting it."""
    _settings(repositories, require_priority=True)
    sign_in(client, OWNER)
    declined = create_issue(client, WORKSPACE)
    duplicate = create_issue(client, WORKSPACE)
    original = create_issue(client, WORKSPACE, priority="low")

    assert client.post(f"{BASE}/{declined['id']}/triage/decline", json={}).status_code == 200
    assert (
        client.post(f"{BASE}/{duplicate['id']}/triage/duplicate", json={"duplicate_of_id": original["id"]}).status_code
        == 200
    )


def test_a_status_change_out_of_triage_is_held_to_the_rule(
    client: TestClient, team: str, repositories: Any, statuses: "dict[str, Any]"
) -> None:
    """An edit that would accept needs a priority, in the same patch or before; cancelling does not."""
    _settings(repositories, require_priority=True)
    sign_in(client, OWNER)
    waiting = create_issue(client, WORKSPACE)
    cancelled = create_issue(client, WORKSPACE)
    started = statuses["started"].status_id

    refused = client.patch(f"{BASE}/{waiting['id']}", json={"status_id": started})
    moved = client.patch(f"{BASE}/{waiting['id']}", json={"status_id": started, "priority": "medium"})
    closed = client.patch(f"{BASE}/{cancelled['id']}", json={"status_id": statuses["cancelled"].status_id})

    assert refused.status_code == 422
    assert moved.status_code == 200, moved.text
    assert moved.json()["in_triage"] is False
    assert closed.status_code == 200, closed.text
