"""What this product adds to `webbpulse.composition`, and nothing the package owns.

The descriptor, the builder, the tracing gate, the startup secrets check, the
local authorizer, the repository scope and the entrypoint pair are all the
package's. What stays here is the part that is Standupless's: the descriptor's
defaults and table grants, the stderr log format with the log context filter,
the repository bundle built from this product's own registry, the team
reference and rate limit middleware, and the three root routes.

Both roots build through `build_domain_app`, so they cannot drift. Composition
is `include_router` and never `mount`, which would empty the OpenAPI document.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, AsyncIterator, Callable, Dict, Sequence, Tuple

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from webbpulse import composition
from webbpulse.composition import OTLP_ENDPOINT_ENV, check_secrets, local_authorizer, resolve_domains, scope_for
from webbpulse.http import DEFAULT_CORS_ALLOW_HEADERS

from app.common.core.config import settings

logger = logging.getLogger(__name__)

__all__ = [
    "API_PREFIX",
    "CORS_ALLOW_HEADERS",
    "OPENAPI_VERSION",
    "OTLP_ENDPOINT_ENV",
    "SERVICE_NAME_TEMPLATE",
    "Domain",
    "add_local_authorizer",
    "add_root_routes",
    "add_shared_middleware",
    "build_domain_app",
    "bundle_for",
    "check_signing_key",
    "configure_logging",
    "configure_tracing",
    "domain_entrypoint",
    "scope_for",
]

API_PREFIX = settings.API_STR

SERVICE_NAME_TEMPLATE = "standupless-{domain}"

OPENAPI_VERSION = "0.1.0"
"""Pinned so `create_app` publishes the version the OpenAPI snapshot records."""


@dataclass(frozen=True)
class Domain(composition.Domain):
    """The package's descriptor with this product's defaults and its table grants.

    Every row mounts under `API_PREFIX` and logs under `SERVICE_NAME_TEMPLATE`
    unless it says otherwise. `tables` and `read_tables` are derived here because
    the repository registry they read is this product's, not the package's.
    """

    router_prefix: str = API_PREFIX
    service_name_template: str = SERVICE_NAME_TEMPLATE

    @property
    def tables(self) -> Tuple[str, ...]:
        """The tables this domain writes, sorted. The Terraform `tables` grant.

        Read from the repository registry rather than listed again, so the two and
        the Terraform IAM policy cannot disagree.
        """
        from app.common.db.dynamo.registry import tables_for

        return tables_for(self.repositories)

    @property
    def read_tables(self) -> Tuple[str, ...]:
        """The tables this domain only reads, sorted. The `read_tables` grant.

        A table it also writes is excluded, because a write grant already covers
        reading and listing it twice would let the two grants disagree.
        """
        from app.common.db.dynamo.registry import tables_for

        return tuple(t for t in tables_for(self.read_repositories) if t not in self.tables)


def configure_logging(service: "str | None" = None) -> None:
    """The shared JSON log format on stderr, with the log context filter attached.

    Stderr keeps a command's stdout data clean of log lines. Calling it twice is harmless.
    """
    import sys

    from webbpulse.log_context import attach_log_context

    composition.configure_logging(settings, service=service or settings.PROJECT_NAME, stream=sys.stderr)
    attach_log_context(logging.getLogger())


def configure_tracing(domain: "composition.Domain") -> bool:
    """Wire OpenTelemetry for one domain, but only when an OTLP endpoint is set.

    The package's gate, bound to this product's settings so the purge stages and
    the entrypoints call it the same way.
    """
    return composition.configure_tracing(domain, settings)


def check_signing_key(domains: "Sequence[composition.Domain]") -> None:
    """Fail fast on a missing secret, once at startup, per the domains served.

    The package's `check_secrets` bound to this product's settings, kept as a name
    because the lifespan calls it too.
    """
    check_secrets(domains, settings)


CORS_ALLOW_HEADERS: Tuple[str, ...] = (
    *DEFAULT_CORS_ALLOW_HEADERS,
    "X-Requested-With",
)
"""The package default set, plus the header `terraform/apigateway.tf` also allows."""


def add_shared_middleware(app: FastAPI, domains: "Sequence[composition.Domain]" = ()) -> None:
    """Team reference resolution and rate limiting, inside the CORS and request id layers.

    The order is load-bearing: Starlette runs middleware outermost-first in the
    order added, so CORS wraps the request id middleware which wraps the rate
    limiter, and team key prefixes are resolved innermost, just before routing.
    """
    del domains

    from app.common.api.middleware import TeamReferenceMiddleware, rate_limit_middleware

    app.add_middleware(TeamReferenceMiddleware)
    app.middleware("http")(rate_limit_middleware)


def _build_identity_settings(current: Any) -> Any:
    """This product's identity settings, imported only once the local guards have passed.

    Importing the identity glue is what would put `app.domains.identity` into every
    other domain's image, so it happens here, inside the callable the package's
    `local_authorizer` calls last. `tests/entrypoints/test_entrypoint_isolation.py`
    holds that.
    """
    from app.domains.identity.package_glue import build_identity_settings

    return build_identity_settings(current)


def add_local_authorizer(app: FastAPI, domains: "Sequence[composition.Domain]" = ()) -> bool:
    """Stand in for the gateway's JWT authorizer, but only on a local stack.

    The package's `local_authorizer` bound to this product's settings and its
    lazily imported identity settings factory. Returns whether it was added.
    """
    del domains

    return local_authorizer(app, settings, build_identity_settings=_build_identity_settings)


def add_root_routes(app: FastAPI, domains: "Sequence[composition.Domain]" = ()) -> None:
    """`/`, `/health` and `/ready`.

    None of the three is published in the OpenAPI document, because the gateway
    declares no route key for them: they are reachable by direct Lambda invoke
    alone, which is how the deploy's smoke step probes `/health`.
    """
    del domains

    from app.common.db.dynamo.client import check_db_ready

    @app.get("/", include_in_schema=False)
    def read_root() -> Dict[str, str]:  # pyright: ignore[reportUnusedFunction]
        """Name, version and the two probe paths, for a bare hit on the root."""
        return {
            "name": "Standupless API",
            "version": OPENAPI_VERSION,
            "status": "running",
            "docs": "/docs",
            "health": "/health",
        }

    @app.get("/health", include_in_schema=False)
    def health_check() -> Dict[str, Any]:  # pyright: ignore[reportUnusedFunction]
        """Liveness: the process is up. Reads nothing, so it never fails on I/O."""
        return {"status": "healthy", "service": "Standupless API", "version": OPENAPI_VERSION}

    @app.get("/ready", response_model=None, include_in_schema=False)
    def readiness_check() -> "Dict[str, Any] | JSONResponse":  # pyright: ignore[reportUnusedFunction]
        """Return 200 when DynamoDB is reachable and 503 otherwise.

        Lets a load balancer or the frontend hold traffic back until the backend
        can reach its tables.
        """
        if check_db_ready():
            return {"status": "ready", "database": "up"}
        return JSONResponse(
            status_code=503,
            content={
                "success": False,
                "message": "Service starting; database not ready. Please retry.",
                "error_code": "SERVICE_UNAVAILABLE",
            },
            headers={"Retry-After": "2"},
        )


def bundle_for(domains: "Sequence[composition.Domain]") -> "Any":
    """The bundle carrying exactly the repositories these domains declare.

    Building the bundle constructs no repository, so an image's import graph
    stays proportional to the routes it serves. Repositories a domain only reads
    refuse writes, the way the function's `read_tables` grant does.
    """
    from app.common.api.dependencies.repositories import build_bundle

    scope = scope_for(list(domains))
    return build_bundle(scope.names, name=scope.name, read_only=scope.read_only)


def _bind_repositories(app: FastAPI, domains: "Sequence[composition.Domain]") -> None:
    """Bind the bundle these domains declare, narrowed by `app.state.repository_scope`."""
    from app.common.api.dependencies.repositories import bind_repositories

    bind_repositories(app, bundle_for(domains))


def _instrument(app: FastAPI, domains: "Sequence[composition.Domain]" = ()) -> None:
    """Instrument the finished application, after this product's middleware is on.

    Last rather than through `build_domain_app(instrument=True)`, so the server span
    wraps the rate limiter rather than sitting underneath it.
    """
    del domains

    from webbpulse.otel import instrument_fastapi

    instrument_fastapi(app)


def build_domain_app(
    domains: "composition.Domain | str | Sequence[composition.Domain | str]",
    *,
    title: "str | None" = None,
    include_root_routes: bool = True,
) -> FastAPI:
    """Build one application from one domain or many: Root B's whole job.

    The package's builder with this product's hooks: the shared middleware, the
    local authorizer and the repository bundle before any router, then the root
    routes and the instrumentation once every router is in.
    """
    from app.common.api.middleware.error_handler import error_handler_options
    from app.common.composition.domains import DOMAINS

    resolved = resolve_domains(domains, DOMAINS)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        """Verify that every secret the served domains name is resolvable."""
        check_signing_key(resolved)
        yield

    after_routers = [add_root_routes, _instrument] if include_root_routes else [_instrument]

    return composition.build_domain_app(
        resolved,
        registry=DOMAINS,
        settings=settings,
        title=title if title is not None else settings.PROJECT_NAME,
        service_name=resolved[0].service_name if len(resolved) == 1 else settings.PROJECT_NAME,
        configure=[add_shared_middleware, add_local_authorizer, _bind_repositories],
        after_routers=after_routers,
        version=OPENAPI_VERSION,
        cors_allow_origins=settings.allowed_origins_list,
        cors_allow_headers=CORS_ALLOW_HEADERS,
        include_health=False,
        openapi_url=f"{settings.API_STR}/openapi.json",
        debug=settings.DEBUG,
        lifespan=lifespan,
        **error_handler_options(),
    )


def domain_entrypoint(domain: "composition.Domain") -> "Tuple[Callable[[], FastAPI], Callable[[], None]]":
    """The `(build_app, main)` pair one entrypoint module binds.

    The package's `domain_entrypoint` with this product's builder, settings and
    stderr log format, so `main` configures logging, then tracing, then checks the
    domain's secrets, and serves the application with uvicorn.
    """
    return composition.domain_entrypoint(
        domain,
        build=lambda served: build_domain_app(served, title=served.title),
        settings=settings,
        configure_logging=configure_logging,
    )
