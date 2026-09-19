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
from webbpulse.identity.api_keys import ACTOR_CLAIM as API_KEY_ACTOR_CLAIM
from webbpulse.identity.api_keys import TENANT_CLAIM as API_KEY_TENANT_CLAIM
from webbpulse.identity.api_keys import effective_scopes
from webbpulse.identity.claims import identity_claims

from app.common.api.dependencies.repositories import RepositoryBundle, get_repositories
from app.common.db.dynamo.memberships import (
    PROJECT_ROLES,
    WORKSPACE_ROLES,
)

__all__ = [
    "IMPLIED_PROJECT_ROLE",
    "ActorKind",
    "AuthzContext",
    "Capability",
    "live_scopes_for",
    "refuse_api_key_actor",
    "require",
    "require_scopes_present",
    "resolve_context",
    "tenant_claim_of",
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
    """The verified claims for this request, from whichever credential arrived, or a 401.

    Three credential kinds land here and leave as one claims object.

    A user's access token and an MCP token are both JWTs the gateway already
    verified, and `identity_claims` reads the native authorizer's
    `authorizer.jwt.claims` and the staging gate's `authorizer.lambda` context
    alike. What tells them apart afterwards is only the `scope` claim the MCP token
    carries and the session token does not.

    An API key cannot verify at the gateway, because a JWT authorizer cannot verify
    something that is not a JWT. On a route the gate passed through on its prefix,
    or one declared unauthenticated, no claims arrive and the bearer is verified
    here instead, against the stored hash, and rendered into the same shape through
    the package's `claims_for_key`.

    `None` from every path is a 401 rather than a fallthrough to anonymous, which is
    the order design section 2 fixes.
    """
    claims = identity_claims(request)
    if claims is not None:
        return claims

    key_claims = _api_key_claims(request)
    if key_claims is not None:
        return key_claims

    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=UNAUTHENTICATED_DETAIL)


def _api_key_claims(request: Request) -> Any:
    """Claims for a presented API key, or `None` when none was presented.

    Verification is the package's `verify`, so the constant-time comparison, the
    revocation check and the expiry check are the ones the platform ships rather
    than three this product would have to keep in step.

    The scopes on the returned claims are the key's stored set, which is the
    ceiling. They are intersected with live membership in `require`, where the
    membership row has just been read, because that is the only place both halves
    of the intersection exist at once.
    """
    from webbpulse.identity.api_keys import claims_for_key, is_api_key, verify
    from webbpulse.identity.scopes import bearer_credential

    presented = bearer_credential(request)
    if not presented or not is_api_key(presented):
        return None

    from app.common.db.dynamo.api_keys import WorkspaceApiKeyStore

    record = verify(presented, WorkspaceApiKeyStore())
    if record is None:
        return None
    return claims_for_key(record)


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
    """Which credential the caller presented, defaulting to an ordinary user.

    Reads the product's own `actor` claim and the identity package's `actor_kind`,
    which is what `claims_for_key` stamps on a verified API key. A token carrying
    scopes but neither claim is an MCP token, which is a delegated credential and so
    an `API_KEY` actor: what matters downstream is that it narrows, not how it was
    minted.
    """
    kind = str(claims.get("actor", "") or claims.get(API_KEY_ACTOR_CLAIM, "") or "").strip()
    if kind == ActorKind.API_KEY.value:
        return ActorKind.API_KEY
    if kind == ActorKind.SERVICE.value:
        return ActorKind.SERVICE
    if _scopes(claims):
        return ActorKind.API_KEY
    return ActorKind.USER


def live_scopes_for(role: str, user_id: str) -> tuple[str, ...]:
    """Every scope a member of this role could delegate, as the intersection's live half.

    A key is a delegation, so this is the ceiling the stored set is cut down to on
    every request. A workspace key has no membership to read and intersects against
    the fixed service set instead, which keeps both kinds on one code path.

    Nothing here grants workspace administration. There is no scope for it, so no
    key and no token can ever reach a route that needs one, whatever its minter
    held.
    """
    from app.common.db.dynamo.api_keys import API_KEY_SCOPES, SERVICE_SCOPES, is_service_subject

    if is_service_subject(user_id):
        return SERVICE_SCOPES
    if role not in WORKSPACE_ROLES:
        return ()
    return API_KEY_SCOPES


def _check_tenant_binding(claims: Any, workspace_id: str) -> None:
    """Hold that a tenant-bound credential was bound to the workspace in the path.

    An API key and an MCP token each name one workspace and may never act in
    another. Without this check a key minted in workspace A would reach workspace B
    whenever its minter happened to be a member of both, which is precisely the
    cross-tenant reach a scoped credential exists to prevent.

    A session token carries no tenant claim and is unaffected: a person's authority
    is their membership, read fresh, in whichever workspace the path names.

    The refusal is the workspace's own 404 rather than a 403, so a key cannot be
    walked across workspace ids to learn which ones exist.
    """
    bound = str(claims.get(API_KEY_TENANT_CLAIM, "") or "").strip()
    if bound and bound != workspace_id:
        raise _not_found()


def _not_found() -> HTTPException:
    """The 404 a non-member and a guest outside a project both get.

    One helper because the two cases must be indistinguishable to the caller; a
    403 on either would confirm the resource exists.
    """
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND_DETAIL)


SERVICE_ROLE = "member"
"""The role a per-workspace key acts with, having no membership row to read.

Fixed at `member` rather than derived, because a workspace key acts as the
workspace instead of as a person. It is deliberately not an admin: a key that could
administer would be able to mint further keys, and the credential system would
become self-extending.
"""


def _role_for(repositories: RepositoryBundle, workspace_id: str, user_id: str) -> Optional[str]:
    """The role this subject holds in the workspace, or `None` if they hold none.

    A service principal has no membership row by construction, so it resolves to the
    fixed service role instead of a table read. Both callers go through here so the
    path a key authenticates on cannot drift from the path a session does, which was
    exactly the bug this replaced: the membership read rejected every workspace key
    before its scopes were ever consulted.
    """
    from app.common.db.dynamo.api_keys import is_service_subject

    if is_service_subject(user_id):
        return SERVICE_ROLE

    membership = repositories.memberships.get(workspace_id, user_id)
    if membership is None or membership.role not in WORKSPACE_ROLES:
        return None
    return membership.role


def _membership_role(repositories: RepositoryBundle, workspace_id: str, user_id: str) -> str:
    """The caller's role, or a 404 on the workspace itself."""
    role = _role_for(repositories, workspace_id, user_id)
    if role is None:
        raise _not_found()
    return role


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
        _check_tenant_binding(claims, workspace_id)

        role = _membership_role(repositories, workspace_id, user_id)

        allowed = WORKSPACE_CAPABILITIES[capability]
        if role not in allowed:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=FORBIDDEN_DETAIL)

        project_ids: tuple[str, ...] = ()
        if role == "guest":
            project_ids = _guest_project_ids(repositories, workspace_id, user_id)

        actor = _actor(claims)
        scopes = _scopes(claims)
        if actor is not ActorKind.USER:
            scopes = effective_scopes(scopes, live_scopes_for(role, user_id))

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
            actor=actor,
            project_id=project_id,
            project_role=project_role,
            project_ids=project_ids,
            scopes=scopes,
        )

    dependency.__wrapped_capability__ = capability  # type: ignore[attr-defined]
    return dependency


def resolve_context(
    request: Request,
    repositories: RepositoryBundle,
    workspace_id: str,
) -> Optional[AuthzContext]:
    """The same `AuthzContext` `require` builds, for a caller with no workspace path.

    The MCP endpoint takes its workspace from the token's own tenant claim rather
    than from a path, because there is no path to put one in: consent bound the
    token to exactly one workspace. That is the only difference, so this shares
    every other step with `require` rather than reimplementing it, which is what
    keeps the milestone's claim of one authorization path true.

    Answers `None` rather than raising for every refusal, because the caller must
    turn a refusal into a challenge response rather than an exception, and it must
    not be able to tell an unknown credential from a valid one whose membership has
    gone.
    """
    claims = identity_claims(request)
    if claims is None:
        claims = _api_key_claims(request)
    if claims is None:
        return None

    try:
        user_id = _subject(claims)
    except HTTPException:
        return None

    bound = str(claims.get(API_KEY_TENANT_CLAIM, "") or "").strip()
    if bound and bound != workspace_id:
        return None

    role = _role_for(repositories, workspace_id, user_id)
    if role is None:
        return None

    project_ids: tuple[str, ...] = ()
    if role == "guest":
        project_ids = _guest_project_ids(repositories, workspace_id, user_id)

    actor = _actor(claims)
    scopes = _scopes(claims)
    if actor is not ActorKind.USER:
        scopes = effective_scopes(scopes, live_scopes_for(role, user_id))

    return AuthzContext(
        workspace_id=workspace_id,
        user_id=user_id,
        role=role,
        actor=actor,
        project_ids=project_ids,
        scopes=scopes,
    )


def tenant_claim_of(request: Request) -> str:
    """The workspace a tenant-bound credential names, or empty for a session token.

    The MCP endpoint reads this to learn which workspace to authorize in, because
    its route has no workspace in the path. A session token carries no tenant claim
    and answers empty, which that endpoint then refuses: a browser session has no
    business calling tools.
    """
    claims = identity_claims(request)
    if claims is None:
        claims = _api_key_claims(request)
    if claims is None:
        return ""
    return str(claims.get(API_KEY_TENANT_CLAIM, "") or "").strip()


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


def refuse_api_key_actor(context: AuthzContext) -> None:
    """Refuse a route to anything but a signed-in person.

    Minting and revoking a credential is the one thing a credential may never do.
    A key that could mint its successor would make revoking the first one
    meaningless, and one that could revoke another would let a leaked key lock out
    the workspace it leaked from.

    The refusal is a 403 rather than a 401: the caller authenticated, and it is the
    verb that is refused, so a client that retries with a better token is doing the
    right thing.
    """
    if context.actor is ActorKind.USER:
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={
            "error_code": "API_KEY_ACTOR_REFUSED",
            "message": "This route needs a signed in person, not an API key or a token.",
        },
    )
