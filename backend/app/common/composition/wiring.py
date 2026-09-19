"""What a domain is, and how one application is built from any subset of them.

Both roots build through `build_domain_app`, so they cannot drift. Composition
is `include_router` and never `mount`, which would empty the OpenAPI document.
"""

from __future__ import annotations

import logging
import warnings
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, AsyncIterator, Callable, Dict, Iterable, Sequence, Tuple

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from webbpulse.http import DEFAULT_CORS_ALLOW_HEADERS

from app.common.core.config import settings

if TYPE_CHECKING:  # pragma: no cover
    from fastapi import APIRouter

logger = logging.getLogger(__name__)

API_PREFIX = settings.API_STR

SERVICE_NAME_TEMPLATE = "standupless-{domain}"

OPENAPI_VERSION = "0.1.0"
"""Pinned so `create_app` publishes the version the OpenAPI snapshot records."""


@dataclass(frozen=True)
class Domain:
    """One deployable domain."""

    name: str
    title: str
    load_routers: Callable[[], "Sequence[Tuple[APIRouter, str, Tuple[str, ...]]]"]
    load_unprefixed_routers: "Callable[[Any], Sequence[APIRouter]] | None" = None
    """Routers the domain mounts at the root with no prefix and no tags, because
    the router itself declares its full paths. Called lazily, like `load_routers`,
    so the glue behind it belongs to this domain's import closure alone."""
    router_prefix: str = API_PREFIX
    router_tags: Tuple[str, ...] = ()
    requires_secrets: Tuple[str, ...] = ()
    repositories: Tuple[str, ...] = ()
    """Repositories this domain owns and writes. The Terraform `tables` grant."""
    read_repositories: Tuple[str, ...] = ()
    """Repositories this domain only reads, belonging to another domain.

    Held apart from `repositories` because the two become different IAM grants:
    `tables` is read and write, `read_tables` is read only. A domain reaching a
    table it does not own must never gain write on it just by needing a lookup.
    """
    extra: Dict[str, Any] = field(default_factory=dict)

    @property
    def service_name(self) -> str:
        """The service name this domain logs and traces under."""
        return SERVICE_NAME_TEMPLATE.format(domain=self.name)

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

    @property
    def all_repositories(self) -> Tuple[str, ...]:
        """Every repository the bundle carries, written and read alike."""
        names = list(self.repositories)
        for name in self.read_repositories:
            if name not in names:
                names.append(name)
        return tuple(names)


def configure_logging(service: "str | None" = None) -> None:
    """The application's log format, applied to the root and uvicorn loggers.

    A thin call into `app.common.core.logging.configure_app_logging`. Calling it
    twice is harmless.
    """
    from app.common.core.logging import configure_app_logging

    configure_app_logging(
        level=settings.log_level,
        service=service or settings.PROJECT_NAME,
        environment=settings.environment,
    )


OTLP_ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"


def configure_tracing(domain: "Domain") -> bool:
    """Wire OpenTelemetry for one domain, but only when an OTLP endpoint is set.

    The gate is deliberate: without it the package would default to the X-Ray
    endpoint and every process would retry a 403 in silence.
    """
    import os

    if not os.environ.get(OTLP_ENDPOINT_ENV, "").strip():
        logger.debug("Tracing not configured: %s is unset.", OTLP_ENDPOINT_ENV)
        return False

    from webbpulse.otel import configure_tracing as _configure_tracing
    from webbpulse.otel import resolve_sample_ratio

    return _configure_tracing(
        domain.service_name,
        environment=settings.environment,
        sample_ratio=resolve_sample_ratio(),
    )


def check_signing_key(domains: "Iterable[Domain]") -> None:
    """Fail fast on a missing secret, once at startup, per the domains served.

    A root serving no domain that names a secret never calls `require_secrets`,
    which is what lets a domain run with no Secrets Manager grant.
    """
    wanted = sorted({name for domain in domains for name in domain.requires_secrets})
    if not wanted:
        return
    if settings.is_production:
        settings.require_secrets(*wanted)
        return
    if "SECRET_KEY" in wanted and not settings.SECRET_KEY:
        warnings.warn(
            "SECRET_KEY is empty. Tokens this product signs itself will be insecure. "
            "Set the SECRET_KEY environment variable.",
            UserWarning,
        )


CORS_ALLOW_HEADERS: Tuple[str, ...] = (
    *DEFAULT_CORS_ALLOW_HEADERS,
    "X-Requested-With",
)
"""The package default set, plus the header `terraform/apigateway.tf` also allows."""


def add_shared_middleware(app: FastAPI) -> None:
    """Rate limiting, added inside the CORS and request id `create_app` installed.

    The order is load-bearing: Starlette runs middleware outermost-first in the
    order added, so CORS wraps the request id middleware which wraps the rate limiter.
    """
    from app.common.api.middleware import rate_limit_middleware

    app.middleware("http")(rate_limit_middleware)


def add_local_authorizer(app: FastAPI) -> bool:
    """Stand in for the gateway's JWT authorizer, but only on a local stack.

    Deployed, API Gateway verifies the access token and the Lambda Web Adapter hands
    the function its claims in `x-amzn-request-context`, which is what every authorized
    route reads. A local e2e stack has no gateway, so a valid token arrives carrying no
    claims and each of those routes answers 401. The package's middleware verifies the
    bearer token in process against the local signer's own key set and publishes the
    result in that same shape.

    Returns whether it was added. The application's own environment is checked before
    anything else is built, because the package settings validate their signing keys on
    construction and only the identity function carries any: every other deployed
    function would fail to start if those settings were built first.

    The identity glue is imported below those guards rather than at the top of this
    body, because importing it is what would put `app.domains.identity` into every
    other domain's image. `tests/entrypoints/test_entrypoint_isolation.py` holds that.
    """
    from webbpulse.identity import LOCAL_ENVIRONMENT, LocalAuthorizerMiddleware

    if settings.environment.strip().lower() != LOCAL_ENVIRONMENT:
        return False
    if not settings.IDENTITY_ISSUER:
        return False

    from app.domains.identity.package_glue import build_identity_settings

    identity_settings = build_identity_settings(settings)
    if identity_settings.environment.strip().lower() != LOCAL_ENVIRONMENT:
        return False

    app.add_middleware(LocalAuthorizerMiddleware, settings=identity_settings)
    return True


def add_root_routes(app: FastAPI) -> None:
    """`/`, `/health` and `/ready`.

    None of the three is published in the OpenAPI document, because the gateway
    declares no route key for them: they are reachable by direct Lambda invoke
    alone, which is how the deploy's smoke step probes `/health`.
    """
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


@dataclass(frozen=True)
class RepositoryScope:
    """The repositories an application may reach, and which of them it only reads.

    Recorded on `app.state` so `bind_repositories` can narrow any bundle, a test
    fixture included, to what the deployed function's IAM policy allows.
    """

    name: str
    names: Tuple[str, ...]
    read_only: Tuple[str, ...]


def scope_for(domains: "Sequence[Domain]") -> RepositoryScope:
    """The union of these domains' declarations.

    A repository one domain writes is writable for the whole application, which
    matches how the merged Root A process and a multi-domain function are granted.
    """
    names: "list[str]" = []
    writable: "set[str]" = set()
    for domain in domains:
        writable.update(domain.repositories)
        for repository in domain.all_repositories:
            if repository not in names:
                names.append(repository)
    label = "+".join(domain.name for domain in domains) or "none"
    read_only = tuple(name for name in names if name not in writable)
    return RepositoryScope(name=label, names=tuple(names), read_only=read_only)


def bundle_for(domains: "Sequence[Domain]") -> "Any":
    """The bundle carrying exactly the repositories these domains declare.

    Building the bundle constructs no repository, so an image's import graph
    stays proportional to the routes it serves. Repositories a domain only reads
    refuse writes, the way the function's `read_tables` grant does.
    """
    from app.common.api.dependencies.repositories import build_bundle

    scope = scope_for(domains)
    return build_bundle(scope.names, name=scope.name, read_only=scope.read_only)


def build_domain_app(
    domains: "Domain | str | Sequence[Domain | str]",
    *,
    title: "str | None" = None,
    include_root_routes: bool = True,
) -> FastAPI:
    """Build one application from one domain or many: Root B's whole job."""
    from app.common.api.dependencies.repositories import bind_repositories
    from app.common.composition.domains import DOMAINS

    if isinstance(domains, (Domain, str)):
        domains = [domains]
    resolved = [DOMAINS[d] if isinstance(d, str) else d for d in domains]

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        """Verify that every secret the served domains name is resolvable."""
        check_signing_key(resolved)
        yield

    from webbpulse.http import create_app

    from app.common.api.middleware.error_handler import error_handler_options

    app = create_app(
        title=title if title is not None else settings.PROJECT_NAME,
        version=OPENAPI_VERSION,
        service_name=resolved[0].service_name if len(resolved) == 1 else settings.PROJECT_NAME,
        cors_allow_origins=settings.allowed_origins_list,
        cors_allow_headers=CORS_ALLOW_HEADERS,
        include_health=False,
        instrument=False,
        openapi_url=f"{settings.API_STR}/openapi.json",
        debug=settings.DEBUG,
        lifespan=lifespan,
        **error_handler_options(),
        **{k: v for domain in resolved for k, v in domain.extra.items()},
    )

    add_shared_middleware(app)
    add_local_authorizer(app)

    app.state.repository_scope = scope_for(resolved)
    bind_repositories(app, bundle_for(resolved))

    for domain in resolved:
        for router, prefix, tags in domain.load_routers():
            app.include_router(
                router,
                prefix=f"{domain.router_prefix}{prefix}",
                tags=list(tags or domain.router_tags),
            )

    for domain in resolved:
        if domain.load_unprefixed_routers is None:
            continue
        for router in domain.load_unprefixed_routers(settings):
            app.include_router(router)

    if include_root_routes:
        add_root_routes(app)

    from webbpulse.otel import instrument_fastapi

    instrument_fastapi(app)

    return app
