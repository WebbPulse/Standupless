"""The create by email consumer's entrypoint, run as its own Lambda function.

Same image as the `integrations` routes, a different command, behind the intake
queue S3 feeds and no gateway route. It writes the issues mail files, their
activity, subscriptions and files, and the Message-ID claims, and reads the
address, the team and the admin it files as, so it carries a bundle of its own
rather than the integrations domain's.
"""

from typing import TYPE_CHECKING

from app.common.composition.wiring import (
    Domain,
    build_domain_app,
    configure_logging,
    configure_tracing,
)
from app.domains.integrations.consumers.email_intake import EMAIL_READ_REPOSITORIES, EMAIL_REPOSITORIES

if TYPE_CHECKING:  # pragma: no cover
    from fastapi import APIRouter, FastAPI

DOMAIN = Domain(
    name="integrations-email-consumer",
    title="Standupless create by email consumer",
    load_routers=lambda: [],
    load_unprefixed_routers=lambda _settings: _routers(),
    repositories=EMAIL_REPOSITORIES,
    read_repositories=EMAIL_READ_REPOSITORIES,
)
"""A descriptor carrying the intake's bundle and only this consumer's route."""


def _routers() -> "list[APIRouter]":
    """This consumer's router alone."""
    from app.domains.integrations.consumers.email_intake import build_router

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
