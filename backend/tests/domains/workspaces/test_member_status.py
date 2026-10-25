"""A member's away status, against real tables in moto.

Only the member sets their own status, it ends itself once `until` passes with
nothing to sweep it, and every member surface reads it back, hidden from a guest
for anyone outside their teams.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.api.schemas.member_status import UserStatusUpdate, current_status
from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.memberships import StoredUserStatus
from tests.domains.helpers import (
    GUEST,
    MEMBER,
    OUTSIDER,
    OWNER,
    add_member,
    add_team_member,
    make_team,
    make_user,
    make_workspace,
    sign_in,
)

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

OTHER_TEAM = "01JB000000000000000000PRJ2"

STRANGER = "01JB0000000000000000000STR"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client carrying every domain, so the status is read back on more than the workspaces routes."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(list(DOMAINS.values()))
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A workspace where the member and the guest share one team and a stranger sits on another."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    add_member(repositories, WORKSPACE, STRANGER, "member")
    for user_id, name in ((OWNER, "Olive"), (MEMBER, "Mo"), (GUEST, "Gus"), (STRANGER, "Stan"), (OUTSIDER, "Ozzy")):
        make_user(repositories, user_id, f"{user_id.lower()}@example.com", name)
    make_team(repositories, WORKSPACE, TEAM, "ABC")
    make_team(repositories, WORKSPACE, OTHER_TEAM, "XYZ")
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "member")
    add_team_member(repositories, WORKSPACE, TEAM, GUEST, "member")
    add_team_member(repositories, WORKSPACE, OTHER_TEAM, STRANGER, "member")
    return WORKSPACE


def put_status(client: TestClient, body: dict[str, Any]) -> Any:
    """Call the set status route."""
    return client.put(f"/api/workspaces/{WORKSPACE}/members/me/status", json=body)


def members(client: TestClient) -> dict[str, dict[str, Any]]:
    """The members list keyed by user id."""
    response = client.get(f"/api/workspaces/{WORKSPACE}/members")
    assert response.status_code == 200, response.text
    return {row["user_id"]: row for row in response.json()["members"]}


def test_a_member_sets_their_status(client: TestClient, repositories: Any, workspace: str) -> None:
    """The status answers on the member row and lands on the caller's workspace row alone."""
    sign_in(client, MEMBER)
    until = (utc_now() + timedelta(days=2)).isoformat()

    response = put_status(client, {"emoji": "🌴", "text": " On vacation ", "away": True, "until": until})

    assert response.status_code == 200, response.text
    status = response.json()["user_status"]
    assert status["text"] == "On vacation"
    assert status["away"] is True
    assert status["until"] is not None
    assert members(client)[MEMBER]["user_status"]["emoji"] == "🌴"
    assert repositories.memberships.get(WORKSPACE, OWNER).user_status is None


def test_a_new_status_replaces_the_old_and_delete_clears_it(client: TestClient, workspace: str) -> None:
    """Setting again replaces, and the delete route removes it."""
    sign_in(client, MEMBER)
    put_status(client, {"emoji": "🤒", "text": "Out sick", "away": True})

    replaced = put_status(client, {"emoji": "🎯", "text": "Focusing"}).json()["user_status"]
    cleared = client.delete(f"/api/workspaces/{WORKSPACE}/members/me/status")

    assert replaced["text"] == "Focusing"
    assert replaced["away"] is False
    assert cleared.status_code == 200
    assert cleared.json()["user_status"] is None
    assert members(client)[MEMBER]["user_status"] is None


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"emoji": " ", "text": ""},
        {"text": "x" * 81},
        {"text": "Out sick", "until": "2001-01-01T00:00:00Z"},
    ],
)
def test_an_empty_long_or_past_status_is_refused(client: TestClient, workspace: str, body: dict[str, Any]) -> None:
    """A status needs an emoji or text, at most 80 characters, and an end in the future."""
    sign_in(client, MEMBER)

    assert put_status(client, body).status_code == 422


def test_someone_outside_the_workspace_cannot_set_one(client: TestClient, workspace: str) -> None:
    """A person who is not a member reaches nothing."""
    sign_in(client, OUTSIDER)

    assert put_status(client, {"text": "Focusing"}).status_code in (403, 404)


def test_a_status_past_its_end_is_ignored(repositories: Any, client: TestClient, workspace: str) -> None:
    """Once `until` passes the status stops answering, with nothing having swept it."""
    repositories.memberships.set_user_status(
        WORKSPACE, MEMBER, StoredUserStatus(text="In meetings", until=utc_now() - timedelta(seconds=1))
    )
    sign_in(client, OWNER)

    assert members(client)[MEMBER]["user_status"] is None
    assert repositories.memberships.get(WORKSPACE, MEMBER).user_status is not None


def test_current_status_ends_at_until() -> None:
    """The pure rule: in force before `until`, gone at and after it."""
    end = utc_now() + timedelta(hours=1)
    stored = StoredUserStatus(text="Focusing", until=end)

    assert current_status(stored, end - timedelta(seconds=1)) is not None
    assert current_status(stored, end) is None
    assert current_status(None) is None
    assert current_status(StoredUserStatus(text="Focusing")) is not None


def test_a_naive_until_reads_as_utc() -> None:
    """A timestamp without a zone is taken as UTC, so comparing it never fails."""
    naive = (utc_now() + timedelta(days=1)).replace(tzinfo=None)

    payload = UserStatusUpdate(text="On vacation", until=naive)

    assert payload.until is not None and payload.until.tzinfo is not None


def test_team_members_and_profiles_carry_the_status(client: TestClient, repositories: Any, workspace: str) -> None:
    """The team members list and the member page read the workspace row's status."""
    repositories.memberships.set_user_status(WORKSPACE, MEMBER, StoredUserStatus(emoji="🤒", text="Out sick"))
    sign_in(client, OWNER)

    team = client.get(f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/members").json()["members"]
    profile = client.get(f"/api/workspaces/{WORKSPACE}/views/members/{MEMBER}").json()

    assert {row["user_id"]: row["user_status"] for row in team}[MEMBER]["text"] == "Out sick"
    assert profile["user_status"]["text"] == "Out sick"


def test_a_guest_sees_status_only_for_people_on_their_teams(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A guest sees a teammate's status and their own, never a stranger's."""
    repositories.memberships.set_user_status(WORKSPACE, MEMBER, StoredUserStatus(text="Focusing"))
    repositories.memberships.set_user_status(WORKSPACE, STRANGER, StoredUserStatus(text="Out sick", away=True))
    sign_in(client, GUEST)
    put_status(client, {"text": "In meetings"})

    rows = members(client)
    stranger_page = client.get(f"/api/workspaces/{WORKSPACE}/views/members/{STRANGER}")

    assert rows[MEMBER]["user_status"]["text"] == "Focusing"
    assert rows[GUEST]["user_status"]["text"] == "In meetings"
    assert rows.get(STRANGER, {}).get("user_status") is None
    if stranger_page.status_code == 200:
        assert stranger_page.json()["user_status"] is None


def test_a_member_sees_everyones_status(client: TestClient, repositories: Any, workspace: str) -> None:
    """A full member sees a status from a team they are not on."""
    repositories.memberships.set_user_status(WORKSPACE, STRANGER, StoredUserStatus(text="Out sick", away=True))
    sign_in(client, MEMBER)

    assert members(client)[STRANGER]["user_status"]["away"] is True
