"""The team notification routes: each person's own choice of a team's issue events.

Every event defaults off, a write changes only the events it names, turning all
four off removes the stored row, and a team the caller cannot see answers 404.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import GUEST, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM

OFF = {"issue_created": False, "triage": False, "completed": False, "cancelled": False}


def path(workspace: str, team_id: str = TEAM) -> str:
    """The subscription route of one team."""
    return f"/api/workspaces/{workspace}/views/teams/{team_id}/subscription"


def test_every_event_starts_off(client: TestClient, workspace: str) -> None:
    """A member who never chose anything reads four switches off."""
    sign_in(client, MEMBER)
    response = client.get(path(workspace))
    assert response.status_code == 200, response.text
    assert response.json() == {"team_id": TEAM, **OFF}


def test_a_write_changes_only_the_events_it_names(client: TestClient, workspace: str, repositories: Any) -> None:
    """Turning one event on keeps the others, and the row is the caller's alone."""
    sign_in(client, MEMBER)
    first = client.put(path(workspace), json={"completed": True})
    second = client.put(path(workspace), json={"triage": True})

    assert first.status_code == 200, first.text
    assert second.json() == {"team_id": TEAM, **OFF, "completed": True, "triage": True}
    assert [row.user_id for row in repositories.views.team_subscriptions(workspace, TEAM)] == [MEMBER]
    sign_in(client, OWNER)
    assert client.get(path(workspace)).json() == {"team_id": TEAM, **OFF}


def test_turning_every_event_off_removes_the_row(client: TestClient, workspace: str, repositories: Any) -> None:
    """With nothing on, nothing is stored, so the team's subscribers are only people who want something."""
    sign_in(client, MEMBER)
    client.put(path(workspace), json={"issue_created": True, "cancelled": True})

    response = client.put(path(workspace), json={"issue_created": False, "cancelled": False})

    assert response.json() == {"team_id": TEAM, **OFF}
    assert repositories.views.team_subscriptions(workspace, TEAM) == []
    assert repositories.views.get_team_subscription(workspace, TEAM, MEMBER) is None


def test_a_team_the_caller_cannot_see_is_not_found(client: TestClient, workspace: str, repositories: Any) -> None:
    """A guest outside the team reads and writes nothing, and nothing is stored."""
    sign_in(client, GUEST)
    assert client.get(path(workspace, OTHER_TEAM)).status_code == 404
    assert client.put(path(workspace, OTHER_TEAM), json={"issue_created": True}).status_code == 404
    assert repositories.views.team_subscriptions(workspace, OTHER_TEAM) == []


def test_an_unknown_event_is_refused(client: TestClient, workspace: str) -> None:
    """The body names only the four events."""
    sign_in(client, MEMBER)
    assert client.put(path(workspace), json={"commented": True}).status_code == 422
