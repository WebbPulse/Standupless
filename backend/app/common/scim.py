"""Directory provisioning rules that the SCIM hooks and the join routes share.

A workspace's identity provider describes people and groups over SCIM, and this
module turns that description into Standupless state: a directory user stands for
one account, an active one holds a workspace membership, and a member of a linked
group holds a membership of that group's team. Deprovisioning undoes all of that
and also ends the person's sessions and revokes the keys they hold or minted in the
workspace, so a person the directory switched off cannot keep acting through a
token issued before.

The join routes read the same rows: a person the directory deactivated cannot walk
back in through single sign-on or an approved domain while that row says so.
"""

from __future__ import annotations

from typing import Any, Final, Mapping

from fastapi import HTTPException, status
from webbpulse.dynamodb import TransactionCanceled

from app.common import audit, plan_usage, sessions
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.workspaces import display_name_for
from app.common.billing import sync_seats
from app.common.db.dynamo.memberships import Membership, ScimMemberRow, ScimUserRow, workspace_member_key
from app.common.db.dynamo.users import User
from app.common.plan_limits import LimitedResource

SCIM_ACTOR_ID: Final = "scim"
"""The actor every directory change is recorded as, which the audit log filters on."""

SCIM_SOURCE: Final = "scim"

SCIM_TOKEN_KIND: Final = "scim"
"""The API key kind a SCIM bearer token is stored as, which nothing but the SCIM router accepts."""

DEACTIVATED: Final = {
    "error_code": "SCIM_DEACTIVATED",
    "message": "Your directory has deactivated your access to this workspace. Ask an admin to restore it.",
}

LAST_OWNER: Final = {
    "error_code": "LAST_OWNER",
    "message": "The directory cannot remove the workspace's last owner. Make someone else an owner first.",
}


def record(
    repositories: Repositories,
    workspace_id: str,
    event: str,
    *,
    target_type: str,
    target_id: str,
    target_label: str = "",
    before: Mapping[str, Any] | None = None,
    after: Mapping[str, Any] | None = None,
) -> None:
    """Record one change the directory made, attributed to SCIM rather than to a person."""
    audit.record_system(
        repositories,
        workspace_id,
        event,
        actor_id=SCIM_ACTOR_ID,
        source=SCIM_SOURCE,
        target_type=target_type,
        target_id=target_id,
        target_label=target_label,
        before=before,
        after=after,
    )


def directory_user_for(repositories: Repositories, workspace_id: str, user: User | None) -> ScimUserRow | None:
    """The directory row that stands for this account in the workspace, by link and then by email."""
    if user is None:
        return None
    memberships = repositories.memberships
    linked = memberships.list_scim_users(workspace_id, linked_user_id=user.id, limit=10)
    if linked:
        return linked[0]
    if not user.email_verified:
        return None
    by_email = memberships.list_scim_users(workspace_id, email_lower=user.email_lower, limit=10)
    return by_email[0] if by_email else None


def refuse_deactivated(repositories: Repositories, workspace_id: str, user: User | None) -> ScimUserRow | None:
    """Raise 403 when the directory deactivated this person, else answer their directory row if any.

    Only the join routes call this. An invite an admin sends by hand still works,
    because an admin choosing to let someone in outranks a stale directory row.
    """
    row = directory_user_for(repositories, workspace_id, user)
    if row is not None and not row.active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=DEACTIVATED)
    return row


def adopt(repositories: Repositories, workspace_id: str, row: ScimUserRow | None, user_id: str) -> None:
    """Link a directory row to the account that just joined, and give it the teams its groups grant."""
    if row is None or not row.active:
        return
    if row.linked_user_id != user_id:
        row = repositories.memberships.put_scim_user(row.model_copy(update={"linked_user_id": user_id}))
    apply_groups(repositories, workspace_id, row)


def account_for(repositories: Repositories, row: ScimUserRow) -> User | None:
    """The live, verified account a directory row stands for, or `None` while there is none."""
    user = repositories.users.get(row.linked_user_id) if row.linked_user_id else None
    if user is None and row.email_lower:
        user = repositories.users.get_by_email(row.email_lower)
    if user is None or user.disabled or user.is_deleted or not user.email_verified:
        return None
    if user.email_lower != row.email_lower and user.id != row.linked_user_id:
        return None
    return user


def grant(repositories: Repositories, workspace_id: str, row: ScimUserRow) -> ScimUserRow:
    """Give an active directory user their membership and teams, once their account exists.

    Answers the row, linked to the account when one was found. A person who has
    not signed up yet keeps an unlinked row, and their first sign in through the
    workspace's connection or approved domain adopts it.
    """
    user = account_for(repositories, row)
    if user is None:
        return row
    memberships = repositories.memberships
    if row.linked_user_id != user.id:
        row = memberships.put_scim_user(row.model_copy(update={"linked_user_id": user.id}))
    if memberships.get(workspace_id, user.id) is None:
        membership = Membership(
            workspace_id=workspace_id,
            member_key=workspace_member_key(user.id),
            user_id=user.id,
            role="member",
        )
        created = True
        try:
            plan_usage.commit(
                repositories,
                workspace_id,
                [memberships.create_action(membership)],
                [plan_usage.Delta(LimitedResource.MEMBERS, 1)],
            )
        except TransactionCanceled:
            if memberships.get_consistent(workspace_id, user.id) is None:
                raise
            created = False
        if created:
            sync_seats(repositories, workspace_id)
            record(
                repositories,
                workspace_id,
                "member.joined",
                target_type="member",
                target_id=user.id,
                target_label=display_name_for(user),
                after={"role": "member", "via": "scim"},
            )
    apply_groups(repositories, workspace_id, row)
    return row


def apply_groups(repositories: Repositories, workspace_id: str, row: ScimUserRow) -> None:
    """Give the person every team their linked groups name that they are not already on."""
    for member in repositories.memberships.list_scim_memberships_for_user(workspace_id, row.scim_id):
        apply_member(repositories, workspace_id, row, member)


def apply_member(repositories: Repositories, workspace_id: str, row: ScimUserRow, member: ScimMemberRow) -> None:
    """Add one directory member to their group's team, recording that SCIM made the membership.

    A team membership someone granted by hand is left as it is and not marked, so
    a later removal from the group never takes away access SCIM did not give.
    """
    if member.applied or not row.active or not row.linked_user_id:
        return
    memberships = repositories.memberships
    user_id = row.linked_user_id
    if memberships.get(workspace_id, user_id) is None:
        return
    team = repositories.teams.get(workspace_id, member.team_id)
    if team is None:
        return
    if memberships.get_team_membership(workspace_id, member.team_id, user_id) is not None:
        return
    memberships.set_team_role(workspace_id, member.team_id, user_id, "member")
    memberships.put_scim_member(member.model_copy(update={"applied": True}))
    record(
        repositories,
        workspace_id,
        "team_member.added",
        target_type="team_member",
        target_id=user_id,
        target_label=_label(repositories, user_id),
        after={"team_id": team.team_id, "team": team.name, "role": "member", "via": "scim"},
    )


def withdraw_member(repositories: Repositories, workspace_id: str, row: ScimUserRow, member: ScimMemberRow) -> None:
    """Take back a team membership SCIM gave, unless someone has since changed its role."""
    if not member.applied or not row.linked_user_id:
        return
    memberships = repositories.memberships
    user_id = row.linked_user_id
    current = memberships.get_team_membership(workspace_id, member.team_id, user_id)
    memberships.put_scim_member(member.model_copy(update={"applied": False}))
    if current is None or current.role != "member":
        return
    memberships.delete_team_membership(workspace_id, member.team_id, user_id)
    team = repositories.teams.get(workspace_id, member.team_id)
    record(
        repositories,
        workspace_id,
        "team_member.removed",
        target_type="team_member",
        target_id=user_id,
        target_label=_label(repositories, user_id),
        before={"team_id": member.team_id, "team": team.name if team is not None else "", "role": "member"},
    )


def subject_of(repositories: Repositories, row: ScimUserRow) -> str:
    """The account id a directory row acts on: its link, else the verified account with its address.

    A person who joined through an invite holds a membership the directory row was
    never linked to, and deprovisioning must still reach them.
    """
    if row.linked_user_id:
        return row.linked_user_id
    account = account_for(repositories, row)
    return account.id if account is not None else ""


def guard_last_owner(repositories: Repositories, workspace_id: str, row: ScimUserRow) -> None:
    """Refuse with 409 to deprovision the workspace's only owner, which would orphan it."""
    user_id = subject_of(repositories, row)
    if not user_id:
        return
    membership = repositories.memberships.get(workspace_id, user_id)
    if (
        membership is not None
        and membership.role == "owner"
        and repositories.memberships.count_owners(workspace_id) <= 1
    ):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=LAST_OWNER)


def remove_access(repositories: Repositories, workspace_id: str, row: ScimUserRow) -> None:
    """Deprovision a directory user: membership, teams, keys and every signed in session.

    The keys revoked are the person's own keys in this workspace and the workspace
    keys they minted there, because either would keep acting after they leave.
    SCIM tokens are left alone: they belong to the directory, not to the person.
    Sessions are ended account wide, since a refresh family is not tied to one
    workspace and the directory has said this person should be signed out.
    """
    for member in repositories.memberships.list_scim_memberships_for_user(workspace_id, row.scim_id):
        if member.applied:
            repositories.memberships.put_scim_member(member.model_copy(update={"applied": False}))
    user_id = subject_of(repositories, row)
    if not user_id:
        return
    existing = repositories.memberships.get(workspace_id, user_id)
    if existing is not None:
        plan_usage.remove_membership(repositories, workspace_id, user_id)
        sync_seats(repositories, workspace_id)
        record(
            repositories,
            workspace_id,
            "member.removed",
            target_type="member",
            target_id=user_id,
            target_label=_label(repositories, user_id),
            before={"role": existing.role},
            after={"via": "scim"},
        )
    for key in repositories.api_keys.list_for_tenant(workspace_id):
        if key.is_revoked or key.kind == SCIM_TOKEN_KIND:
            continue
        if key.user_id != user_id and key.created_by != user_id:
            continue
        if plan_usage.revoke_api_key(repositories, workspace_id, key.key_hash):
            record(
                repositories,
                workspace_id,
                "api_key.revoked",
                target_type="api_key",
                target_id=key.key_id,
                target_label=key.name,
                before={"kind": key.kind, "prefix": key.prefix},
                after={"via": "scim"},
            )
    from webbpulse.audit import SYSTEM_ACTOR

    from app.common.session_audit import Revoker

    sessions.revoke_refresh_families(
        user_id,
        revoker=Revoker(
            id=SCIM_ACTOR_ID,
            kind=SYSTEM_ACTOR.kind,
            source=SCIM_SOURCE,
            reason="directory_deprovisioned",
            workspace_ids=(workspace_id,),
        ),
    )


def _label(repositories: Repositories, user_id: str) -> str:
    """A person's display name for an audit target, or their id when the account is gone."""
    user = repositories.users.get(user_id)
    return display_name_for(user) if user is not None else user_id
