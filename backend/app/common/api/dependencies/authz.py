"""The one place a workspace or project authorization decision is made.

Every tenant-scoped route depends on `require(...)` naming the capability it
needs, and gets back an `AuthzContext`. Nothing else in the product reads a role
or compares a membership, so widening access is a one-line diff here rather than
a condition quietly missing from a route.

It fails closed at each step, in the order design section 2 fixes: the workspace
id comes from the path, claims that will not read are a 401, a missing membership
is a 404 on the workspace so a non-member cannot probe for existence, a guest on
a project route needs an explicit project membership, and only then is the
declared capability checked against the caller's role.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Iterable, Optional

from fastapi import Depends, HTTPException, Path, Request, status
from webbpulse.identity.claims import ClaimsUnavailable, read_authorizer_claims

from app.common.api.dependencies.repositories import RepositoryBundle, get_repositories
from app.common.db.dynamo.memberships import (
    PROJECT_ROLES,
    WORKSPACE_ROLES,
    Membership,
)

__all__ = [
    "IMPLIED_PROJECT_ROLE",
    "ActorKind",
    "AuthzContext",
    "Capability",
    "require",
    "require_workspace",
]

NOT_FOUND_DETAIL = {"error_code": "NOT_FOUND", "message": "Resource not found"}

FORBIDDEN_DETAIL = {"error_code": "FORBIDDEN", "message": "Not allowed"}

UNAUTHENTICATED_DETAIL = {"error_code": "NOT_AUTHENTICATED", "message": "Sign in first."}


class ActorKind(str, Enum):
    """How the caller authenticated, so an audit entry can say which path was used.

    An API key and an MCP token both resolve to the same `AuthzContext` as a user,
    which is what keeps a key from ever being broader than its minter.
    """

    USER = "user"
    API_KEY = "api_key"
    SERVICE = "service"


class Capability(str, Enum):
    """What a route needs, named rather than spelled as a role comparison.

    The names come from the capability table in design section 2, so a reviewer can
    read a route's declaration straight against that table.
    """

    WORKSPACE_READ = "workspace:read"
    WORKSPACE_ADMIN = "workspace:admin"
    WORKSPACE_OWNER = "workspace:owner"
    PROJECT_CREATE = "project:create"
    PROJECT_READ = "project:read"
    PROJECT_ADMIN = "project:admin"
    PROJECT_DELETE = "project:delete"


WORKSPACE_CAPABILITIES: dict[Capability, tuple[str, ...]] = {
    Capability.WORKSPACE_READ: ("owner", "admin", "member", "guest"),
    Capability.WORKSPACE_ADMIN: ("owner", "admin"),
    Capability.WORKSPACE_OWNER: ("owner",),
    Capability.PROJECT_CREATE: ("owner", "admin", "member"),
    Capability.PROJECT_READ: ("owner", "admin", "member", "guest"),
    Capability.PROJECT_ADMIN: ("owner", "admin", "member", "guest"),
    Capability.PROJECT_DELETE: ("owner", "admin"),
}
"""Which workspace roles may even attempt a capability.

`PROJECT_ADMIN` admits `member` and `guest` here because a project membership can
promote them; `_check_project` makes that second decision.
"""

PROJECT_SCOPED = frozenset({Capability.PROJECT_READ, Capability.PROJECT_ADMIN, Capability.PROJECT_DELETE})
"""Capabilities that need a project in the path and a guest's membership read."""

IMPLIED_PROJECT_ROLE: dict[str, str] = {"owner": "admin", "admin": "admin", "member": "member"}
"""The project role a workspace role carries without an explicit project membership.

The contract states this mapping for the `role` field on a `Project` response.
"""


@dataclass(frozen=True)
class AuthzContext:
    """Who is asking, where, and what they may do, resolved once per request.

    Routes read this instead of claims or memberships, so the tenant id a handler
    uses is always the one authorization was decided against.
    """

    workspace_id: str
    user_id: str
    role: str
    actor: ActorKind = ActorKind.USER
    project_id: Optional[str] = None
    project_role: Optional[str] = None
    project_ids: tuple[str, ...] = field(default_factory=tuple)
    scopes: tuple[str, ...] = field(default_factory=tuple)

    @property
    def is_guest(self) -> bool:
        """Whether the caller only reaches projects they are a member of."""
        return self.role == "guest"

    @property
    def is_workspace_admin(self) -> bool:
        """Whether the caller manages the workspace itself."""
        return self.role in ("owner", "admin")

    @property
    def is_project_admin(self) -> bool:
        """Whether the caller administers the project in the path."""
        if self.is_workspace_admin:
            return True
        return self.project_role == "admin"

    def can_see_project(self, project_id: str) -> bool:
        """Whether this caller may read one project of their workspace.

        A guest sees only the projects they hold a membership in; everyone else
        sees every project in the workspace.
        """
        if not self.is_guest:
            return True
        return project_id in self.project_ids


def _claims(request: Request) -> Any:
    """The authorizer's claims, or a 401.

    `ClaimsUnavailable` covers a missing request context, an unparseable one and a
    context with no claims section. All three mean the gateway did not authenticate
    this caller, so none of them may fall through to anonymous.
    """
    try:
        return read_authorizer_claims(request)
    except ClaimsUnavailable as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=UNAUTHENTICATED_DETAIL) from exc


def _subject(claims: Any) -> str:
    """The caller's user id, or a 401 when the claims carry no subject."""
    subject = str(claims.get("sub", "") or "").strip()
    if not subject:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=UNAUTHENTICATED_DETAIL)
    return subject


def _scopes(claims: Any) -> tuple[str, ...]:
    """The caller's scopes, already split from the `scope` string by `coerce_claims`."""
    raw = claims.get("scopes") or ()
    if isinstance(raw, str):
        return tuple(part for part in raw.split() if part)
    return tuple(str(scope) for scope in raw)


def _actor(claims: Any) -> ActorKind:
    """Which credential the caller presented, defaulting to an ordinary user."""
    kind = str(claims.get("actor", "") or "").strip()
    if kind == ActorKind.API_KEY.value:
        return ActorKind.API_KEY
    if kind == ActorKind.SERVICE.value:
        return ActorKind.SERVICE
    return ActorKind.USER


def _not_found() -> HTTPException:
    """The 404 a non-member and a guest outside a project both get.

    One helper because the two cases must be indistinguishable to the caller; a
    403 on either would confirm the resource exists.
    """
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND_DETAIL)


def _membership(repositories: RepositoryBundle, workspace_id: str, user_id: str) -> Membership:
    """The caller's workspace membership, or a 404 on the workspace itself."""
    membership = repositories.memberships.get(workspace_id, user_id)
    if membership is None or membership.role not in WORKSPACE_ROLES:
        raise _not_found()
    return membership


def _guest_project_ids(repositories: RepositoryBundle, workspace_id: str, user_id: str) -> tuple[str, ...]:
    """Every project a guest is explicitly a member of, in this workspace only."""
    memberships = repositories.memberships.list_project_memberships_for_user(workspace_id, user_id)
    return tuple(membership.project_id for membership in memberships if membership.project_id is not None)


def _check_project(
    repositories: RepositoryBundle,
    capability: Capability,
    workspace_id: str,
    user_id: str,
    role: str,
    project_id: str,
    project_ids: tuple[str, ...],
) -> Optional[str]:
    """Decide a project-scoped capability, answering the caller's project role.

    A guest with no membership in this project gets the same 404 a non-member gets
    on the workspace, so a guest cannot enumerate the projects they are outside.
    """
    if role == "guest" and project_id not in project_ids:
        raise _not_found()

    membership = repositories.memberships.get_project_membership(workspace_id, project_id, user_id)
    project_role = membership.role if membership is not None else None
    if project_role is not None and project_role not in PROJECT_ROLES:
        project_role = None
    if project_role is None:
        project_role = IMPLIED_PROJECT_ROLE.get(role)

    if capability is Capability.PROJECT_ADMIN and role not in ("owner", "admin"):
        if project_role != "admin":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=FORBIDDEN_DETAIL)

    return project_role


def require(
    capability: Capability,
    *,
    project_param: str = "project_id",
) -> Callable[..., AuthzContext]:
    """The dependency a tenant-scoped route declares, naming what it needs.

    Returns a FastAPI dependency resolving to an `AuthzContext`. A project-scoped
    capability additionally reads `project_param` from the path, which is why the
    parameter name is settable rather than assumed.
    """
    needs_project = capability in PROJECT_SCOPED

    def dependency(
        request: Request,
        workspace_id: str = Path(..., min_length=1),
        repositories: RepositoryBundle = Depends(get_repositories),
    ) -> AuthzContext:
        """Resolve the caller, their membership and the declared capability."""
        claims = _claims(request)
        user_id = _subject(claims)

        membership = _membership(repositories, workspace_id, user_id)
        role = membership.role

        allowed = WORKSPACE_CAPABILITIES[capability]
        if role not in allowed:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=FORBIDDEN_DETAIL)

        project_ids: tuple[str, ...] = ()
        if role == "guest":
            project_ids = _guest_project_ids(repositories, workspace_id, user_id)

        project_id: Optional[str] = None
        project_role: Optional[str] = None
        if needs_project:
            project_id = str(request.path_params.get(project_param, "") or "").strip()
            if not project_id:
                raise _not_found()
            project_role = _check_project(
                repositories, capability, workspace_id, user_id, role, project_id, project_ids
            )

        return AuthzContext(
            workspace_id=workspace_id,
            user_id=user_id,
            role=role,
            actor=_actor(claims),
            project_id=project_id,
            project_role=project_role,
            project_ids=project_ids,
            scopes=_scopes(claims),
        )

    dependency.__wrapped_capability__ = capability  # type: ignore[attr-defined]
    return dependency


def require_workspace(capability: Capability = Capability.WORKSPACE_READ) -> Callable[..., AuthzContext]:
    """A workspace-scoped dependency, the common case spelled shorter."""
    return require(capability)


def caller_subject(request: Request) -> str:
    """The signed in caller's user id for a route with no workspace in its path.

    `GET /api/workspaces` and `POST /api/invites/accept` authenticate without a
    tenant, so they cannot go through `require`, but they still must fail closed
    on claims that will not read.
    """
    return _subject(_claims(request))


def require_scopes_present(context: AuthzContext, required: Iterable[str]) -> None:
    """Hold that an API key context carries every scope a route needs.

    A user context is unrestricted, so only a key or a token narrows further; this
    keeps the intersection rule in one place for when M6 mints keys.
    """
    if context.actor is ActorKind.USER:
        return
    missing = sorted(set(required) - set(context.scopes))
    if missing:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error_code": "INSUFFICIENT_SCOPE",
                "message": f"Missing scope: {', '.join(missing)}",
            },
        )
