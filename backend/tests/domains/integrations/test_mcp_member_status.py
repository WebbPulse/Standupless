"""The `set_my_status` MCP tool, and the status the member listing tools answer.

The tool runs the same `app.common.member_status` call the status routes run, so
these hold that it writes the caller's own status alone, refuses without
`members:write`, and that the member tools read it back while it is in force and
hide it from a guest outside the member's teams.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.memberships import StoredUserStatus
from app.domains.integrations.mcp.transport import INSUFFICIENT_SCOPE
from tests.domains.helpers import GUEST, MEMBER, OWNER
from tests.domains.integrations.conftest import TEAM, WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

STATUS_SCOPES = ("members:read", "members:write")


def by_id(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Member rows keyed by user id."""
    return {row["user_id"]: row for row in rows}


def test_set_my_status_writes_the_callers_own_status(client: TestClient, repositories: Any, workspace: str) -> None:
    """The status lands on the caller's workspace row and nobody else's."""
    secret = mint_for(repositories, MEMBER, STATUS_SCOPES)
    until = (utc_now() + timedelta(days=3)).isoformat()

    body = answer(
        tool(client, secret, "set_my_status", {"emoji": "🌴", "text": "On vacation", "away": True, "until": until})
    )

    assert body["user_id"] == MEMBER
    assert body["user_status"]["text"] == "On vacation"
    assert body["user_status"]["away"] is True
    stored = repositories.memberships.get(WORKSPACE, MEMBER).user_status
    assert stored.emoji == "🌴"
    assert repositories.memberships.get(WORKSPACE, OWNER).user_status is None


def test_set_my_status_clears(client: TestClient, repositories: Any, workspace: str) -> None:
    """`clear` removes the status."""
    secret = mint_for(repositories, MEMBER, STATUS_SCOPES)
    answer(tool(client, secret, "set_my_status", {"text": "Focusing"}))

    body = answer(tool(client, secret, "set_my_status", {"clear": True}))

    assert body["user_status"] is None
    assert repositories.memberships.get(WORKSPACE, MEMBER).user_status is None


def test_set_my_status_refuses_an_empty_or_past_status(client: TestClient, repositories: Any, workspace: str) -> None:
    """An empty status and an end already past are refused, leaving nothing stored."""
    secret = mint_for(repositories, MEMBER, STATUS_SCOPES)
    past = (utc_now() - timedelta(hours=1)).isoformat()

    refusal(tool(client, secret, "set_my_status", {}))
    refusal(tool(client, secret, "set_my_status", {"text": "Out sick", "until": past}))

    assert repositories.memberships.get(WORKSPACE, MEMBER).user_status is None


def test_set_my_status_needs_members_write(client: TestClient, repositories: Any, workspace: str) -> None:
    """A read-only members key is refused before the tool runs."""
    secret = mint_for(repositories, MEMBER, ("members:read",))

    response = tool(client, secret, "set_my_status", {"text": "Focusing"})

    assert response.json()["error"]["code"] == INSUFFICIENT_SCOPE


def test_member_tools_answer_the_status_in_force(client: TestClient, repositories: Any, workspace: str) -> None:
    """`list_users` and `list_workspace_members` carry a live status and drop an ended one."""
    repositories.memberships.set_user_status(
        WORKSPACE, MEMBER, StoredUserStatus(emoji="🤒", text="Out sick", away=True)
    )
    repositories.memberships.set_user_status(
        WORKSPACE, OWNER, StoredUserStatus(text="In meetings", until=utc_now() - timedelta(minutes=1))
    )
    secret = mint_for(repositories, OWNER, STATUS_SCOPES)

    users = by_id(answer(tool(client, secret, "list_users", {}))["users"])
    members = by_id(answer(tool(client, secret, "list_workspace_members", {}))["members"])

    for rows in (users, members):
        assert rows[MEMBER]["user_status"]["text"] == "Out sick"
        assert rows[OWNER]["user_status"] is None


def test_a_guest_sees_status_only_for_their_teams(client: TestClient, repositories: Any, workspace: str) -> None:
    """A guest sees their own status but not that of a member outside their teams."""
    repositories.memberships.set_user_status(WORKSPACE, MEMBER, StoredUserStatus(text="Focusing"))
    repositories.memberships.set_user_status(WORKSPACE, GUEST, StoredUserStatus(text="In meetings"))
    secret = mint_for(repositories, GUEST, ("members:read",))

    users = by_id(answer(tool(client, secret, "list_users", {}))["users"])

    assert users[GUEST]["user_status"]["text"] == "In meetings"
    assert users[MEMBER]["user_status"] is None


def test_team_scoped_member_tools_answer_the_status(client: TestClient, repositories: Any, workspace: str) -> None:
    """`list_users` with `team_id` and `list_team_members` carry the status, emoji, away flag and end included."""
    until = utc_now() + timedelta(days=3)
    repositories.memberships.set_user_status(
        WORKSPACE, GUEST, StoredUserStatus(emoji="🌴", text="On vacation", away=True, until=until)
    )
    secret = mint_for(repositories, OWNER, STATUS_SCOPES)

    users = by_id(answer(tool(client, secret, "list_users", {"team_id": TEAM}))["users"])
    members = by_id(answer(tool(client, secret, "list_team_members", {"team_id": TEAM}))["members"])

    for rows in (users, members):
        current = rows[GUEST]["user_status"]
        assert current["emoji"] == "🌴"
        assert current["text"] == "On vacation"
        assert current["away"] is True
        assert current["until"] is not None
