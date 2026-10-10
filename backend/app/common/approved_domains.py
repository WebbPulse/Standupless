"""Approved email domains: joining a workspace without an invite, the rules both surfaces share.

An owner or admin approves a domain, and anyone whose verified email is on it may
join as a member, within the plan's member cap. The proof is the verified address
alone, which is enough because two rules close the obvious hole: an admin can only
approve a domain their own verified address is on, and public mail providers can
never be approved, so nobody can open a workspace to every Gmail user. DNS proof
arrives with SSO domain verification and hardens this later.

The workspaces routes and the MCP tools call these functions, so the two surfaces
cannot drift apart.
"""

from __future__ import annotations

import re
from typing import Optional

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.approved_domains import (
    ApprovedDomainListRead,
    ApprovedDomainRead,
    JoinableWorkspaceListRead,
    JoinableWorkspaceRead,
)
from app.common.api.schemas.workspaces import MemberRead
from app.common.billing import sync_seats
from app.common.db.dynamo.memberships import APPROVED_DOMAIN_LIMIT, Membership, workspace_member_key
from app.common.db.dynamo.users import User
from app.common.plan_limits import LimitedResource, enforce_limit

DOMAIN_PATTERN = re.compile(r"^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")

PUBLIC_EMAIL_PROVIDERS: frozenset[str] = frozenset(
    {
        "126.com",
        "163.com",
        "aol.com",
        "fastmail.com",
        "gmail.com",
        "gmx.com",
        "gmx.de",
        "gmx.net",
        "googlemail.com",
        "hey.com",
        "hotmail.co.uk",
        "hotmail.com",
        "hotmail.fr",
        "icloud.com",
        "live.com",
        "mac.com",
        "mail.com",
        "mail.ru",
        "me.com",
        "msn.com",
        "naver.com",
        "outlook.com",
        "pm.me",
        "proton.me",
        "protonmail.com",
        "qq.com",
        "tutanota.com",
        "web.de",
        "yahoo.co.uk",
        "yahoo.com",
        "yahoo.fr",
        "yandex.com",
        "yandex.ru",
        "ymail.com",
        "zoho.com",
    }
)
"""Mail providers anyone can sign up to, which no workspace may approve."""

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

INVALID_DOMAIN = {"error_code": "INVALID_DOMAIN", "message": "Enter a domain such as example.com"}

PUBLIC_DOMAIN = {
    "error_code": "PUBLIC_EMAIL_DOMAIN",
    "message": "Public email providers cannot be approved, because anyone can get an address there.",
}

DOMAIN_NOT_YOURS = {
    "error_code": "DOMAIN_NOT_VERIFIED",
    "message": "You can only approve the domain of your own verified email address.",
}

TOO_MANY_DOMAINS = {
    "error_code": "LIMIT_EXCEEDED",
    "message": f"A workspace can approve at most {APPROVED_DOMAIN_LIMIT} email domains.",
}


def normalize_domain(value: str) -> Optional[str]:
    """A domain lowercased, without a leading `@` or a trailing dot, or `None` when it is not one."""
    candidate = value.strip().lower().lstrip("@").rstrip(".")
    return candidate if DOMAIN_PATTERN.match(candidate) else None


def verified_domain(user: Optional[User]) -> Optional[str]:
    """The domain of a person's email, only while that email is verified."""
    if user is None or user.is_deleted or not user.email_verified:
        return None
    _, at, domain = user.email_lower.rpartition("@")
    return normalize_domain(domain) if at else None


def _not_found() -> HTTPException:
    """The 404 a workspace answers when the caller's domain may not join it."""
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)


def list_approved_domains(repositories: Repositories, context: AuthzContext) -> ApprovedDomainListRead:
    """Every approved domain of the caller's workspace."""
    rows = repositories.memberships.list_approved_domains(context.workspace_id)
    return ApprovedDomainListRead(domains=[ApprovedDomainRead.from_row(row) for row in rows])


def add_approved_domain(repositories: Repositories, context: AuthzContext, value: str) -> ApprovedDomainRead:
    """Approve one domain, which must be the caller's own verified domain and not a public provider."""
    domain = normalize_domain(value)
    if domain is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=INVALID_DOMAIN)
    if domain in PUBLIC_EMAIL_PROVIDERS:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=PUBLIC_DOMAIN)
    if verified_domain(repositories.users.get(context.user_id)) != domain:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=DOMAIN_NOT_YOURS)
    existing = repositories.memberships.list_approved_domains(context.workspace_id)
    if domain not in {row.domain for row in existing} and len(existing) >= APPROVED_DOMAIN_LIMIT:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=TOO_MANY_DOMAINS)
    row = repositories.memberships.add_approved_domain(context.workspace_id, domain, added_by=context.user_id)
    return ApprovedDomainRead.from_row(row)


def remove_approved_domain(repositories: Repositories, context: AuthzContext, value: str) -> str:
    """Stop approving one domain, answering the normalised domain. Idempotent."""
    domain = normalize_domain(value)
    if domain is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=INVALID_DOMAIN)
    repositories.memberships.remove_approved_domain(context.workspace_id, domain)
    return domain


def joinable_workspaces(repositories: Repositories, user_id: str) -> JoinableWorkspaceListRead:
    """The workspaces this person's verified domain may join and they are not already in."""
    domain = verified_domain(repositories.users.get(user_id))
    if domain is None:
        return JoinableWorkspaceListRead(workspaces=[])
    candidates = repositories.memberships.workspaces_approving_domain(domain)
    if not candidates:
        return JoinableWorkspaceListRead(workspaces=[])
    member_of = {row.workspace_id for row in repositories.memberships.list_workspaces_for_user(user_id)}
    found = repositories.workspaces.get_many([wid for wid in candidates if wid not in member_of])
    return JoinableWorkspaceListRead(
        workspaces=[
            JoinableWorkspaceRead.from_row(workspace, domain)
            for _, workspace in sorted(found.items())
            if not workspace.is_purging
        ]
    )


def join_by_domain(repositories: Repositories, user_id: str, workspace_id: str) -> tuple[MemberRead, bool]:
    """Join a workspace as a member through an approved domain, answering the membership and whether it is new.

    A workspace that does not approve the caller's verified domain answers the
    same 404 as one that does not exist, so the route reveals nothing about
    workspaces the caller cannot join. An existing member gets their membership
    back unchanged.
    """
    user = repositories.users.get(user_id)
    existing = repositories.memberships.get(workspace_id, user_id)
    if existing is not None:
        return MemberRead.from_rows(existing, user), False
    domain = verified_domain(user)
    workspace = repositories.workspaces.get(workspace_id)
    if (
        domain is None
        or workspace is None
        or workspace.is_purging
        or repositories.memberships.get_approved_domain(workspace_id, domain) is None
    ):
        raise _not_found()
    enforce_limit(repositories, workspace_id, LimitedResource.MEMBERS)
    membership = Membership(
        workspace_id=workspace_id,
        member_key=workspace_member_key(user_id),
        user_id=user_id,
        role="member",
    )
    try:
        repositories.memberships.create_unique(membership)
    except ConditionFailed:
        current = repositories.memberships.get(workspace_id, user_id)
        if current is None:
            raise
        return MemberRead.from_rows(current, user), False
    sync_seats(repositories, workspace_id)
    return MemberRead.from_rows(membership, user), True
