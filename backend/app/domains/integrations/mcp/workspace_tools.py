"""The MCP tools for workspace settings, members and invites.

Each tool checks the capability its workspaces route requires, through
`check_capability`, and then runs the same `app.common.workspace_members` function
the route runs, so owner rules, the last owner, plan limits and the invite email
are identical on both surfaces. Nothing here grants ownership, changes the slug,
deletes the workspace, or touches billing or API keys.
"""

from __future__ import annotations

from typing import Any

from app.common import workspace_members
from app.common.api.dependencies.authz import Capability, check_capability
from app.common.api.schemas.workspaces import (
    InviteCreate,
    InviteRead,
    MemberUpdate,
    WorkspaceUpdate,
)
from app.common.db.dynamo.invites import Invite
from app.common.email.invite import accept_url
from app.domains.integrations.mcp.toolkit import NOT_VISIBLE, Tool, ToolCall, enum, object_schema, string, user_ref
from app.domains.integrations.mcp.transport import ToolError

ASSIGNABLE_ROLES: tuple[str, ...] = ("admin", "member", "guest")

USER_ARGUMENT = "The member: 'me', an email address or a user id"


def _invite_json(invite: InviteRead) -> dict[str, Any]:
    """One invite as the tools answer it, never carrying a token."""
    return invite.model_dump(mode="json")


def _invite_ref(call: ToolCall, value: Any) -> Invite:
    """One outstanding invite of this workspace, named by its id or the invited email.

    An email matching more than one invite is refused rather than guessed, so a
    revoke never lands on the wrong row.
    """
    reference = str(value).strip()
    if not reference:
        raise ToolError("invite is required")
    workspace_id = call.context.workspace_id
    if "@" not in reference:
        invite = call.repositories.invites.get(workspace_id, reference)
        if invite is None:
            raise ToolError(NOT_VISIBLE)
        return invite
    address = reference.lower()
    matches = [row for row in call.repositories.invites.list_for_workspace(workspace_id) if row.email == address]
    if not matches:
        raise ToolError(NOT_VISIBLE)
    if len(matches) > 1:
        raise ToolError("More than one invite goes to that address; name one by its invite_id")
    return matches[0]


def _assignable_role(call: ToolCall) -> str:
    """The role argument, refusing `owner`, which this surface never grants."""
    role = str(call.require("role")).strip().lower()
    if role == "owner":
        raise ToolError("Ownership is granted by an owner in the app, not through this tool")
    if role not in ASSIGNABLE_ROLES:
        raise ToolError(f"role must be one of: {', '.join(ASSIGNABLE_ROLES)}")
    return role


def _get_workspace(call: ToolCall) -> Any:
    """The workspace this credential is bound to, with the caller's role and any scheduled deletion."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_READ)
    return workspace_members.read_workspace(call.repositories, call.context).model_dump(mode="json")


def _update_workspace(call: ToolCall) -> Any:
    """Rename the workspace, as the workspace PATCH route does."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    payload = WorkspaceUpdate.model_validate({"name": call.require("name")})
    return workspace_members.update_workspace(call.repositories, call.context, payload).model_dump(mode="json")


def _list_members(call: ToolCall) -> Any:
    """Everyone in the workspace with their workspace role."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_READ)
    return workspace_members.list_members(call.repositories, call.context).model_dump(mode="json")


def _update_member_role(call: ToolCall) -> Any:
    """Change a member's workspace role under the route's owner and last owner rules."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    role = _assignable_role(call)
    user_id = user_ref(call, call.require("user"))
    payload = MemberUpdate.model_validate({"role": role})
    member = workspace_members.update_member_role(call.repositories, call.context, user_id, payload)
    return member.model_dump(mode="json")


def _remove_member(call: ToolCall) -> Any:
    """Remove a member from the workspace, as the member DELETE route does."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_READ)
    user_id = user_ref(call, call.require("user"))
    workspace_members.remove_member(call.repositories, call.context, user_id)
    return {"removed": True, "user_id": user_id}


def _list_invites(call: ToolCall) -> Any:
    """Every outstanding invite, without any token."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    listed = workspace_members.list_invites(call.repositories, call.context)
    return {"invites": [_invite_json(row) for row in listed.invites]}


def _invite_member(call: ToolCall) -> Any:
    """Invite an address and mail it the accept link, within the plan's limits.

    The accept link is answered too, as the route answers the token, so an admin
    can pass it on when this environment cannot mail the address.
    """
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    payload = InviteCreate.model_validate({"email": call.require("email"), "role": _assignable_role(call)})
    created = workspace_members.create_invite(call.repositories, call.context, payload)
    body = _invite_json(InviteRead.model_validate(created.model_dump(exclude={"token"})))
    body["accept_url"] = accept_url(created.token)
    return body


def _revoke_invite(call: ToolCall) -> Any:
    """Revoke one outstanding invite, so its link stops working."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_ADMIN)
    invite = _invite_ref(call, call.require("invite"))
    workspace_members.revoke_invite(call.repositories, call.context, invite.invite_id)
    return {"revoked": True, "invite_id": invite.invite_id, "email": invite.email}


WORKSPACE_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="get_workspace",
        description="The workspace this credential belongs to: name, slug, plan, the caller's role and any "
        "scheduled deletion.",
        scopes=("settings:read",),
        schema=object_schema({}),
        handler=_get_workspace,
    ),
    Tool(
        name="update_workspace",
        description="Rename the workspace. The name is the only editable setting; the slug is fixed. "
        "Needs workspace owner or admin.",
        scopes=("settings:write", "admin"),
        schema=object_schema({"name": string("The new workspace name, 1 to 80 characters")}, required=("name",)),
        handler=_update_workspace,
    ),
    Tool(
        name="list_workspace_members",
        description="Every workspace member with user id, email, display name, workspace role and join date.",
        scopes=("members:read",),
        schema=object_schema({}),
        handler=_list_members,
    ),
    Tool(
        name="update_member_role",
        description="Set a member's workspace role to admin, member or guest. Needs owner or admin; only an owner "
        "may change an owner's role, the last owner cannot be demoted, and ownership is never granted here.",
        scopes=("members:write", "admin"),
        schema=object_schema(
            {"user": string(USER_ARGUMENT), "role": enum(ASSIGNABLE_ROLES, "The new workspace role")},
            required=("user", "role"),
        ),
        handler=_update_member_role,
    ),
    Tool(
        name="remove_member",
        description="Remove a member from the workspace. They lose access to every team, issue and view in it "
        "until invited again. Needs owner or admin; the last owner cannot be removed.",
        scopes=("members:write", "admin"),
        schema=object_schema({"user": string(USER_ARGUMENT)}, required=("user",)),
        handler=_remove_member,
        destructive=True,
    ),
    Tool(
        name="list_invites",
        description="Outstanding workspace invites with email, role, inviter and expiry. Needs owner or admin.",
        scopes=("members:read", "admin"),
        schema=object_schema({}),
        handler=_list_invites,
    ),
    Tool(
        name="invite_member",
        description="Invite an email address to the workspace as admin, member or guest and email them the "
        "accept link, which is also answered. Needs owner or admin and counts against the plan's limits.",
        scopes=("members:write", "admin"),
        schema=object_schema(
            {"email": string("The address to invite"), "role": enum(ASSIGNABLE_ROLES, "The role they join with")},
            required=("email", "role"),
        ),
        handler=_invite_member,
    ),
    Tool(
        name="revoke_invite",
        description="Revoke an outstanding invite so its link stops working; the invitee would need a new invite. "
        "invite: an invite_id or the invited email address. Needs owner or admin.",
        scopes=("members:write", "admin"),
        schema=object_schema({"invite": string("An invite_id, or the invited email address")}, required=("invite",)),
        handler=_revoke_invite,
        destructive=True,
    ),
)
