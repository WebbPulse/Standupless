"""The workspace export consumer's entrypoint, run as its own Lambda function.

Same image as the `workspaces` routes, a different command, behind the export
queue and no gateway route. It reads every content table and writes only the
inbox, so it carries a bundle of its own rather than the workspaces domain's.
"""

from typing import TYPE_CHECKING

from app.common.composition.wiring import (
    Domain,
    build_domain_app,
    configure_logging,
    configure_tracing,
)
from app.common.workspace_export import EXPORT_READ_REPOSITORIES, EXPORT_REPOSITORIES

if TYPE_CHECKING:  # pragma: no cover
    from fastapi import APIRouter, FastAPI

DOMAIN = Domain(
    name="workspaces-export-consumer",
    title="Standupless workspace export consumer",
    load_routers=lambda: [],
    load_unprefixed_routers=lambda _settings: _routers(),
    repositories=EXPORT_REPOSITORIES,
    read_repositories=EXPORT_READ_REPOSITORIES,
)
"""A descriptor carrying the export's bundle and only this consumer's route."""


def _routers() -> "list[APIRouter]":
    """This consumer's router alone."""
    from app.domains.workspaces.consumers.export import build_router

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
