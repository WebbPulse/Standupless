"""The workspace's reusable invite link: enable, reset and disable it, preview it, and join through it.

One link per workspace, minted by whoever may invite (the "who may invite" setting,
admins by default). Its token is 256 random bits, stored only as a SHA-256 hash, and
answered in readable form once, by the enable or reset call. Resetting mints a new
token and disabling deletes the row, so an old link stops working at once.

Joining through the link adds the caller as a member and is held to every rule a
member is: the plan's member cap, the workspace's authentication policy (required
single sign-on, allowed sign-in methods, a second factor), the directory's
deactivations and a suspension, which the link never lifts. An unknown, reset or
disabled token answers one generic error, and the preview and join routes sit in
their own rate limit class.
"""

from __future__ import annotations

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from webbpulse.dynamodb import TransactionCanceled

from app.common import audit, plan_usage
from app.common.api.dependencies.authz import (
    AuthzContext,
    Capability,
    auth_policy_refusal,
    caller_claims,
    refuse_delegated_claims,
    request_context,
    require,
)
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.workspaces import (
    InviteLinkCreated,
    InviteLinkPreview,
    InviteLinkRead,
    InviteLinkToken,
    MemberRead,
    display_name_for,
)
from app.common.billing import sync_seats
from app.common.db.dynamo.invites import hash_token, new_invite_token
from app.common.db.dynamo.memberships import InviteLink, Membership, workspace_member_key
from app.common.db.dynamo.workspaces import Workspace
from app.common.plan_limits import LimitedResource
from app.domains.workspaces.endpoints.workspaces import INVALID_INVITE, refuse_deleted_caller

router = APIRouter()

link_router = APIRouter()

MEMBER_SUSPENDED = {
    "error_code": "MEMBER_SUSPENDED",
    "message": "Your membership in this workspace is suspended. Ask an admin to reactivate it.",
}

EMAIL_NOT_VERIFIED = {
    "error_code": "EMAIL_NOT_VERIFIED",
    "message": "Verify your email address before joining a workspace.",
}


def _read(row: Optional[InviteLink]) -> InviteLinkRead:
    """The status shape of a stored link, or of a disabled one."""
    if row is None:
        return InviteLinkRead(enabled=False)
    return InviteLinkRead(enabled=True, created_by=row.created_by, created_at=row.created_at)


@router.get("/{workspace_id}/invite-link", response_model=InviteLinkRead)
def get_invite_link(
    context: Annotated[AuthzContext, Depends(require(Capability.INVITE_CREATE))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> InviteLinkRead:
    """Whether the workspace's invite link is on. The token itself is never read back."""
    return _read(repositories.memberships.get_invite_link(context.workspace_id))


@router.post("/{workspace_id}/invite-link", response_model=InviteLinkCreated, status_code=status.HTTP_201_CREATED)
def reset_invite_link(
    context: Annotated[AuthzContext, Depends(require(Capability.INVITE_CREATE))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> InviteLinkCreated:
    """Enable the invite link, or reset it to a new token so the old link stops working.

    The response carries the token once; afterwards only a reset can show a link again.
    """
    previous = repositories.memberships.get_invite_link(context.workspace_id)
    token = new_invite_token()
    row = repositories.memberships.put_invite_link(context.workspace_id, hash_token(token), created_by=context.user_id)
    audit.record(
        repositories,
        context,
        "invite_link.reset" if previous is not None else "invite_link.enabled",
        target_type="invite_link",
        target_id=context.workspace_id,
        target_label="Invite link",
    )
    return InviteLinkCreated(enabled=True, created_by=row.created_by, created_at=row.created_at, token=token)


@router.delete("/{workspace_id}/invite-link", status_code=status.HTTP_204_NO_CONTENT)
def disable_invite_link(
    context: Annotated[AuthzContext, Depends(require(Capability.INVITE_CREATE))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Disable the invite link. People who already joined through it stay members."""
    previous = repositories.memberships.get_invite_link(context.workspace_id)
    repositories.memberships.delete_invite_link(context.workspace_id)
    if previous is not None:
        audit.record(
            repositories,
            context,
            "invite_link.disabled",
            target_type="invite_link",
            target_id=context.workspace_id,
            target_label="Invite link",
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _resolve(repositories: Repositories, token: str) -> Workspace:
    """The live workspace a token opens, or the one generic 400 for any token that opens none."""
    row = repositories.memberships.find_invite_link(hash_token(token))
    workspace = repositories.workspaces.get(row.workspace_id) if row is not None else None
    if workspace is None or workspace.is_purging:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=INVALID_INVITE)
    return workspace


@link_router.post("/link/preview", response_model=InviteLinkPreview)
def preview_invite_link(
    payload: InviteLinkToken,
    claims: Annotated[Any, Depends(caller_claims)],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> InviteLinkPreview:
    """The workspace an invite link joins, for the join page to name before the caller joins."""
    refuse_delegated_claims(claims)
    subject = str(claims.get("sub", "")).strip()
    refuse_deleted_caller(repositories, subject)
    workspace = _resolve(repositories, payload.token)
    existing = repositories.memberships.get(workspace.id, subject)
    return InviteLinkPreview(
        workspace_id=workspace.id,
        name=workspace.name,
        slug=workspace.slug,
        already_member=existing is not None and not existing.is_suspended,
    )


@link_router.post("/link/join", response_model=MemberRead)
def join_invite_link(
    payload: InviteLinkToken,
    request: Request,
    response: Response,
    claims: Annotated[Any, Depends(caller_claims)],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> MemberRead:
    """Join a workspace as a member through its invite link.

    Answers 201 for a new membership and 200 for one that already existed. A
    suspended member is refused, and so is a session the workspace's
    authentication policy would refuse a member, so the link is never a way past
    required single sign-on. The membership takes its plan slot in the same
    transaction as its row, so racing joins at the last slot land one member.
    """
    from app.common import scim

    refuse_delegated_claims(claims)
    subject = str(claims.get("sub", "")).strip()
    refuse_deleted_caller(repositories, subject)
    workspace = _resolve(repositories, payload.token)
    workspace_id = workspace.id
    user = repositories.users.get(subject)
    existing = repositories.memberships.get_consistent(workspace_id, subject)
    if existing is not None and existing.is_suspended:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=MEMBER_SUSPENDED)
    if existing is not None:
        response.status_code = status.HTTP_200_OK
        return MemberRead.from_rows(existing, user)
    if user is None or not user.email_verified:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=EMAIL_NOT_VERIFIED)
    refusal = auth_policy_refusal(repositories, workspace_id, claims, role="member")
    if refusal is not None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=refusal.detail())
    directory_row = scim.refuse_deactivated(repositories, workspace_id, user)
    membership = Membership(
        workspace_id=workspace_id,
        member_key=workspace_member_key(subject),
        user_id=subject,
        role="member",
    )
    try:
        plan_usage.commit(
            repositories,
            workspace_id,
            [repositories.memberships.create_action(membership)],
            [plan_usage.Delta(LimitedResource.MEMBERS, 1)],
        )
    except TransactionCanceled:
        current = repositories.memberships.get_consistent(workspace_id, subject)
        if current is None:
            raise
        response.status_code = status.HTTP_200_OK
        return MemberRead.from_rows(current, user)
    sync_seats(repositories, workspace_id)
    scim.adopt(repositories, workspace_id, directory_row, subject)
    audit.record(
        repositories,
        request_context(request, workspace_id, subject, "member"),
        "member.joined",
        target_type="member",
        target_id=subject,
        target_label=display_name_for(user),
        after={"role": "member", "via": "invite_link"},
    )
    response.status_code = status.HTTP_201_CREATED
    return MemberRead.from_rows(membership, user)
