"""The workspace routes: the tenant itself, its members and its invites.

Every route but the two that have no workspace in their path goes through
`require(...)` in `app.common.api.dependencies.authz`, which is the only place a
role is compared. A caller outside a workspace gets a 404 on everything inside
it, never a 403, so the routes themselves never have to remember that rule.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Path, Request, Response, status
from webbpulse.dynamodb import ConditionFailed, TransactionCanceled

from app.common import audit, plan_usage, workspace_members
from app.common.api.dependencies.authz import (
    AuthzContext,
    Capability,
    auth_policy_refusal,
    auth_strength_of,
    caller_claims,
    caller_subject,
    refuse_api_key_actor,
    request_context,
    require,
)
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.billing import sync_seats
from app.common.db.dynamo.invites import hash_token
from app.common.db.dynamo.memberships import Membership, workspace_member_key
from app.common.db.dynamo.workspaces import Workspace, new_workspace_id
from app.common.email import deliver
from app.common.plan_limits import LimitedResource
from app.common.workspace_members import NOT_FOUND
from app.domains.workspaces.email import render_workspace_deletion
from app.domains.workspaces.schemas.workspace import (
    InviteAccept,
    InviteCreate,
    InviteCreated,
    InviteListRead,
    MemberListRead,
    MemberRead,
    MemberUpdate,
    WorkspaceCreate,
    WorkspaceDeletionRequest,
    WorkspaceListRead,
    WorkspaceRead,
    WorkspaceUpdate,
    display_name_for,
)

_log = logging.getLogger(__name__)

router = APIRouter()

invites_router = APIRouter()

SLUG_TAKEN = {"error_code": "CONFLICT", "message": "That workspace slug is taken"}

NAME_MISMATCH = {"error_code": "CONFIRMATION_MISMATCH", "message": "Type the workspace name exactly to confirm"}

PURGING = {"error_code": "CONFLICT", "message": "This workspace is already being deleted"}

INVALID_INVITE = {"error_code": "INVALID_INVITE", "message": "That invite is not valid"}

INVITE_EMAIL_MISMATCH = {
    "error_code": "INVITE_EMAIL_MISMATCH",
    "message": "This invite was sent to a different email address. Sign in with that address to accept it.",
}

ACCOUNT_DELETED = {"error_code": "ACCOUNT_DELETED", "message": "This account has been deleted"}


def refuse_deleted_caller(repositories: Repositories, subject: str) -> None:
    """Refuse with a 401 a caller whose account is deleted or already purged.

    Guards the two routes that need no membership, creating a workspace and accepting
    an invite, so a token issued before the account was deleted cannot join or
    create anything in the minutes before it expires. Every other route already
    fails once the purge removes the person's memberships.
    """
    user = repositories.users.get(subject)
    if user is None or user.is_deleted:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=ACCOUNT_DELETED)


@router.get("/health", include_in_schema=False)
def health() -> Dict[str, Any]:
    """Liveness for this domain, reading nothing."""
    return {"status": "healthy", "domain": "workspaces"}


@router.get("", response_model=WorkspaceListRead)
def list_workspaces(
    claims: Annotated[Any, Depends(caller_claims)],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> WorkspaceListRead:
    """Every workspace the caller is a member of, with their role on each.

    Read through the memberships user index rather than an owner field, so a
    member who does not own the workspace still sees it. A workspace whose
    authentication policy refuses the caller's session is still listed, flagged,
    so the client can say why instead of failing every call inside it.
    """
    subject = str(claims.get("sub", "") or "").strip()
    memberships = repositories.memberships.list_workspaces_for_user(subject)
    if not memberships:
        return WorkspaceListRead(workspaces=[])

    roles = {membership.workspace_id: membership.role for membership in memberships}
    found = repositories.workspaces.get_many(list(roles))
    rows: list[WorkspaceRead] = []
    for workspace_id, workspace in sorted(found.items()):
        if workspace.is_purging:
            continue
        refusal = auth_policy_refusal(repositories, workspace_id, claims)
        rows.append(
            WorkspaceRead.from_row(
                workspace,
                roles.get(workspace_id),
                auth_policy_blocked=refusal is not None,
                auth_policy_reason=refusal.reason if refusal is not None else None,
                auth_policy_allowed_methods=(list(refusal.allowed_methods) or None) if refusal is not None else None,
            )
        )
    return WorkspaceListRead(workspaces=rows)


@router.post("", response_model=WorkspaceRead, status_code=status.HTTP_201_CREATED)
def create_workspace(
    payload: WorkspaceCreate,
    subject: Annotated[str, Depends(caller_subject)],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> WorkspaceRead:
    """Create a workspace and make the caller its first owner.

    The membership is written after the workspace, because a workspace with no
    owner is recoverable while an owner row pointing at nothing is not.
    """
    refuse_deleted_caller(repositories, subject)
    workspace = Workspace(id=new_workspace_id(), name=payload.name, slug=payload.slug)
    try:
        created = repositories.workspaces.create(workspace)
    except ConditionFailed as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=SLUG_TAKEN) from exc

    repositories.memberships.put(
        Membership(
            workspace_id=created.id,
            member_key=workspace_member_key(subject),
            user_id=subject,
            role="owner",
        )
    )
    return WorkspaceRead.from_row(created, "owner")


@router.get("/{workspace_id}", response_model=WorkspaceRead)
def read_workspace(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> WorkspaceRead:
    """One workspace the caller belongs to, carrying their role and any scheduled deletion."""
    return workspace_members.read_workspace(repositories, context)


@router.patch("/{workspace_id}", response_model=WorkspaceRead)
def update_workspace(
    payload: WorkspaceUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> WorkspaceRead:
    """Rename a workspace or set its accent color. The slug is fixed."""
    return workspace_members.update_workspace(repositories, context, payload)


def _notify_admins(
    repositories: Repositories,
    workspace: Workspace,
    actor_id: str,
    *,
    cancelled: bool,
) -> None:
    """Mail every owner and admin that the workspace's deletion was scheduled or cancelled.

    Sent through `deliver`, which never raises, so a sandboxed sender that may not
    reach an address costs the notice and never the request.
    """
    admins = [
        m for m in repositories.memberships.list_members(workspace.id, limit=5000) if m.role in ("owner", "admin")
    ]
    users = repositories.users.get_many([m.user_id for m in admins] + [actor_id])
    actor_name = display_name_for(users.get(actor_id))
    for membership in admins:
        user = users.get(membership.user_id)
        if user is None or not user.email:
            continue
        deliver(
            render_workspace_deletion(
                to=user.email,
                workspace_name=workspace.name,
                slug=workspace.slug,
                actor_name=actor_name,
                purge_after=workspace.purge_after,
                cancelled=cancelled,
                accent=workspace.accent_color,
            ),
            event="workspaces.deletion.email",
        )


@router.post("/{workspace_id}/deletion", response_model=WorkspaceRead)
def schedule_workspace_deletion(
    payload: WorkspaceDeletionRequest,
    request: Request,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> WorkspaceRead:
    """Schedule the workspace for permanent deletion after the grace period.

    Owners and admins only, a signed in person only, and only with the workspace's
    name typed out again. Repeating it keeps the first date. Every owner and admin
    is mailed, and the request is logged with how the caller last authenticated.
    """
    refuse_api_key_actor(context)
    workspace = repositories.workspaces.get(context.workspace_id)
    if workspace is None or workspace.is_purging:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    if payload.confirm_name.strip() != workspace.name.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=NAME_MISMATCH)

    already = workspace.purge_after is not None
    scheduled = repositories.workspaces.schedule_deletion(context.workspace_id, context.user_id)
    if scheduled is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=PURGING)
    _log.info(
        "A workspace deletion was scheduled.",
        extra={
            "event": "workspace.deletion.scheduled",
            "workspace_id": context.workspace_id,
            "actor": context.user_id,
            "role": context.role,
            "purge_after": scheduled.purge_after.isoformat() if scheduled.purge_after else None,
            "repeat": already,
            **auth_strength_of(request).as_log(),
        },
    )
    if not already:
        audit.record(
            repositories,
            context,
            "workspace.deletion_scheduled",
            target_type="workspace",
            target_id=scheduled.id,
            target_label=scheduled.name,
            after={"purge_after": scheduled.purge_after.isoformat() if scheduled.purge_after else None},
        )
        _notify_admins(repositories, scheduled, context.user_id, cancelled=False)
    return WorkspaceRead.from_row(scheduled, context.role)


@router.delete("/{workspace_id}/deletion", response_model=WorkspaceRead)
def cancel_workspace_deletion(
    request: Request,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> WorkspaceRead:
    """Cancel a scheduled deletion while the grace period lasts. Idempotent when none is scheduled."""
    refuse_api_key_actor(context)
    existing = repositories.workspaces.get(context.workspace_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    cancelled = repositories.workspaces.cancel_deletion(context.workspace_id)
    if cancelled is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=PURGING)
    if existing.purge_after is not None:
        _log.info(
            "A workspace deletion was cancelled.",
            extra={
                "event": "workspace.deletion.cancelled",
                "workspace_id": context.workspace_id,
                "actor": context.user_id,
                "role": context.role,
                **auth_strength_of(request).as_log(),
            },
        )
        audit.record(
            repositories,
            context,
            "workspace.deletion_cancelled",
            target_type="workspace",
            target_id=cancelled.id,
            target_label=cancelled.name,
            before={"purge_after": existing.purge_after.isoformat()},
        )
        _notify_admins(repositories, cancelled, context.user_id, cancelled=True)
    return WorkspaceRead.from_row(cancelled, context.role)


@router.get("/{workspace_id}/members", response_model=MemberListRead)
def list_members(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> MemberListRead:
    """Everyone in the workspace, joined with their user rows for display."""
    return workspace_members.list_members(repositories, context)


@router.patch("/{workspace_id}/members/{user_id}", response_model=MemberRead)
def update_member(
    payload: MemberUpdate,
    user_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> MemberRead:
    """Change a member's workspace role.

    Only an owner may grant or remove ownership, and the last owner cannot be
    demoted, which is the same invariant that stops them being removed.
    """
    return workspace_members.update_member_role(repositories, context, user_id, payload)


@router.delete("/{workspace_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(
    user_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Remove a member, or leave the workspace yourself.

    Declared at read level because leaving is something any member may do; an
    admin removing someone else is checked here instead of by the capability.
    """
    workspace_members.remove_member(repositories, context, user_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{workspace_id}/invites", response_model=InviteListRead)
def list_invites(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> InviteListRead:
    """Every outstanding invite, without any token."""
    return workspace_members.list_invites(repositories, context)


@router.post("/{workspace_id}/invites", response_model=InviteCreated, status_code=status.HTTP_201_CREATED)
def create_invite(
    payload: InviteCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> InviteCreated:
    """Store an invite, mail it, and return its token exactly once.

    Only the token's SHA-256 hash is stored, so this response is the only place
    the token is readable. It is still returned after the mail goes out, because
    the copy-link flow is what an admin falls back on when the address is one this
    environment cannot reach, and a failed send never fails the invite.
    """
    return workspace_members.create_invite(repositories, context, payload)


@router.delete("/{workspace_id}/invites/{invite_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_invite(
    invite_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Revoke an invite before it is accepted."""
    workspace_members.revoke_invite(repositories, context, invite_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@invites_router.post("/accept", response_model=MemberRead, status_code=status.HTTP_201_CREATED)
def accept_invite(
    payload: InviteAccept,
    request: Request,
    subject: Annotated[str, Depends(caller_subject)],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> MemberRead:
    """Turn a token into a membership, idempotently for an existing member.

    The token is looked up by hash, so no route in this product ever holds a
    readable invite token. An expired or unknown token answers the same error, so
    the response cannot tell one from the other. The token alone is not enough:
    the caller's verified address must be the one the invite was sent to, so a
    forwarded or leaked link cannot join anyone else at the invited role.

    The membership takes its plan slot, and the invite gives back its pending one,
    in the same transaction as the two rows, so racing accepts at the last slot
    land one member and refuse the rest.
    """
    refuse_deleted_caller(repositories, subject)
    invite = repositories.invites.get_by_token_hash(hash_token(payload.token.strip()))
    if invite is None or invite.is_expired():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=INVALID_INVITE)

    caller = repositories.users.get(subject)
    if caller is None or not caller.email_verified or caller.email_lower != invite.email.strip().lower():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=INVITE_EMAIL_MISMATCH)

    existing = repositories.memberships.get(invite.workspace_id, subject)
    if existing is not None:
        plan_usage.delete_invite(repositories, invite.workspace_id, invite.invite_id)
        return MemberRead.from_rows(existing, repositories.users.get(subject))

    membership = Membership(
        workspace_id=invite.workspace_id,
        member_key=workspace_member_key(subject),
        user_id=subject,
        role=invite.role,
    )
    guest = plan_usage.guest_share(invite.role)
    try:
        plan_usage.commit(
            repositories,
            invite.workspace_id,
            [
                repositories.memberships.create_action(membership),
                repositories.invites.delete_live_action(invite.workspace_id, invite.invite_id),
            ],
            [
                plan_usage.Delta(LimitedResource.MEMBERS, 1, guest),
                plan_usage.Delta(LimitedResource.INVITES, -1, -guest),
            ],
            guests=plan_usage.GuestRule() if guest else None,
        )
    except TransactionCanceled as exc:
        current = repositories.memberships.get_consistent(invite.workspace_id, subject)
        if current is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=INVALID_INVITE) from exc
        plan_usage.delete_invite(repositories, invite.workspace_id, invite.invite_id)
        return MemberRead.from_rows(current, repositories.users.get(subject))
    sync_seats(repositories, invite.workspace_id)
    audit.record(
        repositories,
        request_context(request, invite.workspace_id, subject, invite.role),
        "member.joined",
        target_type="member",
        target_id=subject,
        target_label=display_name_for(caller),
        after={"role": invite.role, "invite_id": invite.invite_id},
    )
    return MemberRead.from_rows(membership, repositories.users.get(subject))
