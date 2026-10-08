"""The issue import consumer's entrypoint, run as its own Lambda function.

Same image as the `integrations` routes, a different command, behind the import
queue and no gateway route. It writes issues, their activity and subscriptions,
new labels and the requester's notice, and reads the team and its members, so
it carries a bundle of its own rather than the integrations domain's.
"""

from typing import TYPE_CHECKING

from app.common.composition.wiring import (
    Domain,
    build_domain_app,
    configure_logging,
    configure_tracing,
)
from app.common.issue_import import IMPORT_READ_REPOSITORIES, IMPORT_REPOSITORIES

if TYPE_CHECKING:  # pragma: no cover
    from fastapi import APIRouter, FastAPI

DOMAIN = Domain(
    name="integrations-import-consumer",
    title="Standupless issue import consumer",
    load_routers=lambda: [],
    load_unprefixed_routers=lambda _settings: _routers(),
    repositories=IMPORT_REPOSITORIES,
    read_repositories=IMPORT_READ_REPOSITORIES,
)
"""A descriptor carrying the import's bundle and only this consumer's route."""


def _routers() -> "list[APIRouter]":
    """This consumer's router alone."""
    from app.domains.integrations.consumers.import_jobs import build_router

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
