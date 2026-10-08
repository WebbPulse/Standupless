"""The workspace settings, members and invites MCP tools.

Each tool runs the same `app.common.workspace_members` function its workspaces
route runs, so these hold that a tool answers what the route would, refuses the
roles the route refuses with the same outcome, accepts people by email or `me`,
and marks the tools that remove something as destructive.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.identity.email import RecordingEmailSender

from app.common.core.config import settings
from app.common.db.dynamo.invites import Invite, default_expiry, hash_token, new_invite_id
from app.common.email import reset_email_sender
from app.common.plan_limits import PREVIEW_FREE_LIMITS, LimitedResource
from app.domains.integrations.mcp.tools import TOOLS_BY_NAME
from app.domains.integrations.mcp.transport import INSUFFICIENT_SCOPE
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OUTSIDER, OWNER, add_member, make_workspace
from tests.domains.integrations.conftest import OTHER_WORKSPACE, WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

ADMIN_MEMBERS = ("members:read", "members:write", "admin")


@pytest.fixture
def recorder() -> Iterator[RecordingEmailSender]:
    """A recording sender installed as the process-wide one for one test."""
    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


def scope_refused(response: Any) -> None:
    """Assert the call was refused before running, for a scope the role cannot carry."""
    assert response.json()["error"]["code"] == INSUFFICIENT_SCOPE


def seed_invite(repositories: Any, workspace_id: str, email: str) -> Invite:
    """One outstanding invite, stored the way the invite route stores it."""
    return repositories.invites.create(
        Invite(
            workspace_id=workspace_id,
            invite_id=new_invite_id(),
            email=email,
            role="member",
            invited_by=OWNER,
            token_hash=hash_token(f"token-{email}"),
            expires_at=default_expiry(),
        )
    )


def test_get_workspace_answers_the_callers_role(client: TestClient, repositories: Any, workspace: str) -> None:
    """Any member, a guest included, reads the workspace with their own role."""
    found = answer(tool(client, mint_for(repositories, GUEST, ("settings:read",)), "get_workspace"))

    assert found["id"] == WORKSPACE
    assert found["slug"] == "acme"
    assert found["role"] == "guest"
    assert found["purge_after"] is None


def test_update_workspace_renames_it(client: TestClient, repositories: Any, workspace: str) -> None:
    """An admin renames the workspace, and the slug stays as it was."""
    secret = mint_for(repositories, ADMIN, ("settings:write", "admin"))

    renamed = answer(tool(client, secret, "update_workspace", {"name": "  Acme Labs  "}))

    assert renamed["name"] == "Acme Labs"
    assert renamed["slug"] == "acme"
    assert repositories.workspaces.get(WORKSPACE).name == "Acme Labs"


def test_update_workspace_refuses_what_the_route_refuses(client: TestClient, repositories: Any, workspace: str) -> None:
    """A member cannot carry admin, a blank name is refused, and the slug is not a field."""
    scope_refused(
        tool(client, mint_for(repositories, MEMBER, ("settings:write", "admin")), "update_workspace", {"name": "X"})
    )
    secret = mint_for(repositories, OWNER, ("settings:write", "admin"))

    assert "name" in refusal(tool(client, secret, "update_workspace", {"name": "   "}))
    assert repositories.workspaces.get(WORKSPACE).slug == "acme"
    assert TOOLS_BY_NAME["update_workspace"].schema["properties"].keys() == {
        "name",
        "accent_color",
        "project_update_interval_days",
    }
    assert "required" in refusal(tool(client, secret, "update_workspace", {}))


def test_update_workspace_sets_and_clears_the_accent(client: TestClient, repositories: Any, workspace: str) -> None:
    """An admin sets the accent, a bad hex is refused, and null returns to the default."""
    secret = mint_for(repositories, ADMIN, ("settings:write", "admin"))

    painted = answer(tool(client, secret, "update_workspace", {"accent_color": "#1F7AE0"}))
    assert painted["accent_color"] == "#1f7ae0"
    assert painted["name"] == repositories.workspaces.get(WORKSPACE).name

    assert "accent_color" in refusal(tool(client, secret, "update_workspace", {"accent_color": "blue"}))
    assert repositories.workspaces.get(WORKSPACE).accent_color == "#1f7ae0"

    cleared = answer(tool(client, secret, "update_workspace", {"accent_color": None}))
    assert cleared["accent_color"] is None
    assert repositories.workspaces.get(WORKSPACE).accent_color is None


def test_update_workspace_sets_the_project_update_cadence(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """An admin sets the default cadence alone, an unoffered value is refused, and an empty call is refused."""
    secret = mint_for(repositories, ADMIN, ("settings:write", "admin"))

    monthly = answer(tool(client, secret, "update_workspace", {"project_update_interval_days": 30}))
    unoffered = refusal(tool(client, secret, "update_workspace", {"project_update_interval_days": 5}))
    empty = refusal(tool(client, secret, "update_workspace", {}))

    assert monthly["project_update_interval_days"] == 30
    assert monthly["name"] == repositories.workspaces.get(WORKSPACE).name
    assert "project_update_interval_days" in unoffered
    assert "required" in empty
    assert repositories.workspaces.get(WORKSPACE).project_update_interval_days == 30


def test_list_workspace_members(client: TestClient, repositories: Any, workspace: str) -> None:
    """Every member with their role and email, as the members route lists them."""
    found = answer(tool(client, mint_for(repositories, GUEST, ("members:read",)), "list_workspace_members"))

    roles = {row["user_id"]: row["role"] for row in found["members"]}
    assert roles == {OWNER: "owner", ADMIN: "admin", MEMBER: "member", GUEST: "guest"}
    emails = {row["email"] for row in found["members"]}
    assert "member@example.com" in emails


def test_update_member_role_by_email(client: TestClient, repositories: Any, workspace: str) -> None:
    """An admin changes a member's role, naming them by email address."""
    secret = mint_for(repositories, ADMIN, ADMIN_MEMBERS)

    updated = answer(tool(client, secret, "update_member_role", {"user": "member@example.com", "role": "guest"}))

    assert updated["user_id"] == MEMBER
    assert updated["role"] == "guest"
    assert repositories.memberships.get(WORKSPACE, MEMBER).role == "guest"


def test_update_member_role_holds_the_owner_rules(client: TestClient, repositories: Any, workspace: str) -> None:
    """Only an owner touches an owner, the last owner stays, and ownership is never granted."""
    admin = mint_for(repositories, ADMIN, ADMIN_MEMBERS)
    owner = mint_for(repositories, OWNER, ADMIN_MEMBERS)

    assert "Only an owner" in refusal(tool(client, admin, "update_member_role", {"user": OWNER, "role": "admin"}))
    assert "keep one owner" in refusal(tool(client, owner, "update_member_role", {"user": "me", "role": "admin"}))
    assert "Ownership" in refusal(tool(client, owner, "update_member_role", {"user": MEMBER, "role": "owner"}))
    assert repositories.memberships.get(WORKSPACE, OWNER).role == "owner"
    assert repositories.memberships.get(WORKSPACE, MEMBER).role == "member"


def test_an_owner_demotes_another_owner(client: TestClient, repositories: Any, workspace: str) -> None:
    """With a second owner present, an owner may demote one, as the route allows."""
    add_member(repositories, WORKSPACE, ADMIN, "owner")
    secret = mint_for(repositories, OWNER, ADMIN_MEMBERS)

    updated = answer(tool(client, secret, "update_member_role", {"user": "admin@example.com", "role": "admin"}))

    assert updated["role"] == "admin"


def test_update_member_role_refuses_a_member(client: TestClient, repositories: Any, workspace: str) -> None:
    """A member's key cannot carry admin, so the call stops before it runs."""
    scope_refused(
        tool(
            client,
            mint_for(repositories, MEMBER, ADMIN_MEMBERS),
            "update_member_role",
            {"user": GUEST, "role": "member"},
        )
    )
    assert repositories.memberships.get(WORKSPACE, GUEST).role == "guest"


def test_update_member_role_cannot_reach_a_non_member(client: TestClient, repositories: Any, workspace: str) -> None:
    """Someone outside the workspace is not found, by id or by email."""
    secret = mint_for(repositories, OWNER, ADMIN_MEMBERS)

    for user in (OUTSIDER, "outsider@example.com"):
        assert "Not found" in refusal(tool(client, secret, "update_member_role", {"user": user, "role": "member"}))


def test_remove_member(client: TestClient, repositories: Any, workspace: str) -> None:
    """An admin removes a member named by email, and the tool is marked destructive."""
    secret = mint_for(repositories, ADMIN, ADMIN_MEMBERS)

    removed = answer(tool(client, secret, "remove_member", {"user": "guest@example.com"}))

    assert removed == {"removed": True, "user_id": GUEST}
    assert repositories.memberships.get(WORKSPACE, GUEST) is None
    assert TOOLS_BY_NAME["remove_member"].descriptor()["annotations"]["destructiveHint"] is True


def test_remove_member_refuses_what_the_route_refuses(client: TestClient, repositories: Any, workspace: str) -> None:
    """A member cannot carry admin, and the last owner cannot be removed."""
    scope_refused(tool(client, mint_for(repositories, MEMBER, ADMIN_MEMBERS), "remove_member", {"user": GUEST}))
    owner = mint_for(repositories, OWNER, ADMIN_MEMBERS)

    assert "keep one owner" in refusal(tool(client, owner, "remove_member", {"user": "me"}))
    assert repositories.memberships.get(WORKSPACE, OWNER) is not None
    assert repositories.memberships.get(WORKSPACE, GUEST) is not None


def test_remove_member_refuses_an_admin_removing_an_owner(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """An admin's key cannot remove a co-owner, as the route refuses it."""
    add_member(repositories, WORKSPACE, MEMBER, "owner")
    secret = mint_for(repositories, ADMIN, ADMIN_MEMBERS)

    assert "Only an owner" in refusal(tool(client, secret, "remove_member", {"user": MEMBER}))
    assert repositories.memberships.get(WORKSPACE, MEMBER).role == "owner"


def test_list_invites(client: TestClient, repositories: Any, workspace: str) -> None:
    """An admin lists outstanding invites, and no token appears in the answer."""
    seed_invite(repositories, WORKSPACE, "pending@example.com")

    found = answer(tool(client, mint_for(repositories, ADMIN, ("members:read", "admin")), "list_invites"))

    assert [row["email"] for row in found["invites"]] == ["pending@example.com"]
    assert "token" not in found["invites"][0]


def test_list_invites_refuses_a_member(client: TestClient, repositories: Any, workspace: str) -> None:
    """A member cannot read invites, as the invites route refuses them."""
    scope_refused(tool(client, mint_for(repositories, MEMBER, ("members:read", "admin")), "list_invites"))


def test_invite_member_stores_and_mails_the_invite(
    client: TestClient, repositories: Any, workspace: str, recorder: RecordingEmailSender
) -> None:
    """The invite is stored by hash, mailed with the accept link, and the link answered once."""
    secret = mint_for(repositories, ADMIN, ADMIN_MEMBERS)

    created = answer(tool(client, secret, "invite_member", {"email": "New.Person@Example.com", "role": "member"}))

    assert created["email"] == "new.person@example.com"
    assert created["role"] == "member"
    assert created["invited_by"] == ADMIN
    assert created["accept_url"].startswith(f"{settings.frontend_base_url}/invites/accept?token=")
    assert "token" not in created
    stored = repositories.invites.get(WORKSPACE, created["invite_id"])
    assert stored is not None
    [sent] = recorder.sent
    assert sent.to == "new.person@example.com"
    assert created["accept_url"] in sent.text


def test_invite_member_refuses_what_the_route_refuses(client: TestClient, repositories: Any, workspace: str) -> None:
    """A member cannot invite, ownership cannot be invited, and a bad address is refused."""
    scope_refused(
        tool(
            client,
            mint_for(repositories, MEMBER, ADMIN_MEMBERS),
            "invite_member",
            {"email": "x@example.com", "role": "member"},
        )
    )
    secret = mint_for(repositories, OWNER, ADMIN_MEMBERS)

    assert "Ownership" in refusal(tool(client, secret, "invite_member", {"email": "x@example.com", "role": "owner"}))
    assert "email" in refusal(tool(client, secret, "invite_member", {"email": "not-an-address", "role": "member"}))
    assert repositories.invites.list_for_workspace(WORKSPACE) == []


@pytest.mark.parametrize("resource", [LimitedResource.INVITES, LimitedResource.MEMBERS])
def test_invite_member_respects_the_plan_limits(
    client: TestClient, repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch, resource: LimitedResource
) -> None:
    """At the plan's member or invite ceiling the invite is refused, as the route refuses it."""
    seed_invite(repositories, WORKSPACE, "pending@example.com")
    monkeypatch.setitem(PREVIEW_FREE_LIMITS, resource, 1)
    secret = mint_for(repositories, OWNER, ADMIN_MEMBERS)

    message = refusal(tool(client, secret, "invite_member", {"email": "x@example.com", "role": "member"}))

    assert "plan limit" in message
    assert len(repositories.invites.list_for_workspace(WORKSPACE)) == 1


def test_revoke_invite_by_email_and_by_id(client: TestClient, repositories: Any, workspace: str) -> None:
    """An invite is revoked by the invited address or by its id, and the tool is destructive."""
    by_email = seed_invite(repositories, WORKSPACE, "first@example.com")
    by_id = seed_invite(repositories, WORKSPACE, "second@example.com")
    secret = mint_for(repositories, ADMIN, ADMIN_MEMBERS)

    first = answer(tool(client, secret, "revoke_invite", {"invite": "First@Example.com"}))
    second = answer(tool(client, secret, "revoke_invite", {"invite": by_id.invite_id}))

    assert first["invite_id"] == by_email.invite_id
    assert second["email"] == "second@example.com"
    assert repositories.invites.list_for_workspace(WORKSPACE) == []
    assert TOOLS_BY_NAME["revoke_invite"].descriptor()["annotations"]["destructiveHint"] is True


def test_revoke_invite_refuses_a_member_and_an_unknown_invite(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A member cannot revoke, and an invite that is not outstanding here is not found."""
    invite = seed_invite(repositories, WORKSPACE, "pending@example.com")
    scope_refused(
        tool(client, mint_for(repositories, MEMBER, ADMIN_MEMBERS), "revoke_invite", {"invite": invite.invite_id})
    )
    secret = mint_for(repositories, OWNER, ADMIN_MEMBERS)

    assert "Not found" in refusal(tool(client, secret, "revoke_invite", {"invite": "nobody@example.com"}))
    assert repositories.invites.get(WORKSPACE, invite.invite_id) is not None


def test_workspace_tools_leave_another_workspace_alone(client: TestClient, repositories: Any, workspace: str) -> None:
    """The owner of two workspaces cannot rename, revoke or remove in the one the key is not bound to."""
    make_workspace(repositories, OTHER_WORKSPACE, "other", OWNER)
    add_member(repositories, OTHER_WORKSPACE, OUTSIDER, "member")
    foreign = seed_invite(repositories, OTHER_WORKSPACE, "foreign@example.com")
    secret = mint_for(repositories, OWNER, ("settings:write", "admin", *ADMIN_MEMBERS))

    answer(tool(client, secret, "update_workspace", {"name": "Home only"}))
    assert "Not found" in refusal(tool(client, secret, "revoke_invite", {"invite": foreign.invite_id}))
    assert "Not found" in refusal(tool(client, secret, "revoke_invite", {"invite": "foreign@example.com"}))
    assert "Not found" in refusal(tool(client, secret, "remove_member", {"user": OUTSIDER}))

    assert repositories.workspaces.get(OTHER_WORKSPACE).name == "Other"
    assert repositories.invites.get(OTHER_WORKSPACE, foreign.invite_id) is not None
    assert repositories.memberships.get(OTHER_WORKSPACE, OUTSIDER) is not None
