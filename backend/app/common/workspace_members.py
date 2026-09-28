"""Workspace settings, members and invites: the rules the routes and the MCP tools share.

Each function takes a context the caller has already authorized for the route's
capability, then applies the rules that sit below it: only an owner grants or
removes ownership, the last owner stays, invites respect the plan's limits and
are mailed. The workspaces routes and the MCP workspace tools both call these, so
the two surfaces cannot drift apart.
"""

from __future__ import annotations

from fastapi import HTTPException, status

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.workspaces import (
    InviteCreate,
    InviteCreated,
    InviteListRead,
    InviteRead,
    MemberListRead,
    MemberRead,
    MemberUpdate,
    WorkspaceRead,
    WorkspaceUpdate,
    display_name_for,
)
from app.common.db.dynamo.invites import Invite, default_expiry, hash_token, new_invite_id, new_invite_token
from app.common.email import deliver
from app.common.email.invite import render_invite
from app.common.plan_limits import LimitedResource, enforce_limit

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

LAST_OWNER = {"error_code": "CONFLICT", "message": "A workspace must keep one owner"}

OWNER_ONLY = {"error_code": "FORBIDDEN", "message": "Only an owner may grant or remove ownership"}


def _not_found() -> HTTPException:
    """The 404 every missing workspace, member or invite answers."""
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)


def read_workspace(repositories: Repositories, context: AuthzContext) -> WorkspaceRead:
    """The caller's workspace with their role, or a 404 once it is being purged."""
    workspace = repositories.workspaces.get(context.workspace_id)
    if workspace is None or workspace.is_purging:
        raise _not_found()
    return WorkspaceRead.from_row(workspace, context.role)


def update_workspace(repositories: Repositories, context: AuthzContext, payload: WorkspaceUpdate) -> WorkspaceRead:
    """Rename the workspace. The slug is fixed, so the name is the only editable setting."""
    if payload.name is None:
        workspace = repositories.workspaces.get(context.workspace_id)
    else:
        workspace = repositories.workspaces.rename(context.workspace_id, payload.name)
    if workspace is None:
        raise _not_found()
    return WorkspaceRead.from_row(workspace, context.role)


def list_members(repositories: Repositories, context: AuthzContext) -> MemberListRead:
    """Everyone in the workspace, joined with their user rows for display."""
    memberships = repositories.memberships.list_members(context.workspace_id)
    users = repositories.users.get_many([membership.user_id for membership in memberships])
    return MemberListRead(members=[MemberRead.from_rows(m, users.get(m.user_id)) for m in memberships])


def update_member_role(
    repositories: Repositories, context: AuthzContext, user_id: str, payload: MemberUpdate
) -> MemberRead:
    """Change a member's workspace role.

    Only an owner may grant or remove ownership, and the last owner cannot be
    demoted, which is the same invariant that stops them being removed.
    """
    existing = repositories.memberships.get(context.workspace_id, user_id)
    if existing is None:
        raise _not_found()

    touches_ownership = payload.role == "owner" or existing.role == "owner"
    if touches_ownership and context.role != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=OWNER_ONLY)

    if existing.role == "owner" and payload.role != "owner":
        if repositories.memberships.count_owners(context.workspace_id) <= 1:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=LAST_OWNER)

    updated = repositories.memberships.set_role(context.workspace_id, user_id, payload.role)
    if updated is None:
        raise _not_found()
    return MemberRead.from_rows(updated, repositories.users.get(user_id))


def remove_member(repositories: Repositories, context: AuthzContext, user_id: str) -> None:
    """Remove a member, or let the caller leave.

    Any member may remove themselves; removing someone else needs a workspace
    admin. The last owner can do neither.
    """
    if user_id != context.user_id and not context.is_workspace_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=OWNER_ONLY)

    existing = repositories.memberships.get(context.workspace_id, user_id)
    if existing is None:
        raise _not_found()

    if existing.role == "owner" and repositories.memberships.count_owners(context.workspace_id) <= 1:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=LAST_OWNER)

    repositories.memberships.delete(context.workspace_id, user_id)


def list_invites(repositories: Repositories, context: AuthzContext) -> InviteListRead:
    """Every outstanding invite, without any token."""
    invites = repositories.invites.list_for_workspace(context.workspace_id)
    return InviteListRead(invites=[InviteRead.from_row(invite) for invite in invites])


def create_invite(repositories: Repositories, context: AuthzContext, payload: InviteCreate) -> InviteCreated:
    """Store an invite within the plan's limits, mail it, and return its token exactly once.

    Only the token's SHA-256 hash is stored, so the answer is the only place the
    token is readable. A failed send never fails the invite, because the copy-link
    flow is what an admin falls back on when the address cannot be reached.
    """
    enforce_limit(repositories, context.workspace_id, LimitedResource.MEMBERS)
    enforce_limit(repositories, context.workspace_id, LimitedResource.INVITES)
    token = new_invite_token()
    invite = Invite(
        workspace_id=context.workspace_id,
        invite_id=new_invite_id(),
        email=str(payload.email).strip().lower(),
        role=payload.role,
        invited_by=context.user_id,
        token_hash=hash_token(token),
        expires_at=default_expiry(),
    )
    created = repositories.invites.create(invite)

    workspace = repositories.workspaces.get(context.workspace_id)
    deliver(
        render_invite(
            to=created.email,
            token=token,
            workspace_name=workspace.name if workspace is not None else "",
            role=created.role,
            inviter_name=display_name_for(repositories.users.get(context.user_id)),
            expires_at=created.expires_at,
        ),
        event="workspaces.invite.email",
    )
    return InviteCreated.from_created(created, token)


def revoke_invite(repositories: Repositories, context: AuthzContext, invite_id: str) -> None:
    """Revoke an invite before it is accepted. Idempotent, as the route is."""
    repositories.invites.delete(context.workspace_id, invite_id)
