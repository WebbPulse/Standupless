"""Workspace settings, members and invites: the rules the routes and the MCP tools share.

Each function takes a context the caller has already authorized for the route's
capability, then applies the rules that sit below it: only an owner grants or
removes ownership, the last owner stays, invites and guests respect the plan's
limits, and invites are mailed. The workspaces routes and the MCP workspace tools
both call these, so the two surfaces cannot drift apart.
"""

from __future__ import annotations

from collections.abc import Collection

from fastapi import HTTPException, status
from webbpulse.audit import changed_fields
from webbpulse.dynamodb import TransactionCanceled

from app.common import audit, plan_usage
from app.common.api.dependencies.authz import AuthzContext, refuse_api_key_actor
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
from app.common.billing import sync_seats
from app.common.db.dynamo.invites import Invite, default_expiry, hash_token, new_invite_id, new_invite_token
from app.common.db.dynamo.memberships import Membership
from app.common.db.dynamo.workspaces import PERMISSION_FIELDS, Workspace
from app.common.email import deliver
from app.common.email.invite import render_invite
from app.common.plan_limits import LimitedResource

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

LAST_OWNER = {"error_code": "CONFLICT", "message": "A workspace must keep one owner"}

OWNER_ONLY = {"error_code": "FORBIDDEN", "message": "Only an owner may grant or remove ownership"}

ADMIN_INVITE_ONLY = {"error_code": "FORBIDDEN", "message": "Only a workspace admin may invite someone as an admin"}

OWN_INVITES_ONLY = {"error_code": "FORBIDDEN", "message": "Only an admin may revoke an invite someone else sent"}

ADMIN_ONLY = {"error_code": "FORBIDDEN", "message": "Only a workspace admin may suspend or reactivate a member"}

SUSPEND_SELF = {"error_code": "CONFLICT", "message": "You cannot suspend yourself"}

ALREADY_SUSPENDED = {"error_code": "CONFLICT", "message": "This member is already suspended"}

DEFAULT_MEMBER_STATUSES: frozenset[str] = frozenset({"active", "suspended"})


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
    """Rename the workspace or change its accent, update cadence, branch format or permissions. The slug is fixed.

    `accent_color` is written only when the body names it, so a rename never
    resets the accent, and an explicit null returns it to the default. Only a
    signed-in person may change whether third-party apps need approval, so a
    delegated credential cannot lift the gate that governs credentials like it.
    """
    if payload.third_party_app_approvals is not None:
        refuse_api_key_actor(context)
    workspace = repositories.workspaces.get(context.workspace_id)
    previous = _settings_of(workspace)
    if workspace is not None and payload.name is not None:
        workspace = repositories.workspaces.rename(context.workspace_id, payload.name)
    if workspace is not None and "accent_color" in payload.model_fields_set:
        workspace = repositories.workspaces.set_accent_color(context.workspace_id, payload.accent_color)
    if workspace is not None and payload.project_update_interval_days is not None:
        workspace = repositories.workspaces.set_project_update_interval(
            context.workspace_id, payload.project_update_interval_days
        )
    if workspace is not None and payload.branch_format is not None:
        workspace = repositories.workspaces.set_branch_format(context.workspace_id, payload.branch_format)
    permissions = {name: getattr(payload, name) for name in PERMISSION_FIELDS if getattr(payload, name) is not None}
    if workspace is not None and permissions:
        workspace = repositories.workspaces.set_permissions(context.workspace_id, **permissions)
    if workspace is not None and payload.third_party_app_approvals is not None:
        workspace = repositories.workspaces.set_third_party_app_approvals(
            context.workspace_id, payload.third_party_app_approvals
        )
    if workspace is None:
        raise _not_found()
    before, after = changed_fields(previous, _settings_of(workspace))
    if after:
        audit.record(
            repositories,
            context,
            "workspace.updated",
            target_type="workspace",
            target_id=workspace.id,
            target_label=workspace.name,
            before=before,
            after=after,
        )
    return WorkspaceRead.from_row(workspace, context.role)


def _settings_of(workspace: Workspace | None) -> dict[str, object]:
    """The workspace settings an update can change, as the audit log compares them."""
    if workspace is None:
        return {}
    return {
        "name": workspace.name,
        "accent_color": workspace.accent_color,
        "project_update_interval_days": workspace.project_update_interval_days,
        "branch_format": workspace.branch_format,
        "invite_permission": workspace.invite_permission,
        "team_creation_permission": workspace.team_creation_permission,
        "third_party_app_approvals": bool(workspace.third_party_app_approvals),
    }


def _member_label(repositories: Repositories, user_id: str) -> str:
    """How the audit log names a member: their display name, or their id when unknown."""
    user = repositories.users.get(user_id)
    return display_name_for(user) if user is not None else user_id


def list_members(
    repositories: Repositories,
    context: AuthzContext,
    statuses: Collection[str] | None = None,
) -> MemberListRead:
    """Everyone in the workspace, joined with their user rows for display, filtered by `status`.

    With no filter the answer holds active and suspended members, so a person chip
    on old issues and comments still resolves a suspended author. Pending invites
    answer only when `invited` is asked for, and only to an admin, because the
    invites list is admin only.
    """
    wanted = set(statuses) if statuses else set(DEFAULT_MEMBER_STATUSES)
    memberships = [
        m
        for m in repositories.memberships.list_members(context.workspace_id)
        if ("suspended" if m.is_suspended else "active") in wanted
    ]
    users = repositories.users.get_many([membership.user_id for membership in memberships])
    members = [MemberRead.from_rows(m, users.get(m.user_id)) for m in memberships]
    if "invited" in wanted and context.acts_as_workspace_admin:
        invites = repositories.invites.list_for_workspace(context.workspace_id)
        members.extend(MemberRead.from_invite(invite) for invite in invites if not invite.is_expired())
    return MemberListRead(members=members)


def update_member_role(
    repositories: Repositories, context: AuthzContext, user_id: str, payload: MemberUpdate
) -> MemberRead:
    """Change a member's workspace role.

    Only an owner may grant or remove ownership, and the last owner cannot be
    demoted, which is the same invariant that stops them being removed. Making a
    member a guest respects the plan's guest allowance, which the seat they give
    up no longer earns, and moves the guest count in the same transaction.
    """
    existing = repositories.memberships.get(context.workspace_id, user_id)
    if existing is None:
        raise _not_found()

    touches_ownership = payload.role == "owner" or existing.role == "owner"
    if touches_ownership and context.role != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=OWNER_ONLY)

    if existing.role == "owner" and payload.role != "owner" and not existing.is_suspended:
        if repositories.memberships.count_owners(context.workspace_id) <= 1:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=LAST_OWNER)

    updated = plan_usage.change_role(repositories, context.workspace_id, user_id, payload.role)
    if updated is None:
        raise _not_found()
    sync_seats(repositories, context.workspace_id)
    user = repositories.users.get(user_id)
    if existing.role != updated.role:
        audit.record(
            repositories,
            context,
            "member.role_changed",
            target_type="member",
            target_id=user_id,
            target_label=display_name_for(user) if user is not None else user_id,
            before={"role": existing.role},
            after={"role": updated.role},
        )
    return MemberRead.from_rows(updated, user)


def remove_member(repositories: Repositories, context: AuthzContext, user_id: str) -> None:
    """Remove a member, or let the caller leave, along with every team membership they hold.

    Any member may remove themselves; removing someone else needs a workspace
    admin, and removing an owner needs an owner, the same rule a role change
    follows. The last owner can do neither. The team rows go with the workspace
    row, so a later invite, even as a guest, never restores a private team or a
    team admin role. The member's plan slot is freed with the workspace row.
    """
    removing_self = user_id == context.user_id
    if not removing_self and not context.is_workspace_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=OWNER_ONLY)

    existing = repositories.memberships.get(context.workspace_id, user_id)
    if existing is None:
        raise _not_found()

    if existing.role == "owner" and not removing_self and context.role != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=OWNER_ONLY)

    if (
        existing.role == "owner"
        and not existing.is_suspended
        and repositories.memberships.count_owners(context.workspace_id) <= 1
    ):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=LAST_OWNER)

    plan_usage.remove_membership(repositories, context.workspace_id, user_id)
    sync_seats(repositories, context.workspace_id)
    audit.record(
        repositories,
        context,
        "member.left" if removing_self else "member.removed",
        target_type="member",
        target_id=user_id,
        target_label=_member_label(repositories, user_id),
        before={"role": existing.role},
    )


def suspend_member(repositories: Repositories, context: AuthzContext, user_id: str) -> MemberRead:
    """Suspend a member: they keep their role, teams and history but hold no access here.

    Only a workspace admin may suspend, never themselves, and suspending an owner
    needs an owner, the rule a role change follows. The last active owner cannot
    be suspended. Authorization reads the suspension on every request, so the
    member's sessions, personal keys, OAuth tokens and any workspace key they
    minted stop working here on their next call, while other workspaces are
    untouched. The seat they held stops being billed.
    """
    existing = _suspension_target(repositories, context, user_id)
    if user_id == context.user_id:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=SUSPEND_SELF)
    if existing.is_suspended:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ALREADY_SUSPENDED)
    if existing.role == "owner" and repositories.memberships.count_owners(context.workspace_id) <= 1:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=LAST_OWNER)
    updated = repositories.memberships.set_suspended(context.workspace_id, user_id, suspended_by=context.user_id)
    if updated is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ALREADY_SUSPENDED)
    sync_seats(repositories, context.workspace_id)
    user = repositories.users.get(user_id)
    audit.record(
        repositories,
        context,
        "member.suspended",
        target_type="member",
        target_id=user_id,
        target_label=display_name_for(user) if user is not None else user_id,
        before={"status": "active"},
        after={"status": "suspended"},
    )
    return MemberRead.from_rows(updated, user)


def reactivate_member(repositories: Repositories, context: AuthzContext, user_id: str) -> MemberRead:
    """Reactivate a suspended member with the role and teams they held. Idempotent, and audited only on a change."""
    existing = _suspension_target(repositories, context, user_id)
    user = repositories.users.get(user_id)
    if not existing.is_suspended:
        return MemberRead.from_rows(existing, user)
    updated = repositories.memberships.clear_suspended(context.workspace_id, user_id)
    if updated is None:
        raise _not_found()
    sync_seats(repositories, context.workspace_id)
    audit.record(
        repositories,
        context,
        "member.reactivated",
        target_type="member",
        target_id=user_id,
        target_label=display_name_for(user) if user is not None else user_id,
        before={"status": "suspended"},
        after={"status": "active"},
    )
    return MemberRead.from_rows(updated, user)


def _suspension_target(repositories: Repositories, context: AuthzContext, user_id: str) -> Membership:
    """The membership a suspend or reactivate acts on, once the caller may act on it."""
    if not context.acts_as_workspace_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=ADMIN_ONLY)
    existing = repositories.memberships.get_consistent(context.workspace_id, user_id)
    if existing is None:
        raise _not_found()
    if existing.role == "owner" and context.role != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=OWNER_ONLY)
    return existing


def list_invites(repositories: Repositories, context: AuthzContext) -> InviteListRead:
    """Every outstanding invite, without any token."""
    invites = repositories.invites.list_for_workspace(context.workspace_id)
    return InviteListRead(invites=[InviteRead.from_row(invite) for invite in invites])


def create_invite(repositories: Repositories, context: AuthzContext, payload: InviteCreate) -> InviteCreated:
    """Store an invite within the plan's limits, mail it, and return its token exactly once.

    Only the token's SHA-256 hash is stored, so the answer is the only place the
    token is readable. A failed send never fails the invite, because the copy-link
    flow is what an admin falls back on when the address cannot be reached.

    A full workspace refuses the invite up front, though the member slot is only
    taken when it is accepted. The invite takes its pending slot, and a guest
    invite its guest place, in the same transaction as its row.

    A member the invite setting lets in may invite at member or guest only, so
    inviting never grants more than the inviter holds.
    """
    if payload.role == "admin" and not context.acts_as_workspace_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=ADMIN_INVITE_ONLY)
    plan_usage.ensure_room(repositories, context.workspace_id, LimitedResource.MEMBERS)
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
    guest = plan_usage.guest_share(invite.role)
    try:
        plan_usage.commit(
            repositories,
            context.workspace_id,
            [repositories.invites.create_action(invite)],
            [plan_usage.Delta(LimitedResource.INVITES, 1, guest)],
            guests=plan_usage.GuestRule(pending=True) if guest else None,
        )
    except TransactionCanceled as exc:
        raise plan_usage.busy() from exc
    created = invite

    workspace = repositories.workspaces.get(context.workspace_id)
    deliver(
        render_invite(
            to=created.email,
            token=token,
            workspace_name=workspace.name if workspace is not None else "",
            role=created.role,
            inviter_name=display_name_for(repositories.users.get(context.user_id)),
            expires_at=created.expires_at,
            accent=workspace.accent_color if workspace is not None else None,
        ),
        event="workspaces.invite.email",
    )
    audit.record(
        repositories,
        context,
        "invite.created",
        target_type="invite",
        target_id=created.invite_id,
        target_label=created.email,
        after={"role": created.role},
    )
    return InviteCreated.from_created(created, token)


def revoke_invite(repositories: Repositories, context: AuthzContext, invite_id: str) -> None:
    """Revoke an invite before it is accepted. Idempotent, as the route is, and audited only when one went.

    Anyone not acting as an admin may revoke only an invite they sent.
    """
    if not context.acts_as_workspace_admin:
        invite = repositories.invites.get(context.workspace_id, invite_id)
        if invite is not None and invite.invited_by != context.user_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=OWN_INVITES_ONLY)
    existing = plan_usage.delete_invite(repositories, context.workspace_id, invite_id)
    if existing is not None:
        audit.record(
            repositories,
            context,
            "invite.revoked",
            target_type="invite",
            target_id=invite_id,
            target_label=existing.email,
            before={"role": existing.role},
        )
