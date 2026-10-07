"""Plan-tier rate limits: who a request counts against, and how much each plan allows.

The shared `webbpulse.ratelimit.TieredRateLimiter` does the counting. This module
supplies the two halves it leaves to the product: the resolver that names a
request's verified token, person and workspace together with the workspace's
plan, and the map from each billing plan to its quotas.

Every number is an abuse ceiling rather than a product cap. A person or a
credential gets the same allowance on every plan, set well above what a browser,
the CLI or an agent does in normal use. Only the workspace aggregate scales with
the plan, because it tracks the plan's seat ceiling: ten members on Free, a
thousand on Standard, more on Business. While billing is off nobody can upgrade,
so Free gets Standard's aggregate, as `plan_limits` does for its preview limits.

The resolver names only identities that are already verified. A session's `sub`
comes from the gateway authorizer. An API key is checked against its stored hash
and an MCP token against the issuer's keys, both without side effects, and both
name the one workspace they are bound to. A session counts against a workspace
only after a membership read, so nobody can spend another workspace's aggregate by
naming its id in a path. Plans, memberships and verified keys are cached in process
for a minute, so a busy caller costs the counter writes and almost nothing else.
"""

from __future__ import annotations

import hashlib
import re
import threading
import time
from collections import OrderedDict
from typing import Any, Callable, Generic, Optional, TypeVar

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from webbpulse.ratelimit import PlanLimits, Quota, RateLimitSubject, ScopeLimits, TieredLimits

from app.common.core.config import settings
from app.common.db.dynamo.workspaces import DEFAULT_PLAN, Plan

AUTH_LIMIT_CLASS = "auth"

MCP_PATH = "/api/mcp"

WORKSPACE_PATH = re.compile(r"^/api/workspaces/([^/]+)")

CACHE_SECONDS = 60.0

CACHE_SIZE = 4096

USER_LIMITS = ScopeLimits(read=Quota(per_minute=1200), write=Quota(per_minute=300))
"""One person on any plan: 20 reads and 5 writes a second, sustained for a minute."""

TOKEN_LIMITS = ScopeLimits(read=Quota(per_minute=1200), write=Quota(per_minute=600))
"""One API key or MCP grant on any plan. Writes run higher than a person's, for imports."""

FREE_TENANT_PER_MINUTE = 3_000
STANDARD_TENANT_PER_MINUTE = 30_000
BUSINESS_TENANT_PER_MINUTE = 60_000

TENANT_PER_MINUTE: dict[str, int] = {
    Plan.FREE: FREE_TENANT_PER_MINUTE,
    Plan.STANDARD: STANDARD_TENANT_PER_MINUTE,
    Plan.BUSINESS: BUSINESS_TENANT_PER_MINUTE,
}
"""Each plan's workspace aggregate, reads and writes together, scaled to its seat ceiling."""

PREVIEW_FREE_TENANT_PER_MINUTE = STANDARD_TENANT_PER_MINUTE
"""The free plan's aggregate while billing is off and nobody can upgrade."""

K = TypeVar("K")
V = TypeVar("V")


class _TtlCache(Generic[K, V]):
    """A small thread-safe LRU whose entries expire after `CACHE_SECONDS`."""

    def __init__(
        self, *, size: int = CACHE_SIZE, ttl: float = CACHE_SECONDS, clock: Callable[[], float] = time.monotonic
    ) -> None:
        """Hold up to `size` entries for `ttl` seconds each."""
        self._entries: OrderedDict[K, tuple[float, V]] = OrderedDict()
        self._size = size
        self._ttl = ttl
        self._clock = clock
        self._lock = threading.Lock()

    def get(self, key: K) -> tuple[bool, Optional[V]]:
        """Whether `key` holds a live entry, and its value."""
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return False, None
            if entry[0] <= self._clock():
                del self._entries[key]
                return False, None
            self._entries.move_to_end(key)
            return True, entry[1]

    def put(self, key: K, value: V) -> None:
        """Store `value` under `key`, evicting the least recently used past the size."""
        with self._lock:
            self._entries[key] = (self._clock() + self._ttl, value)
            self._entries.move_to_end(key)
            while len(self._entries) > self._size:
                self._entries.popitem(last=False)

    def clear(self) -> None:
        """Forget every entry. For tests."""
        with self._lock:
            self._entries.clear()


_plans: _TtlCache[str, str] = _TtlCache()
_members: _TtlCache[tuple[str, str], bool] = _TtlCache()
_keys: _TtlCache[str, Optional[tuple[str, str]]] = _TtlCache()


def reset_caches() -> None:
    """Drop every cached plan, membership and key. For tests."""
    _plans.clear()
    _members.clear()
    _keys.clear()


def plan_limits() -> dict[str, PlanLimits]:
    """Every plan's limits as they apply right now, the preview aggregate included."""
    previewing = not settings.BILLING_ENABLED
    limits: dict[str, PlanLimits] = {}
    for plan, per_minute in TENANT_PER_MINUTE.items():
        if previewing and plan == DEFAULT_PLAN:
            per_minute = PREVIEW_FREE_TENANT_PER_MINUTE
        limits[plan] = PlanLimits(
            token=TOKEN_LIMITS,
            user=USER_LIMITS,
            tenant=ScopeLimits.combined(Quota(per_minute=per_minute)),
        )
    return limits


def build_tiers() -> TieredLimits:
    """The tiered limits the middleware counts signed-in and credentialed callers by.

    The `auth` class stays per IP for everyone, so a signed-in caller cannot spend
    their generous allowance guessing at credential endpoints.
    """
    return TieredLimits(
        resolver=resolve_subject,
        plans=plan_limits(),
        default_plan=DEFAULT_PLAN,
        ip_classes=(AUTH_LIMIT_CLASS,),
    )


def path_workspace_id(path: str) -> str:
    """The workspace id a path names under `/api/workspaces/{workspace_id}`, or empty."""
    match = WORKSPACE_PATH.match(path)
    return match.group(1) if match else ""


async def resolve_subject(request: Request) -> RateLimitSubject | None:
    """Name the verified token, person and workspace this request counts against.

    `None` leaves the request on the per-IP classes, which is what an anonymous or
    unverifiable caller gets. Store reads run in the threadpool, so the event loop
    never waits on DynamoDB.
    """
    return await run_in_threadpool(_resolve_subject, request)


def _resolve_subject(request: Request) -> RateLimitSubject | None:
    """The synchronous resolver body, reading through the request's bundle."""
    from webbpulse.identity.api_keys import TENANT_CLAIM
    from webbpulse.identity.claims import identity_claims

    from app.common.api.dependencies.repositories import repositories_for

    repositories = repositories_for(request)
    claims = identity_claims(request)
    if claims is not None:
        subject = _str(claims.get("sub"))
        if not subject:
            return None
        bound = _str(claims.get(TENANT_CLAIM))
        if bound:
            return _bound_subject(repositories, f"grant:{_str(claims.get('client_id'))}:{subject}", bound)
        return _session_subject(repositories, subject, path_workspace_id(request.url.path))

    key = _verified_key(repositories, request)
    if key is not None:
        handle, tenant_id = key
        return _bound_subject(repositories, f"key:{handle}", tenant_id)

    if request.url.path.rstrip("/") == MCP_PATH:
        from app.common.api.dependencies.identity_claims import verify_mcp_bearer_claims

        mcp = verify_mcp_bearer_claims(request)
        if mcp is not None:
            subject = _str(mcp.get("sub"))
            bound = _str(mcp.get(TENANT_CLAIM))
            if subject and bound:
                return _bound_subject(repositories, f"mcp:{_str(mcp.get('client_id'))}:{subject}", bound)
    return None


def _session_subject(repositories: Any, user_id: str, workspace_id: str) -> RateLimitSubject:
    """A signed-in person, counted against the path's workspace only when they belong to it.

    A function without the membership or workspace grant counts the person alone.
    """
    from app.common.api.dependencies.repositories import RepositoryNotInBundle

    try:
        if workspace_id and _is_member(repositories, workspace_id, user_id):
            return RateLimitSubject(plan=_plan(repositories, workspace_id), tenant=workspace_id, user=user_id)
    except RepositoryNotInBundle:
        pass
    return RateLimitSubject(plan=DEFAULT_PLAN, user=user_id)


def _bound_subject(repositories: Any, token: str, tenant_id: str) -> RateLimitSubject:
    """A credential bound to one workspace, counted against that workspace whatever the path says.

    The binding is the credential's own and already verified, so no membership read is
    needed to trust it. The person behind the key keeps their own allowance for their
    browser, so a busy integration never locks its owner out.
    """
    return RateLimitSubject(plan=_plan(repositories, tenant_id), tenant=tenant_id, token=token)


def _plan(repositories: Any, workspace_id: str) -> str:
    """The workspace's plan, cached, falling back to the default for a missing workspace."""
    from app.common.plan_limits import plan_of

    hit, cached = _plans.get(workspace_id)
    if hit and cached is not None:
        return cached
    plan = plan_of(repositories.workspaces.get(workspace_id))
    _plans.put(workspace_id, plan)
    return plan


def _is_member(repositories: Any, workspace_id: str, user_id: str) -> bool:
    """Whether the person holds any workspace role here, guests included, cached."""
    from app.common.db.dynamo.memberships import WORKSPACE_ROLES

    hit, cached = _members.get((workspace_id, user_id))
    if hit and cached is not None:
        return cached
    membership = repositories.memberships.get(workspace_id, user_id)
    member = membership is not None and membership.role in WORKSPACE_ROLES
    _members.put((workspace_id, user_id), member)
    return member


def _verified_key(repositories: Any, request: Request) -> tuple[str, str] | None:
    """The presented API key's revoke handle and workspace, or `None`.

    Verified without stamping `last_used_at`, since the route verifies it again and
    owns that write. Cached by a hash of the presented value, never the value itself.
    """
    from webbpulse.identity.api_keys import is_api_key, verify
    from webbpulse.identity.scopes import bearer_credential

    from app.common.api.dependencies.repositories import RepositoryNotInBundle

    presented = bearer_credential(request)
    if not presented or not is_api_key(presented):
        return None
    digest = hashlib.sha256(presented.encode()).hexdigest()
    hit, cached = _keys.get(digest)
    if hit:
        return cached
    try:
        store = repositories.api_keys
    except RepositoryNotInBundle:
        return None
    record = verify(presented, store, touch=False)
    resolved = (record.revoke_handle, record.tenant_id) if record is not None else None
    _keys.put(digest, resolved)
    return resolved


def _str(value: Any) -> str:
    """A claim value as a stripped string, empty for a missing one."""
    return str(value or "").strip()


__all__: list[str] = [
    "PREVIEW_FREE_TENANT_PER_MINUTE",
    "TENANT_PER_MINUTE",
    "TOKEN_LIMITS",
    "USER_LIMITS",
    "build_tiers",
    "path_workspace_id",
    "plan_limits",
    "reset_caches",
    "resolve_subject",
]
