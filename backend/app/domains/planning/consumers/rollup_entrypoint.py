"""The rollup consumer's entrypoint, run as its own Lambda function.

Same image as the `planning` routes, a different command. The function is behind a
stream event source mapping and no gateway route, so it serves the consumer route
and the root probes and nothing else: building the domain's routers here would give
a consumer an authorized read surface it has no reason to carry.
"""

from typing import TYPE_CHECKING

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import (
    Domain,
    build_domain_app,
    configure_logging,
    configure_tracing,
)

if TYPE_CHECKING:  # pragma: no cover
    from fastapi import APIRouter, FastAPI

SERVED = DOMAINS["planning"]

DOMAIN = Domain(
    name="planning-rollup-consumer",
    title="Standupless planning rollup consumer",
    load_routers=lambda: [],
    load_unprefixed_routers=lambda _settings: _routers(),
    repositories=SERVED.repositories,
    read_repositories=SERVED.read_repositories,
)
"""A descriptor carrying the `planning` bundle and only the consumer's route.

Not a registry entry: the registry is the set of domains with routers to compose,
and a consumer has none. It carries the same repositories because it runs in the
same image with the same IAM grant.
"""


def _routers() -> "list[APIRouter]":
    """The rollup consumer's router alone."""
    from app.domains.planning.consumers.rollup import build_router

    return [build_router()]


def build_app() -> "FastAPI":
    """The consumer route and the root probes, and nothing else."""
    return build_domain_app(DOMAIN, title=DOMAIN.title)


def main() -> None:
    """Configure logging and tracing process-wide, then serve the application."""
    from webbpulse.lambda_entry import run_uvicorn

    configure_logging(service=DOMAIN.service_name)
    configure_tracing(DOMAIN)
    run_uvicorn(build_app())


if __name__ == "__main__":
    main()
