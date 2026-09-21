"""The one place a workspace or team authorization decision is made.

Every tenant-scoped route depends on `require(...)` naming the capability it
needs, and gets back an `AuthzContext`. Nothing else in the product reads a role
or compares a membership, so widening access is a one-line diff here rather than
a condition quietly missing from a route.

It fails closed at each step, in the order design section 2 fixes: the workspace
id comes from the path, claims that will not read are a 401, a missing membership
is a 404 on the workspace so a non-member cannot probe for existence, a guest on
a team route needs an explicit team membership, and only then is the
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

from app.common.api.dependencies.repositories import (
    RepositoryBundle,
    RepositoryNotInBundle,
    get_repositories,
    repositories_for,
)
from app.common.db.dynamo.memberships import (
    TEAM_ROLES,
    WORKSPACE_ROLES,
)

__all__ = [
    "IMPLIED_TEAM_ROLE",
    "ActorKind",
    "AuthzContext",
    "Capability",
    "bearer_claims_of",
    "live_scopes_for",
    "missing_scopes",
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
    TEAM_CREATE = "team:create"
    TEAM_READ = "team:read"
    TEAM_ADMIN = "team:admin"
    TEAM_DELETE = "team:delete"


WORKSPACE_CAPABILITIES: dict[Capability, tuple[str, ...]] = {
    Capability.WORKSPACE_READ: ("owner", "admin", "member", "guest"),
    Capability.WORKSPACE_ADMIN: ("owner", "admin"),
    Capability.WORKSPACE_OWNER: ("owner",),
    Capability.TEAM_CREATE: ("owner", "admin", "member"),
    Capability.TEAM_READ: ("owner", "admin", "member", "guest"),
    Capability.TEAM_ADMIN: ("owner", "admin", "member", "guest"),
    Capability.TEAM_DELETE: ("owner", "admin"),
}
"""Which workspace roles may even attempt a capability.

`TEAM_ADMIN` admits `member` and `guest` here because a team membership can
promote them; `_check_team` makes that second decision.
"""

TEAM_SCOPED = frozenset({Capability.TEAM_READ, Capability.TEAM_ADMIN, Capability.TEAM_DELETE})
"""Capabilities that need a team in the path and a guest's membership read."""

IMPLIED_TEAM_ROLE: dict[str, str] = {"owner": "admin", "admin": "admin", "member": "member"}
"""The team role a workspace role carries without an explicit team membership.

The contract states this mapping for the `role` field on a `Team` response.
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
    team_id: Optional[str] = None
    team_role: Optional[str] = None
    team_ids: tuple[str, ...] = field(default_factory=tuple)
    scopes: tuple[str, ...] = field(default_factory=tuple)

    @property
    def is_guest(self) -> bool:
        """Whether the caller only reaches teams they are a member of."""
        return self.role == "guest"

    @property
    def is_workspace_admin(self) -> bool:
        """Whether the caller manages the workspace itself."""
        return self.role in ("owner", "admin")

    @property
    def is_team_admin(self) -> bool:
        """Whether the caller administers the team in the path."""
        if self.is_workspace_admin:
            return True
        return self.team_role == "admin"

    def can_see_team(self, team_id: str) -> bool:
        """Whether this caller may read one team of their workspace.

        A guest sees only the teams they hold a membership in; everyone else
        sees every team in the workspace.
        """
        if not self.is_guest:
            return True
        return team_id in self.team_ids


def _claims(request: Request, repositories: RepositoryBundle | None = None) -> Any:
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

    `repositories` is the serving bundle when the caller already holds one, so the
    key verification reads through the same narrowed grants as the rest of the
    request rather than resolving the bundle a second time.
    """
    claims = identity_claims(request)
    if claims is not None:
        return claims

    key_claims = _api_key_claims(request, repositories)
    if key_claims is not None:
        return key_claims

    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=UNAUTHENTICATED_DETAIL)


def _api_key_claims(request: Request, repositories: RepositoryBundle | None = None) -> Any:
    """Claims for a presented API key, or `None` when none was presented.

    Verification is the package's `verify` over the package's own store, so the
    constant-time comparison, the revocation check, the expiry check and the
    storage are all the platform's rather than this product's.

    The scopes on the returned claims are the key's stored set, which is the
    ceiling. They are intersected with live membership in `require`, where the
    membership row has just been read, because that is the only place both halves
    of the intersection exist at once.

    The store is built over the serving bundle rather than constructed directly, so
    a domain without the `api_keys` grant cannot verify a key here. That domain
    answers `None`, which its caller turns into a 401, rather than reaching a table
    its IAM policy does not cover and failing with an AccessDenied in staging.

    `repositories` is passed by callers that already hold the bundle, and resolved
    from the application otherwise. Taking it explicitly is what lets a caller
    outside the dependency graph, such as the MCP endpoint, verify against the same
    narrowed bundle its routes use.

    Only the owning domain stamps `last_used_at`. `verify` stamps it on success
    through the store's `touch`, which the package writes best effort and swallows
    a botocore error from, but a read-only repository refuses with `ReadOnlyTable`
    rather than a client error and that refusal would surface as a 500. Every
    domain but `workspaces` holds `api_keys` read only, matching its IAM grant, so
    the bundle is asked whether it may write and `touch` is switched off where it
    may not. The grant costs the stamp rather than the request, and the stamp a
    key-minting domain writes is the one the settings page renders.
    """
    from webbpulse.identity.api_keys import claims_for_key, is_api_key, verify
    from webbpulse.identity.scopes import bearer_credential

    presented = bearer_credential(request)
    if not presented or not is_api_key(presented):
        return None

    bundle = repositories if repositories is not None else repositories_for(request)
    try:
        keys = bundle.api_keys
    except RepositoryNotInBundle:
        return None

    record = verify(presented, keys, touch=not bundle.is_read_only("api_keys"))
    if record is None:
        return None
    return claims_for_key(record)


def _mcp_token_claims(request: Request) -> Any:
    """Claims for a verified MCP access token, or `None` when none was presented.

    The one credential the gateway cannot hand over already verified. `ANY /api/mcp`
    carries `authorization_type = "NONE"` so the endpoint can answer the discovery
    challenge itself, which means no authorizer runs on it and the signature must be
    checked here. Verification is the identity package's JWKS verifier against the RFC
    8707 resource the token is bound to, so this product writes no JWT code.

    Only the MCP endpoint reaches this. Every other route is behind an authorizer, and a
    token verified here still carries a tenant claim and a scope claim, so it narrows the
    same way an API key does rather than reading as an unrestricted session.
    """
    from app.common.api.dependencies.identity_claims import verify_mcp_bearer_claims

    return verify_mcp_bearer_claims(request)


def _bearer_claims(request: Request, repositories: RepositoryBundle | None = None) -> Any:
    """The claims for a caller on a route no authorizer guards, or `None`.

    Three credentials in the order that costs least: the authorizer's own claims when one
    ran, then a presented API key against the stored hash, then an MCP access token
    against the issuer's published keys. The token is last because it is the only one that
    can reach the network, and the first two answer without one.
    """
    claims = identity_claims(request)
    if claims is not None:
        return claims
    key_claims = _api_key_claims(request, repositories)
    if key_claims is not None:
        return key_claims
    return _mcp_token_claims(request)


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
    """The 404 a non-member and a guest outside a team both get.

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


def _guest_team_ids(repositories: RepositoryBundle, workspace_id: str, user_id: str) -> tuple[str, ...]:
    """Every team a guest is explicitly a member of, in this workspace only."""
    memberships = repositories.memberships.list_team_memberships_for_user(workspace_id, user_id)
    return tuple(membership.team_id for membership in memberships if membership.team_id is not None)


def _check_team(
    repositories: RepositoryBundle,
    capability: Capability,
    workspace_id: str,
    user_id: str,
    role: str,
    team_id: str,
    team_ids: tuple[str, ...],
) -> Optional[str]:
    """Decide a team-scoped capability, answering the caller's team role.

    A guest with no membership in this team gets the same 404 a non-member gets
    on the workspace, so a guest cannot enumerate the teams they are outside.
    """
    if role == "guest" and team_id not in team_ids:
        raise _not_found()

    membership = repositories.memberships.get_team_membership(workspace_id, team_id, user_id)
    team_role = membership.role if membership is not None else None
    if team_role is not None and team_role not in TEAM_ROLES:
        team_role = None
    if team_role is None:
        team_role = IMPLIED_TEAM_ROLE.get(role)

    if capability is Capability.TEAM_ADMIN and role not in ("owner", "admin"):
        if team_role != "admin":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=FORBIDDEN_DETAIL)

    return team_role


def require(
    capability: Capability,
    *,
    team_param: str = "team_id",
) -> Callable[..., AuthzContext]:
    """The dependency a tenant-scoped route declares, naming what it needs.

    Returns a FastAPI dependency resolving to an `AuthzContext`. A team-scoped
    capability additionally reads `team_param` from the path, which is why the
    parameter name is settable rather than assumed.
    """
    needs_team = capability in TEAM_SCOPED

    def dependency(
        request: Request,
        workspace_id: str = Path(..., min_length=1),
        repositories: RepositoryBundle = Depends(get_repositories),
    ) -> AuthzContext:
        """Resolve the caller, their membership and the declared capability."""
        claims = _claims(request, repositories)
        user_id = _subject(claims)
        _check_tenant_binding(claims, workspace_id)

        role = _membership_role(repositories, workspace_id, user_id)

        allowed = WORKSPACE_CAPABILITIES[capability]
        if role not in allowed:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=FORBIDDEN_DETAIL)

        team_ids: tuple[str, ...] = ()
        if role == "guest":
            team_ids = _guest_team_ids(repositories, workspace_id, user_id)

        actor = _actor(claims)
        scopes = _scopes(claims)
        if actor is not ActorKind.USER:
            scopes = effective_scopes(scopes, live_scopes_for(role, user_id))

        team_id: Optional[str] = None
        team_role: Optional[str] = None
        if needs_team:
            team_id = str(request.path_params.get(team_param, "") or "").strip()
            if not team_id:
                raise _not_found()
            team_role = _check_team(
                repositories, capability, workspace_id, user_id, role, team_id, team_ids
            )

        context = AuthzContext(
            workspace_id=workspace_id,
            user_id=user_id,
            role=role,
            actor=actor,
            team_id=team_id,
            team_role=team_role,
            team_ids=team_ids,
            scopes=scopes,
        )
        _enforce_route_scopes(request, context)
        return context

    dependency.__wrapped_capability__ = capability  # type: ignore[attr-defined]
    return dependency


def resolve_context(
    request: Request,
    repositories: RepositoryBundle,
    workspace_id: str,
    claims: Any = None,
) -> Optional[AuthzContext]:
    """The same `AuthzContext` `require` builds, for a caller with no workspace path.

    The MCP endpoint takes its workspace from the token's own tenant claim rather
    than from a path, because there is no path to put one in: consent bound the
    token to exactly one workspace. That is the only difference, so this shares
    every other step with `require` rather than reimplementing it, which is what
    keeps the project's claim of one authorization path true.

    Answers `None` rather than raising for every refusal, because the caller must
    turn a refusal into a challenge response rather than an exception, and it must
    not be able to tell an unknown credential from a valid one whose membership has
    gone.

    `claims` is the already-resolved credential when the caller read one to learn the
    workspace id, which is what keeps an MCP token from being verified against the
    issuer's key set twice for one request.
    """
    if claims is None:
        claims = _bearer_claims(request, repositories)
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

    team_ids: tuple[str, ...] = ()
    if role == "guest":
        team_ids = _guest_team_ids(repositories, workspace_id, user_id)

    actor = _actor(claims)
    scopes = _scopes(claims)
    if actor is not ActorKind.USER:
        scopes = effective_scopes(scopes, live_scopes_for(role, user_id))

    return AuthzContext(
        workspace_id=workspace_id,
        user_id=user_id,
        role=role,
        actor=actor,
        team_ids=team_ids,
        scopes=scopes,
    )


def bearer_claims_of(request: Request, repositories: RepositoryBundle | None = None) -> Any:
    """The resolved claims for a caller on an unguarded route, or `None`.

    Exported for the MCP endpoint, which reads the workspace out of the claims and then
    authorizes against it. Resolving once and passing the result on is what keeps the
    token's signature check to one per request.
    """
    return _bearer_claims(request, repositories)


def tenant_claim_of(request: Request, repositories: RepositoryBundle | None = None) -> str:
    """The workspace a tenant-bound credential names, or empty for a session token.

    The MCP endpoint reads this to learn which workspace to authorize in, because
    its route has no workspace in the path. A session token carries no tenant claim
    and answers empty, which that endpoint then refuses: a browser session has no
    business calling tools.
    """
    claims = _bearer_claims(request, repositories)
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


def missing_scopes(scopes: Iterable[str], required: Iterable[str]) -> list[str]:
    """Which of the required scopes a credential does not carry, sorted.

    The one comparison both enforcement paths run. The REST path calls it through
    `require_scopes_present`, which exempts a session first; the MCP endpoint calls
    it directly, because a session reaching that endpoint must carry scopes too.
    """
    return sorted(set(required) - set(scopes))


def require_scopes_present(context: AuthzContext, required: Iterable[str]) -> None:
    """Hold that an API key context carries every scope a route needs.

    A user context is unrestricted, so only a key or a token narrows further; this
    keeps the intersection rule in one place.
    """
    if context.actor is ActorKind.USER:
        return
    missing = missing_scopes(context.scopes, required)
    if missing:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error_code": "INSUFFICIENT_SCOPE",
                "message": f"Missing scope: {', '.join(missing)}",
            },
        )


def _enforce_route_scopes(request: Request, context: AuthzContext) -> None:
    """Refuse a narrowed credential that the matched route's scopes do not cover.

    Runs for an API key and an MCP token alone: a session is unrestricted, which is
    what keeps a browser login unaffected by the scope system.

    The route is read from the request rather than declared at each call site, so
    the scope a route needs is recorded once in `ROUTE_SCOPES` instead of in forty
    hand-written checks that could each be forgotten. A route the table does not
    name refuses every key, so forgetting one denies access rather than granting
    it.
    """
    if context.actor is ActorKind.USER:
        return

    from app.common.api.dependencies.scopes import scopes_for_route

    route = request.scope.get("route")
    required = scopes_for_route(request.method, getattr(route, "path", None))
    if not required:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error_code": "INSUFFICIENT_SCOPE",
                "message": "This route is not reachable with an API key or a token.",
            },
        )
    require_scopes_present(context, required)


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
