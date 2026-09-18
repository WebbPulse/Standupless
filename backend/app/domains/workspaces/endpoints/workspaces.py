"""The workspace routes: the tenant itself, its members and its invites.

Every route but the two that have no workspace in their path goes through
`require(...)` in `app.common.api.dependencies.authz`, which is the only place a
role is compared. A caller outside a workspace gets a 404 on everything inside
it, never a 403, so the routes themselves never have to remember that rule.
"""

from __future__ import annotations

from typing import Annotated, Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Path, Response, status
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import (
    AuthzContext,
    Capability,
    caller_subject,
    require,
)
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.invites import (
    Invite,
    default_expiry,
    hash_token,
    new_invite_id,
    new_invite_token,
)
from app.common.db.dynamo.memberships import Membership, workspace_member_key
from app.common.db.dynamo.workspaces import Workspace, new_workspace_id
from app.domains.workspaces.schemas.workspace import (
    InviteAccept,
    InviteCreate,
    InviteCreated,
    InviteListRead,
    InviteRead,
    MemberListRead,
    MemberRead,
    MemberUpdate,
    WorkspaceCreate,
    WorkspaceListRead,
    WorkspaceRead,
    WorkspaceUpdate,
)

router = APIRouter()

invites_router = APIRouter()

SLUG_TAKEN = {"error_code": "CONFLICT", "message": "That workspace slug is taken"}

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

LAST_OWNER = {"error_code": "CONFLICT", "message": "A workspace must keep one owner"}

OWNER_ONLY = {"error_code": "FORBIDDEN", "message": "Only an owner may grant or remove ownership"}

INVALID_INVITE = {"error_code": "INVALID_INVITE", "message": "That invite is not valid"}


@router.get("/health", include_in_schema=False)
def health() -> Dict[str, Any]:
    """Liveness for this domain, reading nothing."""
    return {"status": "healthy", "domain": "workspaces"}


@router.get("", response_model=WorkspaceListRead)
def list_workspaces(
    subject: Annotated[str, Depends(caller_subject)],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> WorkspaceListRead:
    """Every workspace the caller is a member of, with their role on each.

    Read through the memberships user index rather than an owner field, so a
    member who does not own the workspace still sees it.
    """
    memberships = repositories.memberships.list_workspaces_for_user(subject)
    if not memberships:
        return WorkspaceListRead(workspaces=[])

    roles = {membership.workspace_id: membership.role for membership in memberships}
    found = repositories.workspaces.get_many(list(roles))
    return WorkspaceListRead(
        workspaces=[
            WorkspaceRead.from_row(workspace, roles.get(workspace_id))
            for workspace_id, workspace in sorted(found.items())
        ]
    )


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
    """One workspace the caller belongs to, carrying their role."""
    workspace = repositories.workspaces.get(context.workspace_id)
    if workspace is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return WorkspaceRead.from_row(workspace, context.role)


@router.patch("/{workspace_id}", response_model=WorkspaceRead)
def update_workspace(
    payload: WorkspaceUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> WorkspaceRead:
    """Rename a workspace. The slug is fixed, so nothing else is editable."""
    if payload.name is None:
        workspace = repositories.workspaces.get(context.workspace_id)
    else:
        workspace = repositories.workspaces.rename(context.workspace_id, payload.name)
    if workspace is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return WorkspaceRead.from_row(workspace, context.role)


@router.delete("/{workspace_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workspace(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_OWNER))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Delete a workspace. Owner only, because it takes everything inside with it."""
    repositories.workspaces.delete(context.workspace_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{workspace_id}/members", response_model=MemberListRead)
def list_members(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> MemberListRead:
    """Everyone in the workspace, joined with their user rows for display."""
    memberships = repositories.memberships.list_members(context.workspace_id)
    users = repositories.users.get_many([membership.user_id for membership in memberships])
    return MemberListRead(members=[MemberRead.from_rows(m, users.get(m.user_id)) for m in memberships])


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
    existing = repositories.memberships.get(context.workspace_id, user_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)

    touches_ownership = payload.role == "owner" or existing.role == "owner"
    if touches_ownership and context.role != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=OWNER_ONLY)

    if existing.role == "owner" and payload.role != "owner":
        if repositories.memberships.count_owners(context.workspace_id) <= 1:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=LAST_OWNER)

    updated = repositories.memberships.set_role(context.workspace_id, user_id, payload.role)
    if updated is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return MemberRead.from_rows(updated, repositories.users.get(user_id))


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
    if user_id != context.user_id and not context.is_workspace_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=OWNER_ONLY)

    existing = repositories.memberships.get(context.workspace_id, user_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)

    if existing.role == "owner" and repositories.memberships.count_owners(context.workspace_id) <= 1:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=LAST_OWNER)

    repositories.memberships.delete(context.workspace_id, user_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{workspace_id}/invites", response_model=InviteListRead)
def list_invites(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> InviteListRead:
    """Every outstanding invite, without any token."""
    invites = repositories.invites.list_for_workspace(context.workspace_id)
    return InviteListRead(invites=[InviteRead.from_row(invite) for invite in invites])


@router.post("/{workspace_id}/invites", response_model=InviteCreated, status_code=status.HTTP_201_CREATED)
def create_invite(
    payload: InviteCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> InviteCreated:
    """Store an invite and return its token exactly once.

    Only the token's SHA-256 hash is stored, so this response is the only place
    the token is readable. Nothing is mailed: delivery arrives with SES, and until
    then the caller passes the token on itself.
    """
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
    return InviteCreated.from_created(created, token)


@router.delete("/{workspace_id}/invites/{invite_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_invite(
    invite_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Revoke an invite before it is accepted."""
    repositories.invites.delete(context.workspace_id, invite_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@invites_router.post("/accept", response_model=MemberRead, status_code=status.HTTP_201_CREATED)
def accept_invite(
    payload: InviteAccept,
    subject: Annotated[str, Depends(caller_subject)],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> MemberRead:
    """Turn a token into a membership, idempotently for an existing member.

    The token is looked up by hash, so no route in this product ever holds a
    readable invite token. An expired or unknown token answers the same error, so
    the response cannot tell one from the other.
    """
    invite = repositories.invites.get_by_token_hash(hash_token(payload.token.strip()))
    if invite is None or invite.is_expired():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=INVALID_INVITE)

    existing = repositories.memberships.get(invite.workspace_id, subject)
    if existing is not None:
        repositories.invites.delete(invite.workspace_id, invite.invite_id)
        return MemberRead.from_rows(existing, repositories.users.get(subject))

    membership = repositories.memberships.put(
        Membership(
            workspace_id=invite.workspace_id,
            member_key=workspace_member_key(subject),
            user_id=subject,
            role=invite.role,
        )
    )
    repositories.invites.delete(invite.workspace_id, invite.invite_id)
    return MemberRead.from_rows(membership, repositories.users.get(subject))
