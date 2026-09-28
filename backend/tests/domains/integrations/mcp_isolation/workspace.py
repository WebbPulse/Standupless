"""Isolation arguments for the workspace settings, members and invites MCP tools."""

from __future__ import annotations

from typing import Any

from app.common.db.dynamo.invites import Invite, default_expiry, hash_token, new_invite_id
from tests.domains.helpers import OUTSIDER, OWNER

FOREIGN_INVITE_EMAIL = "classified-invitee@example.com"

ANSWERS_AT_HOME: frozenset[str] = frozenset(
    {"get_workspace", "update_workspace", "list_workspace_members", "list_invites", "invite_member"}
)


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """One outstanding invite in the other workspace, and the member only that workspace holds."""
    invite = repositories.invites.create(
        Invite(
            workspace_id=workspace_id,
            invite_id=new_invite_id(),
            email=FOREIGN_INVITE_EMAIL,
            role="member",
            invited_by=OWNER,
            token_hash=hash_token("a-foreign-invite-token"),
            expires_at=default_expiry(),
        )
    )
    return {"invite_id": invite.invite_id, "member_id": OUTSIDER}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's rows, one set per tool."""
    return {
        "get_workspace": {},
        "update_workspace": {"name": "Isolation rename"},
        "list_workspace_members": {},
        "list_invites": {},
        "invite_member": {"email": "isolation@example.com", "role": "member"},
        "update_member_role": {"user": foreign["member_id"], "role": "admin"},
        "remove_member": {"user": foreign["member_id"]},
        "revoke_invite": {"invite": foreign["invite_id"]},
    }
