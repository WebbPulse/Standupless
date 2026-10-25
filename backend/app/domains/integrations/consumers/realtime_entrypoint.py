"""The WebSocket API's function, run as its own Lambda function.

Same image as the `integrations` routes, a different command. API Gateway's
WebSocket integration invokes it for `$connect`, `$disconnect` and `heartbeat`,
and the Lambda Web Adapter posts each event to the pass-through path, so it serves
that route and the root probes and nothing else. Its grant is the connections
table to write and the memberships table to check a connecting member against.
"""

from typing import TYPE_CHECKING

from app.common.composition.consumers import CONSUMERS
from app.common.composition.wiring import (
    Domain,
    build_domain_app,
    configure_logging,
    configure_tracing,
)

if TYPE_CHECKING:  # pragma: no cover
    from fastapi import APIRouter, FastAPI

GRANT = CONSUMERS["integrations-realtime-consumer"]

DOMAIN = Domain(
    name="integrations-realtime-consumer",
    title="Standupless realtime connections",
    load_routers=lambda: [],
    load_unprefixed_routers=lambda _settings: _routers(),
    repositories=GRANT.repositories,
    read_repositories=GRANT.read_repositories,
)
"""A descriptor carrying this function's own grant and only the WebSocket route."""


def _routers() -> "list[APIRouter]":
    """The WebSocket event route alone."""
    from app.domains.integrations.realtime.websocket import build_router

    return [build_router(GRANT.bundle())]


def build_app() -> "FastAPI":
    """The WebSocket event route and the root probes, and nothing else."""
    return build_domain_app(DOMAIN, title=DOMAIN.title)


def main() -> None:
    """Configure logging and tracing process-wide, then serve the application."""
    from webbpulse.lambda_entry import run_uvicorn

    configure_logging(service=DOMAIN.service_name)
    configure_tracing(DOMAIN)
    run_uvicorn(build_app())


if __name__ == "__main__":
    main()
