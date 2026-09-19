"""The integrations domain's entrypoint, run as `python -m app.domains.integrations.entrypoint`.

Serves the workspace-scoped GitHub, webhook and transition routes, plus the two
routes GitHub itself calls under `/api/github`. It needs `SECRET_KEY` because the
install flow's `state` is a signed token, and the GitHub App credentials because
the callback mints an installation token to read the repository list.
"""

from typing import TYPE_CHECKING

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import (
    build_domain_app,
    check_signing_key,
    configure_logging,
    configure_tracing,
)

if TYPE_CHECKING:  # pragma: no cover
    from fastapi import FastAPI

DOMAIN = DOMAINS["integrations"]


def build_app() -> "FastAPI":
    """This domain's routers and the root routes, and nothing else."""
    return build_domain_app(DOMAIN, title=DOMAIN.title)


def main() -> None:
    """Configure logging and tracing process-wide, then serve the application."""
    from webbpulse.lambda_entry import run_uvicorn

    configure_logging(service=DOMAIN.service_name)
    configure_tracing(DOMAIN)
    check_signing_key([DOMAIN])
    run_uvicorn(build_app())


if __name__ == "__main__":
    main()
